# Day 20 验收报告：上架与人工发运

日期：2026-11-17（Asia/Shanghai）；基线：`0d991e944fd0b891922e2b481bc4a33aa61d1822`。本轮功能、静态检查、自动测试及浏览器验收通过。本报告只记录实际运行结果；Git 交付以最终回复中本地/远端提交核对为准，不以文件存在视为完成。

## 范围与改动

- 在既有持久单车 runner 增加 PUTAWAY：全量 PASSED 入库单从 QC 经虚拟 TRANSIT 搬到单一 STORAGE；目标容量/批次预留与来源预占一起建立，落货释放预占成为可分配库存。
- 出库新增 `POST /spaces/:spaceId/warehouses/:warehouseId/outbound-orders/:orderId/dispatch` 和显式人工确认。READY/在途/部分到齐拒绝；到齐但不确认不扣全仓现存。写请求必须带 key/reason，遵守权限与仓库隔离。
- task/phase 的唯一流水键、检查点、载荷、审计、事件同事务；复用 owner lease、epoch、tick/version fencing。新增上架预占/在途/容量对账和目标盘点活动保护。
- 涉及数据库模型/迁移/对账，API transport/putaway、simulation、outbound、count，contracts，RobotPanel/OutboundView，升级/集成/浏览器脚本和文档；按领域上架、人工发运、验收证据三组审查。设计见 [ADR 0012](../docs/adr/0012-putaway-and-operator-dispatch.md)，逐项条件见 [devlog](../docs/devlog/day-20.md)。

## 实际环境与命令

Node v22.14.0；PostgreSQL 18.6 x86_64-windows（msvc-19.44.35228）；Prisma 6.19.3。使用全新隔离集群，不读取/清空开发库或根 `.env`。原始 JSON/TAP 忽略入 Git，以下摘要保留本轮证据。

| 命令/检查 | 实际结果 |
| --- | --- |
| `pnpm db:generate` | 通过，生成客户端；未 reset 数据库 |
| `pnpm check` | lint / 全仓 typecheck / build 通过；保留既有 >500kB chunk 提示 |
| `pnpm test:unit` | 85 通过：simulation 19 + web 66；无跳过 |
| `pnpm test:integration` | 127 通过：Node 领域/runner 28 + Jest HTTP 99；无失败或跳过 |
| 浏览器完整链路 | fresh QA 全流程通过，已提交发运丢响应后 UI 同键重试通过，最终对账一致 |
| Git main 交付检查 | 验收通过后显式暂存三组相关文件，正常推送并核对远端 SHA；具体提交见本轮最终回复 |

## 事务、权限和故障证据

真实数据库直接测试覆盖：整单上架/出库/发运链路；QC/TRANSIT/STORAGE 分阶段对账；重复 start/take/drop；整单未到齐拒绝发运；viewer 403、跨空间 404、伪造字段 400；请求键改参数 409；不同 key 再次确认不重复 DISPATCH；冻结或过期拒绝且不遗留来源预占。

两连接争抢 40 件容量储位，各提交 30 件同批上架，只能一个成功。空位已预留后，不同批次不能进入；数据库直接写入不同批次或偷用预留容量被触发器拒绝，非法 phase 跳跃和删除任务也被拒绝。盘点不能冻结有活动上架预留的空储位。

对 take、drop 分别在 SIM_TICK 事件写入注入失败，断言余额、phase、流水数、审计数、检查点及水位与事务前完全一致。恢复写入后成功一次；再提交原 expectedTick 被 409 拒绝且没有额外副作用。旧出库 runner 的双客户端租约接管、状态版本冲突、过期事务回滚、事件顺序/分页和 API 真重启回归继续保留。

上架取货后真杀 API、重启后续跑的最终轮证据（`reports/day20-restart.json`）：

```json
{
  "capturedAt": "2026-11-16T23:54:37.557Z",
  "savedTick": 15,
  "oldEpoch": 1,
  "resumedTick": 16,
  "newEpoch": 2,
  "completedTick": 34,
  "watermark": 43,
  "processRestarted": true
}
```

重启后同 task 完成，两个 putaway 取/放流水不重复；最终库存和预占对账一致。以上是具体故障夹具结果，不是对所有崩溃点的形式化证明或可靠性 SLA。

## 升级与数据库重启

升级夹具从 Day 18 schema/seed 经 Day 19 再到最新 Day 20 迁移，比较已有用户/密码哈希、仓库、库存、批次和权限等业务行不变。最新升级证据中 2 仓、22 余额、22 流水保留，新 PutawayTask=0。旧 format=1 检查点的默认 OUTBOUND 身份及新 PUTAWAY 互斥身份由契约单测验证。

2026-11-16T23:56:05.601Z（上海 11 月 17 日 07:56）最终轮完成真实数据库重启：warehouse_twin_test、warehouse_twin_inbound_test、warehouse_twin_upgrade_test 三库均 consistent=true，物理/预占/事件/检查点差异全部为 0；写测试库持久检查点 16 个。原始证据：`integration-environment.json`、`integration-transport.tap`、`integration-jest.json`、`integration-inventory.json`、`day20-upgrade.json`、`day20-restart.json`。

## 浏览器、限制与提交

浏览器回调：`scripts/browser-checks/day20-putaway-dispatch.js`，使用独立 QA 数据与测试账户。前两次脚本尝试分别暴露验收代码将嵌套 `batch.id` 误写为 `batchId`、以及严格 `getByLabel` 无法定位带 option 文本的 select；余额读取和页面快照确认上架已完成且 66 件现存、0 预占。已修正字段与 combobox 角色定位，关闭对应环境后从全新 QA 库复验；失败尝试不计为端到端通过。最终于 2026-11-17T00:04:19.419Z（上海 08:04）在新隔离库完整通过。浏览器真实 UI 完成创建入库、收货、质检、单车上架、创建出库/全量预占、出库搬运和人工发运。首次发运由真实后端提交后故意丢弃响应，再以相同请求键通过 UI 重试，订单变已发运，余额只扣一次。

仅单车软件模拟、全量单储位上架/整单发运；无部分入库/拆分上架/任务取消、异常恢复操作台、多车、Socket、真实机器人、自动发布或部署。批次过期在创建上架时检查，无在途过期自动回库策略。ERROR 保留账实现场停止推进。无本轮性能/帧率/生产并发测量，不填写推算结果。PDF、临时目录和用户原有录像删除不纳入提交。

## 最终浏览器证据

批次 `DAY20-1794873839305`；上架 task `4b9b6fa4-3b43-4575-bf04-222049392900`；出库搬运 task `4f359ce3-1d9c-4264-b5a2-65ae0c79f988`；订单 `0f8028e3-71b0-4d2e-baae-948fc4203a3e`。

| 阶段 | 现存 | 预占 | 可用 | HOLD |
| --- | ---: | ---: | ---: | ---: |
| 初始 | 62 | 0 | 55 | 7 |
| 收货/质检后 | 66 | 0 | 59 | 7 |
| 上架完成 | 66 | 0 | 59 | 7 |
| 搬运到暂存 | 66 | 4 | 55 | 7 |
| 人工发运后 | 62 | 0 | 55 | 7 |

提前发运返回 409；丢响应两次请求使用相同 key；最终 reconciled=true。已打开检查下列原图，中文、完成态、66 件/4 件暂存预占和已发运订单可见，3D Canvas 已就绪，不把空白懒加载图计为验收。

- [搬运完成但未发运](day-20-staged.png)
- [人工发运及丢响应重试完成](day-20-dispatched.png)

匿名 /auth/me 的 401、提前发运 409、故意 abort 的网络错误是预期负向场景；保留既有 THREE.Clock 废弃提示和构建 chunk 提示，未宣称控制台零错误/零警告。浏览器会话及 QA 数据库/API/Vite 由本轮关闭，不安装或发布系统服务。

审查提交：`bbd713e`（整单上架/持久 runner）与 `84beae1`（人工发运）；本文件、验证脚本及截图随第三组验收证据提交。远端提交状态以实际 main 核对为准。
