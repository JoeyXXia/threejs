# ADR 0011：持久检查点、fencing 与提交安全事件水位

设计日期：2026-11-13（Asia/Shanghai）；2026-11-15 续做报告与提交收尾。状态：Day 19 采用。替代 ADR 0010 中仅内存运行的临时边界，不改变单车和模拟设备范围。

## 1. 权威与数据模型

`WarehouseRuntime` 每仓一行，保存 ownerId、epoch、leaseUntil、tick、version、seq 与带 format=1 的 JSON 检查点。检查点包含任务阶段、阶段已等待 tick、地图/路径、位置、方向、电量、原始发起者和已确认载货状态。检查点格式、逻辑时钟、路径和载货关系在读取时校验，未知格式失败关闭，不初始化成新任务。

`WarehouseEvent` 按 `(warehouseId, seq)` 唯一，包含 tick、kind、payload 和数据库时间。外键约束空间归属，触发器禁止更新/删除。现有仓库迁移时回填空 runtime，seq=0；新仓库在首次写事务内惰性创建。不会伪造 Day 19 之前的业务事件，已有库存仍由余额与库存流水表示。

PostgreSQL 现在同时是库存、任务、运行检查点与事件水位的权威。Nest 不再以 Map 保存任务真相，仅保留实例 UUID、定时器和防重入 Promise。Query 缓存只读快照；Zustand 仍仅 UI；R3F 继续只在已确认段插值。

## 2. 统一锁顺序与 WMS 写入口

顺序为：仓库访问关系 `FOR SHARE`（需要授权的写入）→ Warehouse 行 → WarehouseRuntime 行 → 现有单据/货位/余额锁。保留 Warehouse 锁以兼容现有布局与容量规则，runtime 锁是新增的统一状态提交边界。

`warehouse-state.ts` 的 `lockWarehouseState` 显式选择 spaceId/warehouseId，不展开带 actorId 的业务 scope 到数据库字段。入库、出库、盘点的 command 包装器，以及运输和仓库资料写入均接入该边界。授权在事务内复查，返回持久幂等结果前也检查权限。

`appendWarehouseEvent` 在同一事务里递增 runtime.seq/version，再追加事件。没有使用 PostgreSQL sequence：回滚时计数和事件一起回滚，第二个写者只有拿到行锁后才分配序号，因此同仓已提交 seq 按提交次序可见。成功的同 key 幂等重放不追加事件。不同仓库的 seq 独立，不是全系统总序。

这里覆盖应用业务写入口，不把离线 seed、迁移、测试夹具直接 SQL 或数据库管理员操作称为已纳入事件协议。所有未来在线仓库写入口也必须遵守此边界。

## 3. 认领与 fencing

每个 API 实例使用不可由 HTTP 指定的随机 ownerId。内部 prepare 在 runtime 锁下读取数据库 `clock_timestamp()`：其他 owner 的 lease 仍有效则不认领；到期接管递增 epoch，即使相同 owner 在过期后重新认领也进入新 epoch。默认 lease 为 5000ms，是演示选择而非可用性承诺。

prepare 返回 owner/epoch、expectedTick、expectedVersion 和纯计算提案。路径计算在启动写事务外完成，tick 的纯阶段计算也在提交事务外完成。提交时重新取得统一锁，检查 owner、epoch、lease、tick 和状态版本，并核对当前布局、权限及运输账本阶段。过期计算直接丢弃，不覆盖新状态，也不把合法接管写成业务 ERROR。

事务尾部再次检查原 lease 是否已过期，过期则整笔回滚，不能凭曾经拿到行锁就无限续写。通过后使用数据库时间续租。粗粒度锁可能增加等待；大负载和长事务下的可用性尚未压测。

模块仍只有一套 250ms 驱动，不按墙钟补跑历史 tick。驱动从数据库发现活动检查点，多个实例可以尝试认领，但提交权由数据库 fencing 决定。优雅退出等待本实例进行中的推进后释放 lease；被强制终止时，新实例等待旧 lease 到期再接管，不凭现实经过时间跳过任务。

## 4. 检查点、过账和事件原子提交

运输服务抽取 `createInTransaction` / `moveInTransaction`，只供已经取得统一锁并授权的服务组合，不新增前端“完成”接口。启动时把运输任务、容量预留、检查点和启动事件放进同一事务；取放 tick 把余额/预占、运输阶段、流水、审计、检查点和事件放进同一事务。

物理效果仍复用 Day 10 规则：take 从来源转到 TRANSIT，drop 转到 OUTBOUND，现存总量不变。运输审计对应的域事件可能与 SIM_TICK 在同一事务生成两个连续 seq；因此 seq、tick 和 epoch 绝不能混为一谈。

数据库返回结果不确定时，不能用旧内存补账。重读已提交 tick/version：若原事务其实提交，旧提案已经被 fencing 拒绝；若原事务回滚，则库存、检查点与事件都未推进。确定的业务错误可以在仍有效的 fence 下另提交一个保留最后确认状态的 ERROR；数据库不可用或 fence 已失效时不猜测写入，前端显示陈旧。

本轮只做持久运行所必需的现有取放组合，不宣称完成 Day 20 的全部业务故障场景或后续多车协调。

## 5. 快照和事件读取

`GET simulation` 在 RepeatableRead 内读取检查点、watermark、epoch、stateVersion；库存响应也在原有同一读取事务中附带 watermark。两个不同 HTTP 请求仍不是同一个数据库快照，不保证活动运行时它们天然水位相等；后续实时同步必须按水位对齐。

`GET simulation/events?after=N` 重新检查仓库权限，在读取事务中固定当前 watermark，返回至多 100 条 `after < seq <= watermark` 的连续事件及 hasMore。未来游标返回 409，非法游标返回 400，跨空间/仓库按现有授权拒绝。事件不可删除，当前没有保留期；后续若做裁剪，必须同时设计全量快照与过期游标协议。

createdAt 是数据库记录时间，不作为提交排序凭证；排序使用 seq。前端目前仍轮询，不把新增事件表当作 Socket 已实现。单仓 tick 和 seq 为非负 PostgreSQL Int，溢出会失败而不是回绕；本演示没有设计无限期运行的序号升级。

## 6. 验证与限制

见 [Day 19 报告](../../reports/day-19-acceptance.md)。已验证独立数据库客户端的双 runner、旧 epoch/tick/version 拒绝、事件失败回滚、提交水位可见性、API 进程真实重启和数据库重启对账。

尚未进行同时运行两个完整 API 进程的长时间压力/故障切换测试、数据库网络分区或时钟跳变测试。未增加 Redis、BullMQ、Socket、部署服务、机器人硬件或多车；事件逐 tick 保存路线，体积和保留策略尚未优化。永久 ERROR 不自动恢复，需要后续明确的业务恢复命令。
