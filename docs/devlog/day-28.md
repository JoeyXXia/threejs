# Day28 — 五车阶段演示与版本归档

日期：2026-11-23（Asia/Shanghai）。开工时本地和 GitHub `main` 同为 `e97cce182aa5ca405dd4f24b4e3786cecf87f509`。按每日计划、[Day27 日志](day-27.md)和[验收](../../reports/day-27-acceptance.md)核对：五车分配与避碰、单容量资源、封路与重规划、带货故障与恢复、电量准入和充电、进程退出后的续跑都已有实现和分项证据；本日只串联实景证据，不改产品功能。

## 三组可独立审查的改动

1. **测试端口兼容**：`scripts/day4-browser-environment.mjs`、`tests/api-test-port.cjs`、`tests/integration/*.test.cjs` 中的 HTTP 夹具和 `tests/transport/simulation.test.cjs`。本机 Windows 保留了原 API 端口所在区间；可改用其他回环端口，保留默认值、既有断言和临时数据库机制。
2. **可复现演示**：`scripts/browser-checks/day28-fleet-demo.js`、`scripts/browser-checks/README.md` 和 `reports/day-28-demo.webm`。仅通过真实授权 API 布置两单、读字幕和断言；应用使用原 R3F 场景。
3. **验收与归档**：本日志、`reports/day-28-acceptance.md`、`docs/releases/v0.4-fleet-simulation.md` 和根 `README.md`。用 Git 注释标签归档计划内版本；不创建额外发布对象，不触发部署。

## 可观察验收

1. 录屏可解码，能辨认原场景、五车和已提交 tick；五车中只有两车执行本例两单。
2. 封路修订增加，未来路径不再进入封锁格；逐 tick 查同格、占用他车起始格（含对向交换）、穿货架、非法移动和资源重复占用。
3. 取货后故障车保留格子、电量、货物与通道所有者，第二台确实报告 `RESOURCE_BUSY`；维修只续跑原 claim，不补写取放。
4. 故障车完成后仍占通道，移到充电点才释放；满电停车仍占充电位；两单落货后取放各两次，库存对账一致且预占未被发运扣除。
5. 类型、构建、单测与真实 PostgreSQL 集成复验通过；归档前检查差异并核对远端引用。

## 权威与最易失败的边界

PostgreSQL 的 `WarehouseRuntime`、`FleetClaim`、库存与 `WarehouseEvent` 是权威；runner 的占格/位姿更新、取放账本与事件在同一事务提交。Query 仍轮询确认态；Zustand 仅负责 UI 状态，R3F/Drei 插值不驱动取放。字幕和画布分别采样，不能用两者的帧差判断事务先后。最容易误判的是完成态仍占格（不保证其他车继续）、故障时载货与许可不能被清除、充满电不等于腾出充电位。验收以持久事件和 API 快照裁定。

复验命令与实测见 [Day28 验收报告](../../reports/day-28-acceptance.md)。未改数据库迁移或产品运行时；本地 PDF、旧录像的已有删除、`output/` 和 `tmp/` 均不纳入本日提交。

构建、128 项单元、156 项集成通过。五车录像 44.88 秒，实查 105 个持久 tick、连续事件水位 123。两单完成仓内搬运、未发运，库存仍为 62 件、预占 2 件，WMS 对账一致。
