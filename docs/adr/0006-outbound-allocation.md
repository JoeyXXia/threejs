# ADR 0006：单批次出库、原子预占与 FEFO 边界

日期：2026-11-06。状态：采用。基线 `35509cd`，仅实现 Day 9，不推进 Day 10 的运输或发运。

## 最小模型与来源范围

`OutboundOrder` 一单一个 SKU、一个指定批次、正整数件数，状态 `CREATED → ALLOCATED`。创建单据不占库存；另行确认后全量预占，可以从同批次多个储位分配。`Allocation` 记录 orderId、balanceId、locationId、SKU、批次、质量、数量和创建时间，通过单据追溯操作者与原因。

首版来源仅限当前发布布局中的 STORAGE、RELEASED、未过期余额。QC 即使已经 RELEASED，仍不作为本日出库来源；因此“储存区可分配量”不同于库存接口的“全仓可用量”，页面明确说明。HOLD/过期、其他区域、未在当前布局放置的库存均不参与推荐或提交。当前没有盘点冻结模型，不加占位框架，也不声称已经验证冻结规则；Day 11 引入冻结后必须扩展同一来源判定。

没有自动跨批、部分成功、单据修改、取消、自动释放、运输任务或最终发运。预占仅改变 reserved，不改变 onHand、物理货位或 InventoryMovement。

## 推荐与提交

GET `/spaces/:spaceId/warehouses/:warehouseId/outbound-orders` 在 RepeatableRead 中返回权限、SKU、按 SKU 分组的可分配批次及最近 100 单。每个批次合计来源余额的 `onHand-reserved`；零可用不返回。FEFO 按 expiresAt 升序，null 排后，同日期按 batchId 固定排序。用户可选择批次，推荐不是强制 FEFO，也不是库存承诺。

POST 同前缀创建单据，接收 key、skuId、batchId、quantity、reason；允许记录暂时无库存的单据，实际分配仍须成功校验。POST `:orderId/allocate` 只接收 key/reason，不接受客户端 available、分配明细或 actor。批次不足返回 409，明确提示减少数量或拆单选择其他批次，不回退到另一个批次。

## 事务与锁顺序

沿用 Day 8 的小型命令模式，不重构既有入库流程，不新增工作流框架：

1. 事务内锁访问记录并读取当前权限，admin/operator 可写；返回历史幂等响应前也重新授权。
2. 锁 Warehouse，再锁 OutboundOrder；同仓业务串行提交，减少小规模样例的并发证明成本。
3. Batch 行加共享锁，重新读取到期时间；按当前布局重新查询符合来源规则的余额，先验证该批次总量足够。
4. Location ID 升序锁货位，余额按稳定 locationId/id 顺序加行锁。逐行执行带版本与数量条件的 UPDATE：`reserved + q <= onHand`、quality=RELEASED、version 匹配；增加 reserved 与 version，写 Allocation。
5. 最后再次检查剩余数量和批次到期；更新单据状态、操作者、原因、时间，写审计和成功幂等结果后提交。任何异常回滚全部行及记录。

锁顺序与既有容量触发器 Warehouse→Location 兼容。受控 API 都走仓库锁，版本条件还会拒绝读后被直接改写的余额。批次共享锁防止分配期间日期被并发修改；到期判断使用服务端时间，重放历史成功命令只返回原事实，不再次占量。粗粒度锁不代表高吞吐或无死锁的通用保证，未进行吞吐实验。

## 唯一性、幂等和审计

沿用 `(spaceId, warehouseId, actorId, operation, key)` 幂等范围，固定字段顺序与规范化文本计算 requestHash。相同 key/参数返回原成功响应，不同参数 409；失败不保留成功记录，同 key 可重试。操作名分别为 OUTBOUND_CREATE/OUTBOUND_ALLOCATE，预占 hash 包含 orderId。创建与预占各自记录 AuditLog，操作者来自会话。

同一已存在单据的不同 key/操作者也受行锁和状态约束，不能重复预占；`(orderId,balanceId)` 唯一防止重复分配行。复合 FK 强制 Allocation 与订单、余额拥有相同空间/仓库/SKU/批次/质量/货位，CHECK 只允许正数 RELEASED 分配；数据库阶段字段 CHECK 与 API 单向推进互补。未暴露直接修改或删除分配记录的产品 API。

同一个业务需求若改用新 key 再创建一个新单据，属于另一条创建命令，当前没有外部订单号防重。前端未确认请求 key 只在当前页面挂载期间保存；不承诺跨刷新/跨设备自动恢复创建 key，未知结果应先刷新核对。HTTP 超时/abort 不表示服务端回滚，不用按钮禁用代替业务幂等。

## 状态权威与同步

DB 保存单据、分配、余额、审计和幂等结果。Query key 含 user/space/warehouse；单独的 outbound 查询同时包含推荐与列表，成功后精确失效该 key 和 warehouse-snapshot。页面重新读取已提交结果，不乐观改库存；Zustand 只保存原有场景 UI，R3F/2D 继续消费同一快照。切仓/退出中止旧 fetch，迟到响应不重新建立旧缓存；401 清身份和缓存。

不引入 Socket、Redis 或 BullMQ。推荐与库存接口是不同读取快照，不能声称跨接口原子一致；推荐显示 asOf，提交时检查决定是否成功。外部变化通过手动刷新获取。

## 两种对账必须分开

原 `reconcile(tx)` 继续复算 onHand；预占不是库存移动，不写伪造流水。新增 `reconcileReservations(tx)` 同时检查：

- 每行 InventoryBalance.reserved 等于 ALLOCATED 单据对应分配记录的数量合计。
- ALLOCATED 单据的 Allocation 总量等于订单 quantity；CREATED 单据不应有分配记录。

对账函数只检测，不修复。隔离测试删除分配记录或直接改 reserved，能分别发现余额/订单差异，再回滚夹具。集成入口在真实 DB 重启后对两个测试库分别执行两种对账。现有 `pnpm reconcile` 命令仍只执行 onHand 对账，新增预占函数由测试/集成入口调用，未增加假称覆盖全部业务的 CLI。

未来运输、取消或释放预占时，必须扩展分配生命周期与对账，不能删除当前 ALLOCATED 事实却不处理 reserved。批次在预占后过期也不会自动释放；库存读取会排除过期可用量，但预占事实保留，等待后续明确流程。

## 验证与范围

新增一条追加迁移，不改旧迁移、不 reset 开发库。测试复用 Day 8 临时写入数据库，每个出库测试独立建仓与 seed，避免抢占或污染旧回归夹具。真实并发、部分分配写入失败、审计回滚、权限、FEFO、过期窗口、API 重启和对账反例均有覆盖。

实际结果与截图见 [Day 9 验收](../../reports/day-09-acceptance.md)。没有生产升级、跨浏览器矩阵或性能成绩；历史 PDF 保留不变。
