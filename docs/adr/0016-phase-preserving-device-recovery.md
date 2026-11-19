# ADR0016：步边界故障、原任务维修与取货前取消

日期：2026-11-19。Day25 实现；承接 [ADR0013](0013-persistent-fleet-coordination.md) 至 [ADR0015](0015-controlled-closures-and-bounded-replanning.md)。仅软件演示，不是真实机器人控制。

## 状态权威与边界

PostgreSQL `WarehouseRuntime.fleet` 权威保存可选 `deviceFault={reason,sinceTick}`，旧 JSON 无字段保持兼容。故障不替换 phase：APPROACH/LOADING/TRANSPORT/UNLOADING 和 phaseTicks、路线游标、电量、claim、TRANSIT、目标容量、物理资源 owner 全保留。响应的 `recoveryStatus` 由故障和持久 claim.loaded 推导：空载 PAUSED，载货 NEEDS_RECOVERY；不是第二份库存或可由客户端写入的状态。

纯函数 `controlRobot` 仅产生状态提案，无库存副作用。故障暂停期间统一 tick/等待计数可以继续，该车不移动、不耗电、不产生 take/drop；其他车仍把故障格视作占用。维修仅清除此处注入的设备故障，保留导航暂停。解封/重规划也不能清除设备故障。未知暂停、账本 ERROR、权限撤销/布局变化和电量耗尽不通过维修按钮盲目恢复。

## 事务与同步

`POST .../fleet/control` 严格接受 `{robotId,action,expectedTaskId,reason}`，action 为 FAULT/REPAIR/CANCEL。expectedTaskId 指向当前 claim UUID（取消后的空闲故障维修为 null），防止迟到命令操作下一项任务。不是让客户端预报取放阶段；服务端在锁定的**最新已提交 tick 边界**检查真实阶段，若刚发生取货则取消必然拒绝。

同一事务：写 ACL SHARE → Warehouse/runtime 锁 → 解码合法检查点 → 当前归属/领域阶段/布局检查 → 纯控制提案 → 可选领域取消与 claim 关闭 → 检查点 → AuditLog 与 FLEET_FAULT/REPAIR/CANCEL 事件。事件失败则全部回滚。故障命令不增加逻辑 tick，不覆盖 `from→to` 已确认段，只停止后续步；stateVersion 经原事件机制增长，使预先 prepare 的旧提案无法提交。原 runner owner/epoch/lease/tick/version fence 与 take/drop 原子批次继续使用。

维修要求原 claim 操作者仍有写权限；runner 每批再次验证原授权。没有转移 claim.actorId、自动跨车接驳、错误任务改成完成或直接清零在途货物。重复/过期控制返回409，客户端重读后决定下一操作；不因网络重试重复释放预占或重复过账。

React/R3F/Drei 展示已确认位置、故障告警与按钮，故障时隐藏可执行路线；Query 继续250ms轮询，既有 phase/claim 变化使库存/订单缓存失效。Zustand仍只管UI；viewer原生禁用且API403，跨空间404。

## 取消的精确业务语义

仅 APPROACH/LOADING、领域 READY、claim未载货允许取消。领域任务新增终态 **CANCELLED**，保留 Allocation/Receipt、运输、TRANSIT空货位、唯一 claim 和 assignment 历史；取消不生成物理搬运流水。原来源 reserved 减少、目标容量释放，claim.active=false；机器人原地变空闲，但已有设备故障与所在物理资源许可仍保留，须明确维修后才能接新任务。

数据库枚举与触发器迁移分开，避免在同一迁移事务使用未提交的新枚举值。原端点/容量/不可删除/身份不可变/单活动任务约束均保留；只允许 READY→CANCELLED，禁止 IN_TRANSIT/STAGED→CANCELLED，inactive claim 对应 STAGED或CANCELLED且不可复活。旧迁移文件不改写。

这是**运输任务取消，不是出库整单取消/重新分配流程**。原出库单保留历史 ALLOCATED 与 allocation 记录；对账扣除 CANCELLED 运输的活动来源预占，不能把它发运，不能重新领取同一已取消来源。继续业务需创建新的单据；取消上架的 receipt 同样保留不可重领的任务历史。本日不做整单重开、部分再分配、跨车恢复或自动补偿。载货取消直接409，保留原货物，维修后继续原运输；已完成后故障/取消不会重开过账。

## 验证

纯测试逐阶段故障/维修与取放一次、取消留占格/历史、故障与导航暂停叠加。真实 PostgreSQL 覆盖四阶段、取货前两阶段取消、上架取消/载货恢复、旧提案拒绝、事件失败回滚、双连接接管与故障检查点重启校验。浏览器覆盖取消释放、载货故障保留实际通道许可、刷新、维修完成、连续事件与viewer拒绝。精确命令与实测见 [Day25验收](../../reports/day-25-acceptance.md)。不声称性能、连续物理安全、任意死锁可恢复或 Day26 充电。
