# ADR 0012：整单上架复用持久 runner，发运保留人工确认

- 日期：2026-11-17（Asia/Shanghai）
- 范围：Day 20；不包含 Day 21 发布或演示录像
- 状态：采纳

## 背景与最小决策

Day 19 已让出库分配的取货/卸货与持久 tick、机器人载货标志、事件同事务提交。Day 20 不重写这一核心，仅补质检放行后的 QC → TRANSIT → STORAGE 和人工发运入口。

使用独立 `PutawayTask`，而不是把已有 `TransportTask.allocationId` 改为可空。前者保留 Day 10 出库分配的唯一性、FK、触发器与历史记录语义。两种任务共用 `TransportPhase`（READY / IN_TRANSIT / STAGED）、纯 `RobotTask` 和单仓单车 runner；上架的 STAGED 表示已放到储位，不表示出库暂存。

一次上架严格对应一个 PASSED 入库单的全部数量、单一储位，不拆分、不自动选位、无取消/回库。`inboundOrderId` 唯一，重复整单请求不会生成第二个任务。来源必须当前 QC 的 RELEASED 可用余额且创建时未过期；目标为当前 STORAGE，不能冻结、超容量或混 SKU/批次。

## 状态权威与事务

PostgreSQL 是余额、预占、领域 phase、载货标志、tick、owner/epoch 与事件水位的权威。Query 只缓存；Zustand 仅 UI；R3F/Drei 只呈现确认轨迹。仍使用 250ms 轮询，不新增 Socket、调度服务、消息队列或真实设备接口。

1. `start` 在事务外算路径，在事务内取得 ACL SHARE → Warehouse → WarehouseRuntime，复查布局/version/lease。上架创建同时预占 QC 数量、保留目标容量、创建虚拟 TRANSIT 与检查点并写审计/事件。
2. `take` 同事务扣 QC onHand/reserved，phase 变 IN_TRANSIT，增加 TRANSIT onHand/reserved，写 `putaway:{taskId}:take` 流水，更新载荷与确认 tick/事件。
3. `drop` 同事务清 TRANSIT，phase 变 STAGED（消耗容量预留），增加 STORAGE onHand **但不预占**，写唯一 drop 流水，清载荷并保存完成检查点/事件。上架库存由此可用于普通出库分配。
4. 租约、epoch、expectedTick/version 与提交尾部租约检查完全复用 Day 19。事务前失败全部回滚；已提交但响应丢失后，旧提案重放被 fencing 拒绝，不能重复过账。

`staging_reserved()` 保留 SQL 旧名称，合计出库暂存与上架目标的未完成容量预留。已有余额容量和布局切换守卫因此同步生效；新增数据库守卫保护上架状态机、目标冻结/容量/批次及在途归属。盘点服务拒绝仍有上架预留的空储位。对账增加 QC/TRANSIT 上架预占、在途期望数量与 STORAGE 预留容量，按仓库隔离读取。

## 人工发运

`POST outbound-orders/:orderId/dispatch` 接收 `key`、`reason`，沿用出库幂等命令封装与 ACL。只有 ALLOCATED 且所有分配全部 STAGED、数量合计等于整单数量才允许扣暂存余额并写 DISPATCH 流水，订单变 DISPATCHED。搬运到暂存区绝不自动扣全仓现存。

同 key/同参数重试返回持久响应；同 key/异参数 409。不同 key 再确认已发运单也不重复扣货，可能追加一次请求受理事件/幂等记录；实际 `OUTBOUND_DISPATCHED` 审计/域事件及 DISPATCH 流水只有首次状态变化产生。页面不乐观改库存，成功后精确重读；网络结果不确定时原参数重试复用请求键，刷新后应先核对订单。

## 兼容与限制

旧 format=1 检查点缺省 `kind=OUTBOUND`、`inboundOrderId=null`；新增 PUTAWAY 要求 receipt 非空且 allocation 为空。未知格式或互斥身份错误停止读取/推进。

不实现多车避碰、部分单据、任务取消/异常人工恢复、自动充电、真实机器人控制。电量/路径错误和权限撤销沿用停止策略；跨刷新未知结果先读取服务端状态。测试是合成数据本机隔离 PostgreSQL 与 Chromium 验收，不代表生产可靠性、吞吐或性能承诺。
