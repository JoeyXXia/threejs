# ADR0015：受控封锁与有界重规划

日期：2026-11-18。状态：Day24 实现。承接 [ADR0013](0013-persistent-fleet-coordination.md)、[ADR0014](0014-physical-resource-permits.md)。

## 状态权威

PostgreSQL `WarehouseRuntime.fleet.state.navigation` 保存 `{revision,closed}`；不是前端障碍，也不改静态 `LayoutVersion.version`。旧 JSON 缺字段解释为 revision=0、closed=[]。路径、暂停原因与 revision 一起持久化；claim、库存、TRANSIT 和资源 owner 继续由原领域服务与检查点约束。

纯核心 `changeNavigation` 只计算新检查点，不移动、耗电或取放。静态货架和动态 closed 都作为 A* 障碍；有任务的新分配也必须避开 closed。历史已走过的路段不要求删除；执行前只验证当前及未来路段，暂停时允许保留失效旧路径作为诊断，但不得执行或在场景显示为可走路线。

## 命令和事务边界

`POST /spaces/:spaceId/warehouses/:warehouseId/fleet/navigation`，严格字段 `cells,closed,expectedRevision,reason`。仅 admin/operator；空间/仓库授权、格式校验在计算前，写事务内再次授权。

1. 读检查点，拒绝旧 revision、货架/越界格、当前占格与持久 `from`（本步已确认段的另一端）。每步最多一条相邻边，所以保护两端覆盖整个批准段。
2. **事务外**对受影响 active 车辆计算路径。最多 5 车×2 次搜索，每次最多 2000 扩展节点、10ms 墙钟预算。预算用于有界搜索，不是整条 HTTP 100ms 延迟承诺。
3. 事务按 ACL SHARE → Warehouse → runtime 加锁；锁后重读当前 activeLayoutId，核对 tick/stateVersion/布局仍与计算基线相同，否则 409，不把旧结果强行套入新位置。
4. 保存封锁、路径和告警，追加带操作者/原因/输入/新地图/逐车问题的 `FLEET_NAVIGATION_CHANGED`。事件追加同时增加 stateVersion；不改 tick、claim 或库存。重复设置相同集合在当前 revision 下是 no-op，无新事件；旧 revision 即使意图相同也拒绝。
5. runner 原 owner/epoch/lease/tick/version fence 不变，另核对 proposal 地图 revision。旧 tick/旧地图计算均不能覆盖新封锁。批次取放仍与位置、资源许可、claim、库存流水、FLEET_TICK 同事务。

现有 `from→to` 确认段保留，不制造瞬移；Query 250ms 取持久快照，Zustand 仅 UI 状态，R3F/Drei 只插值确认段并画红色封锁格。无 Socket、新服务或表迁移。

## 失败与重试

APPROACH 同时检查去取货点和后续载货路线，LOADING 检查后续载货路线，TRANSPORT 从当前位置重算到原目标；不更换任务、目标或 claim。UNLOADING 原地完成不需要穿越新封锁。

无路 `NO_PATH` 或耗尽 `BUDGET`：持久 `navigationIssue={revision,reason}`，原 phase/phaseTicks、位置、电量、在途货物、预占/容量、资源占格全部保留；显示 `ROUTE_BLOCKED` 告警。统一逻辑 tick/等待计数可继续，机器人不移动、不取放。**不每 tick 自动重算**；只有新的实际地图变化才重试。恢复路径仅清理本功能造成的暂停，不擅自清除其他来源暂停。错误状态不被地图操作当成修复。

资源仲裁与物理占格仍执行；重算几何路线不等于预订整条路径。完成车/故障车不透明，局部绕行不保证所有任务完成或全局无死锁。设备故障恢复属于 Day25，不在此实现。

## 证据与限制

纯函数覆盖绕行、完整切断、预算、装货中断、快速变图和旧路拒绝；真实 PG 覆盖授权/批准段、事件失败原子回滚、载货暂停、双客户端接管、旧 proposal 拒绝、原 claim 继续且取放仅一次；集成脚本实际重启 PG 后验证导航与资源合法性。只读对账附加封锁占格/暂停版本检查，不冒充完整路径求解器。浏览器验证 UI、刷新、事件和最终台账。

命令、精确结果及限制见 [Day24 验收](../../reports/day-24-acceptance.md)。仅有限合成布局；不声称实时硬期限、性能指标、真实机器人控制或独立新增 fleet 进程 SIGKILL 证据。
