# WarehouseTwin：56 天每日执行清单

配套：[总计划](./WarehouseTwin-项目总计划.md) · [面试与 AI 协作手册](./WarehouseTwin-面试与AI协作手册.md)。

按已有后端基础、每天约 4 小时设计；每周第 7 天约 1 小时轻量复盘，可休息或处理遗留问题。Day 1 按实际开始日计算。React/Three.js 都陌生时，先增加 5–7 天基础练习或延长周期。

技术固定：React / TypeScript / Vite、Three.js / R3F / Drei、Zustand / TanStack Query、NestJS、PostgreSQL / Prisma、Socket.IO；Redis / BullMQ 第 6 周加入；Vitest、Jest/Supertest、Playwright、Docker Compose、Nginx、CI。

## 每天工作方式

15 分钟确定 Issue 与验收；100–120 分钟 AI 辅助分步实现；45–60 分钟亲自验证/审查；30 分钟独立学习；10 分钟记录提交。每日建议 2–4 个有效提交，复盘日少于此数也合理。

每个测试编号 T01–T16 对应总计划。验收是未来目标，不能在未执行前写成已完成。禁止用前端动画结束、硬编码随机库存或仅看画面不碰撞充当业务验证。

## 第 1 周：业务数据与第一版 3D 场景

### Day 1 — 范围、坐标与工程骨架

- **实现**：写入库到发运用户故事、四个模块边界和不做项；确定网格/世界坐标、数量单位；锁定兼容依赖，创建 Nest `/health`、React/Vite、TypeScript strict 与 lint，配置 `.env.example`。
- **AI 协作**：让 AI 解释 React/R3F/Three.js 各自作用，给最小目录；你删除用不到的抽象。
- **验收**：前后端都能 build/启动，版本可复现；文档标明模拟设备与真实 WMS 数据的区别。
- **提交建议**：`docs: define warehouse workflows and scope`；`chore: bootstrap typed frontend and api`；`chore: lock compatible toolchain`。
- **面试主题**：数字孪生应用、仿真、3D 大屏有什么不同？

### Day 2 — 数据库、身份与仓库访问

- **实现**：Compose PostgreSQL、Prisma 迁移；种子用户、演示空间、仓库访问；admin/operator/viewer 权限；登录会话、到期登出；审计/幂等公共字段与测试库。
- **AI 协作**：AI 提议 schema 与 DTO，你检查秘密不进日志、身份不是任意 body 字段。
- **验收**：无会话不能写；viewer 只能读；不同演示空间资源隔离；真实 DB 集成测试通过。
- **提交建议**：`feat: add warehouse-scoped authentication`；`test: verify role and space access`；`chore: establish database test environment`。
- **面试主题**：身份、角色和资源归属的分工。

### Day 3 — 布局、货位与库存基础模型

- **实现**：zones/racks/locations/skus/batches/balances/movements；布局版本包含货位 ID、坐标、capacity、serviceCell；添加数量 CHECK 和归属约束；seed 初始库存通过可追溯流水创建。
- **AI 协作**：AI 生成合成布局和 10–20 个样例，你确认通道连通、货架阻挡、货位与服务点对应。
- **验收**：API 返回布局与真实库存摘要；所有余额可由流水复算；负库存写入被拒绝。
- **提交建议**：`feat: model versioned layouts and inventory`；`feat: seed traceable warehouse data`；`test: enforce quantity and location constraints`。
- **面试主题**：业务 ID、网格坐标、世界坐标为何分开？

### Day 4 — React 数据层与参数化仓库

- **实现**：React Router 页面壳；TanStack Query 读取布局/库存；Zustand 保存选择与图层；R3F Canvas、灯光、地面、货架和五类区域；用 API 坐标生成，不手写库存列表。
- **AI 协作**：AI 搭场景组件，你梳理 Query / Zustand / mesh ref 的数据分工。
- **验收**：修改后端布局后刷新场景对应变化；API 失败有提示；无库存数据时不伪造默认数量。
- **提交建议**：`feat: render warehouse geometry from api layout`；`feat: separate scene and server state`；`test: validate coordinate conversions`。
- **面试主题**：Scene、Camera、Mesh、Geometry、Material 各是什么？

### Day 5 — 货位拾取与状态颜色

- **实现**：raycast 点选货位，显示 SKU、批次、现存、预占、质量；给空/可用/预占/待检定义颜色与 legend；构建 locationId 到 mesh/instance 的稳定映射。
- **AI 协作**：AI 写交互组件，你检查点中货架是否误选后方对象、详情数据是否来自正确 ID。
- **验收**：随机抽 10 个货位与 API 对照一致；空位可选；色彩有文字/数值解释，异常不只靠红色。
- **提交建议**：`feat: inspect live slot inventory in 3d`；`feat: add inventory status palette and legend`；`test: preserve location identity in selection`。
- **面试主题**：raycasting、事件传播、拾取对象与业务对象映射。

### Day 6 — 相机、筛选、基础 CI

- **实现**：货位搜索与 fly-to、俯视正交/自由透视视角、区域过滤、相机重置；2D 库存列表作为替代入口；CI 跑 lint/typecheck/Vitest/Jest 集成。
- **AI 协作**：AI 提议相机插值，你检查目标/距离、切视角与窗口 resize；过滤不可改变真实路径障碍。
- **验收**：搜索正确定位；快速操作不遗留相机动画；无 WebGL 时能访问业务列表；CI 无私人配置可跑。
- **提交建议**：`feat: add camera navigation and zone filters`；`feat: provide accessible inventory list fallback`；`ci: run typed frontend and api checks`。
- **面试主题**：透视与正交、near/far、视觉隐藏与物理障碍。

### Day 7 — 轻量复盘与 v0.1

- **实现**：录制 API 驱动场景、搜索与点选；整理坐标/数据归属 ADR；发布 `v0.1-scene`。
- **AI 协作**：让 AI 问你“一条库存如何从 DB 到屏幕”，自己先画流程。
- **验收**：刷新后库存保持，3D 与 2D 一致；能指出 seed 与运行时真实数据边界。
- **提交建议**：`docs: publish data-driven scene demo`；确有修复再加 `fix: ...`。
- **面试主题**：React 渲染、useEffect 清理与 Strict Mode。

## 第 2 周：真实 WMS 与 3D 业务联动

### Day 8 — 入库、批次与质检

- **实现**：入库单、幂等收货到 QC 的 HOLD 库存；批次日期/过期判断；质检通过转 RELEASED，拒绝仍隔离；单据、余额、流水、审计同事务。
- **AI 协作**：AI 生成重复收货、数量错误、过期批次、质检重复的反例，你核对事务边界。
- **验收**：同一收货不重复增库存；HOLD 不可分配；质检变化有来源和操作人。
- **提交建议**：`feat: receive and inspect batch inventory`；`test: prevent duplicate receipt and quality release`；`feat: add receiving and qc forms`。
- **面试主题**：质量状态与物理位置为什么不能混用？

### Day 9 — 出库单、批次预占与请求幂等

- **实现**：单 SKU/批次出库单；可用批次推荐 FEFO，但不足提示拆单；数据库原子预占、请求 key/hash 防重复；保留分配记录。暂不实际移动机器人。
- **AI 协作**：AI 提供并发分配测试，你检查可用量是否排除了质检/过期/冻结库存。
- **验收**：竞争同一批次不超分配；同 key 不同参数冲突；前端提交总量不具权威。
- **提交建议**：`feat: allocate released stock to outbound orders`；`test: enforce allocation and idempotency rules`；`docs: define batch selection scope`。
- **面试主题**：先查后写竞态与条件更新。

### Day 10 — 搬运账本、在途库位与容量

- **实现**：定义 transport task、allocation、target capacity reservation；实现内部 take/drop/dispatch 领域服务及测试，运输先用测试命令推进；货物经过机器人 transit 库位，出库到 staging 后仍预占。
- **AI 协作**：AI 画每阶段数量变化，你手算一笔 10 件搬运的所有库位余额。
- **验收**：库内转移总量不变；重复取放不二次过账；到 staging 不提前减总库存，发运才减；目标容量不能超订。
- **提交建议**：`feat: model cargo transit and slot capacity reservations`；`test: preserve stock across transfer phases`；`docs: specify transport inventory invariants`。
- **面试主题**：在途货物为什么必须入账？

### Day 11 — 盘点与审批调整

- **实现**：单货位盘点冻结、录入实数、审批差异、调整流水；开始前检查无活动预占/在途目的地；记录版本；冻结后拒绝新任务；完结/拒绝解除。
- **AI 协作**：AI 构造盘点与分配同时发生的测试，你确认锁顺序和版本保护。
- **验收**：盘点不会覆盖新库存；未批准不改余额；有载货指向的货位不能进入盘点。
- **提交建议**：`feat: add controlled inventory counting`；`test: guard count allocation races`；`feat: add count review screen`。
- **面试主题**：物理盘点快照、并发变更与差异调整。

### Day 12 — WMS 页面、审计与对账

- **实现**：入/出库单列表、流水筛选、批次详情、审计与库存预警；写 reconcile 检查总量、预占、transit；使用一致快照读取；演示接口只给授权操作员。
- **AI 协作**：AI 生成表格与 SQL，你检查 JOIN 重复计数和分页权限。
- **验收**：按 UI 完成入库/质检/出库预占；对账能发现隔离测试库中的人为差异，正常数据为零差异。
- **提交建议**：`feat: complete warehouse operation views`；`feat: add stock and transit reconciliation`；`test: detect inconsistent warehouse balances`。
- **面试主题**：库存流水、业务审计、程序日志的区别。

### Day 13 — 库存与 3D 联动

- **实现**：操作成功后精确更新/失效 Query 缓存，3D 颜色/详情跟随；批次与区域筛选、预警定位；快速切仓取消旧请求。实时推送第 5 周实现，此时主动刷新或低频轮询。
- **AI 协作**：AI 检查 Query key，你验证库存不被复制成另一个可独立修改的 Zustand 真相。
- **验收**：页面收货后对应区域颜色变化；空/错误/加载状态清晰；旧请求不覆盖新仓。
- **提交建议**：`feat: synchronize wms mutations with scene state`；`test: avoid stale cross-warehouse data`；`feat: locate inventory warnings in scene`。
- **面试主题**：服务端状态缓存与客户端 UI 状态如何分工？

### Day 14 — 轻量 WMS 演示与 v0.2

- **实现**：录制收货、质检、库存详情、盘点和流水；汇总 T01/T02/T05/T06 的当前覆盖；发布 `v0.2-wms`。
- **AI 协作**：AI 追问每个按钮背后的数据库变化，你自己说明未实现自动搬运部分。
- **验收**：业务与图形可对照；没有把测试推进任务当作真实机器人功能。
- **提交建议**：`docs: publish wms workflow and inventory rules`；必要时 `fix: ...`。
- **面试主题**：讲清一笔入库数据的生命周期。

## 第 3 周：A* 与单机器人运输

### Day 15 — 导航网格与货位服务点

- **实现**：从版本化布局生成 walkable grid；标记货架、墙、通道、工作站和 serviceCell；提供调试网格层；坐标转换函数做双向测试。
- **AI 协作**：AI 生成样例地图，你检查货位不是机器人终点、架体没有被当作可走格。
- **验收**：每个可服务货位都有合法接近点；地图不连通可报告；可视隐藏货架仍是障碍。
- **提交建议**：`feat: derive navigation grid from warehouse layout`；`test: validate slot approach points and coordinates`；`feat: add pathfinding debug layer`。
- **面试主题**：世界空间与网格拓扑的关系。

### Day 16 — 手写 A* 与 BFS 对照

- **实现**：priority queue、open/closed、g/h、父节点回溯；四邻接 Manhattan；限制节点扩展/耗时；覆盖无路、同点、非法点、绕行；输出搜索指标。
- **AI 协作**：让 AI review 启发函数和堆更新，你独立讲一遍节点如何被扩展；不用只封装第三方包替代理解。
- **验收**：静态等权小地图上路径长度与 BFS 一致；每步相邻且不穿障碍；无路可解释。
- **提交建议**：`feat: implement bounded grid astar`；`test: compare paths with bfs oracle`；`docs: record planner assumptions and complexity`。
- **面试主题**：A*、Dijkstra、BFS、启发函数可采纳性。

### Day 17 — 纯 TypeScript 固定步长模拟器

- **实现**：提取无浏览器依赖的 simulation 包；tick 驱动机器人位置、方向、状态和电量；默认 250ms 一步；seed、命令输入、状态摘要可复现；暂停不推进逻辑时间。
- **AI 协作**：AI 搭类型与测试，你阻止使用不受控 Date.now/Math.random 决定核心模拟结果。
- **验收**：同初始状态/输入/seed 产生相同结果；不同浏览器帧率不影响逻辑；不运行 setInterval 多套时钟。
- **提交建议**：`feat: implement deterministic simulation core`；`test: verify fixed-step and pause behavior`；`docs: separate simulation and wall clocks`。
- **面试主题**：确定性、固定 timestep、墙钟与逻辑时钟。

### Day 18 — 单车任务与显示插值

- **实现**：任务 phase：接近取货点、装载、运输、卸载；一台机器人、简单几何模型；前端读取后端模拟状态，可暂轮询；在 `useFrame` 中基于已确认段插值，绘制路线。
- **AI 协作**：AI 做模型/轨迹显示，你核对 mesh ref 更新，不逐帧 setState，也不由前端通知“完成”。
- **验收**：前端刷新不重置机器人任务；低 FPS 只影响显示；无数据时停止外推并显示陈旧状态。
- **提交建议**：`feat: execute single-robot transport phases`；`feat: interpolate authoritative robot poses`；`test: keep rendering independent of task progress`。
- **面试主题**：React 更新与 Three.js render loop 的区别。

### Day 19 — 持久 runner、tick 与事件水位

- **实现**：runtime/checkpoint、owner lease、epoch、expectedTick；每 tick 提交受版本保护；仓库 runtime 行锁串行化有关业务事务并分配 commit-safe seq；记录事件，改造 WMS 事务使用统一提交边界。
- **AI 协作**：AI 分析两 runner 与过期计算结果，你检查路径计算在事务外、提交前校验版本。
- **验收**：第二 runner 不能同时写；停止/重启从已提交 tick 继续；旧 epoch 无法覆盖新状态；事件与状态同事务。
- **提交建议**：`feat: persist fenced simulation ticks and events`；`test: reject stale runner commits`；`refactor: unify warehouse state commit boundary`。
- **面试主题**：lease、fencing epoch、版本检查与粗粒度锁的取舍。

### Day 20 — 机器人取放货与 WMS 原子衔接

- **实现**：runner 在完成装载/卸载阶段时调用 Day 10 领域服务；同事务提交任务 phase、transit/货位余额、流水、机器人载荷与事件；绑定 task/phase 唯一动作 key；增加操作员发运确认。
- **AI 协作**：AI 列提交前后故障点，你实际中断后重跑，检查载荷和账本。
- **验收**：上架与出库运输均有真实状态变化；重复 tick/phase 不重复过账；到出库暂存不自动扣仓库总库存。
- **提交建议**：`feat: commit robot cargo phases with inventory movements`；`test: deduplicate pickup dropoff and dispatch`；`docs: explain transport and shipment boundary`。
- **面试主题**：为什么动画完成不是库存扣减依据？

### Day 21 — 轻量单车演示与 v0.3

- **实现**：录制“收货 → 质检 → 单车上架 → 出库搬运 → 发运”；展示 transit 与最终对账；发布 `v0.3-single-robot`。
- **AI 协作**：AI 问一笔货在每个时刻位于哪里，你用数据库和事件回答。
- **验收**：无需手工改数据库跑通；任意阶段暂停可查到货物；还不宣称多车避碰。
- **提交建议**：`docs: publish single-robot warehouse demo`；必要时 `fix: ...`。
- **面试主题**：完整讲一条机器人任务及库存状态迁移。

## 第 4 周：多机器人、拥堵、故障与充电

### Day 22 — 多车分配与下一步协调

- **实现**：扩到 3–5 台车；一机器人一有效任务、一次任务分配唯一；集中处理每步移动提案；禁止同格与 edge swap，保守禁止进入其他车当前占用格；稳定优先级与等待时长。
- **AI 协作**：AI 给两车交叉、对向和跟随反例，你写状态断言而不是只看动画。
- **验收**：同任务不被两车领取；T08 中冲突会等待；无碰撞但无法完成时保留真实等待状态。
- **提交建议**：`feat: coordinate multi-robot step proposals`；`test: reject vertex and edge-swap conflicts`；`docs: define conservative movement rules`。
- **面试主题**：单机器人最短路为什么不能直接保证多机器人安全？

### Day 23 — 狭窄通道与工作站资源

- **实现**：配置单容量通道、停车/充电/工作站；进入前申请资源，出清才释放；故障/空闲车持续占格；记录等待原因和累计 tick。
- **AI 协作**：AI 构造双方同时进通道及通道内故障，你检查许可不会因普通超时自动放掉物理占用。
- **验收**：不能迎面对穿；等待可观察；资源回收与占格一致；停在通道口的车不会被当作透明。
- **提交建议**：`feat: reserve narrow aisles and service stations`；`test: retain occupied resources during faults`；`feat: expose robot wait reasons`。
- **面试主题**：逻辑锁、物理占用与资源释放条件。

### Day 24 — 通道封锁与有界重规划

- **实现**：操作员封锁/解封空闲格；map revision 更新；旧路线失效；对受影响车辆按预算重算；拒绝封锁当前占用格或本步已批准运动段。
- **AI 协作**：AI 生成绕行/完全断路/频繁变图场景，你审核异常路径不会返回穿墙直线。
- **验收**：有路则走合法绕行，无路则暂停并告警；旧版本计算不能提交；地图变化记录到历史。
- **提交建议**：`feat: replan around controlled aisle closures`；`test: reject stale and unsafe routes`；`feat: visualize closure and route changes`。
- **面试主题**：路径失效、地图版本、计算预算与过期结果。

### Day 25 — 设备故障与载货恢复

- **实现**：在 tick 边界注入故障；任务暂停或 NEEDS_RECOVERY；保留 transit/目标容量；维修后继续原任务或明确创建恢复流程；取货前取消可释放，载货后不可直接取消。
- **AI 协作**：AI 给故障发生在取货前/后/卸货后不同场景，你核对库存和资源。
- **验收**：T04/T09 中货物不丢、不重复；故障车不瞬移，不被其他车穿过；所有恢复操作有审计。
- **提交建议**：`feat: preserve cargo during robot failure recovery`；`test: cover phase-specific pause and cancellation`；`feat: add operator recovery actions`。
- **面试主题**：业务补偿与“把状态改成失败”有什么差别？

### Day 26 — 电量、充电与无进展检测

- **实现**：简化电量耗费；接单预估到取货/卸货/充电的成本与余量；充电位争抢；等待达到阈值触发诊断、重规划或人工介入；定义拥堵/故障告警去重键。
- **AI 协作**：AI 制造充电站不可达、低电量载货、循环等待反例，你明确哪些自动解决、哪些安全停住。
- **验收**：不能把明显无法完成的任务派给低电量车；充电位不超占；检测到无进展，不承诺任意地图自动解死锁。
- **提交建议**：`feat: schedule charging and detect stalled traffic`；`test: cover energy and no-progress boundaries`；`docs: state scheduler liveness limits`。
- **面试主题**：安全性、活性、饥饿、死锁如何区分？

### Day 27 — 多车重启与调度回归

- **实现**：固定地图/seed 跑多任务；进程在认领/取货/卸货前后退出；启动第二 runner，验证 epoch/lease；检查任务、载货、占格、资源从 checkpoint 恢复。
- **AI 协作**：AI 建场景脚本，你确认实际停止进程，报告最后已提交 tick 和恢复点。
- **验收**：T11 旧 runner 不双写；恢复不重复认领或过账；无冲突与库存对账均通过；记录未支持情形。
- **提交建议**：`test: verify multi-robot restart and fencing`；`fix: resolve reproduced scheduler recovery defects`（如有）；`docs: record simulation recovery evidence`。
- **面试主题**：进程恢复为什么不能只重新创建 setInterval？

### Day 28 — 轻量多车演示与 v0.4

- **实现**：录制 5 台车、窄通道等待、封路绕行、载货故障恢复与充电；汇总限制；发布 `v0.4-fleet-simulation`。
- **AI 协作**：AI 检查演示中是否隐藏了无法自动处理的情形，你给出可见暂停提示。
- **验收**：看得懂等待原因；没有穿模掩盖碰撞；说清网格占地和边界故障假设。
- **提交建议**：`docs: publish fleet behavior and limitations`；必要时 `fix: ...`。
- **面试主题**：展示一个安全停止但未完成任务的案例。

## 第 5 周：实时运营中心与时间轴回放

### Day 29 — Socket.IO 事件与授权房间

- **实现**：Gateway 握手身份、仓库订阅授权；推送已提交任务/库存/告警/位置批次；统一 seq/version/epoch 字段；数据库事件 relay 可补发，不在业务提交前广播成功。
- **AI 协作**：AI 搭 socket listener，你核对事件先持久化、房间名不能由客户端任意信任。
- **验收**：两个浏览器看到同一仓库状态；无权用户不能订阅；失败事务不广播已完成；退出时解绑。
- **提交建议**：`feat: stream committed warehouse events`；`test: authorize socket subscriptions`；`docs: define realtime event envelopes`。
- **面试主题**：Socket.IO 与原生 WebSocket 的关系、room 是否等于授权？

### Day 30 — 快照、去重与断线补齐

- **实现**：一致快照+水位、订阅缓冲、按 seq 应用/去重/补缺口；过期游标全量同步；处理快照读取期间库存更新；前端显示同步中/离线/陈旧。
- **AI 协作**：AI 生成事件重复/缺失/乱序测试，你核对低 ID 晚提交不会被错误跳过。
- **验收**：断网后回到正确库存与任务状态；恢复失败不静默；旧 epoch 位姿不覆盖新运行；授权重新检查。
- **提交建议**：`feat: recover realtime state from snapshots and offsets`；`test: cover snapshot and live-event races`；`feat: expose synchronization status`。
- **面试主题**：连接恢复、消息恢复、业务恢复为什么是三件事？

### Day 31 — 运营指标与两种热力图

- **实现**：任务队列、待处理单、完成率、运行/故障/充电数；定义时间窗与取消是否计入分母；库存热力与通道等待热力独立图层，按 tick 等待时间聚合。
- **AI 协作**：AI 做图表组件，你用固定样例手算统计并标注“位置访问频率不等于拥堵”。
- **验收**：数据能追溯事件/源表；切换热力层有正确 legend；无任务时分母为零有合理显示。
- **提交建议**：`feat: add operational metrics and heatmap layers`；`test: verify dashboard metric definitions`；`docs: distinguish utilization and congestion`。
- **面试主题**：指标口径、时间窗、吞吐与拥堵如何解释？

### Day 32 — 轨迹、快照与历史接口

- **实现**：保存每已提交 tick 紧凑轨迹、任务事件；每 20 tick 创建一致全仓快照；保留 layoutVersion 和库存摘要；提供时间范围分页查询，限制返回量与权限。
- **AI 协作**：AI 设计历史 schema，你检查一个任务回放是否缺少同时间其他车与障碍状态。
- **验收**：任一保留时间点可找到基线快照和完整事件段；旧布局可载入；无权限不能读历史。
- **提交建议**：`feat: persist replayable warehouse snapshots and tracks`；`test: reconstruct state from recorded history`；`feat: expose scoped history queries`。
- **面试主题**：快照+事件与重新跑算法重现的区别。

### Day 33 — 时间轴、拖动与回放隔离

- **实现**：时间轴、播放/暂停、0.5/1/2 倍速、任务高亮；seek 从最近快照重建；独立 replay store；回放禁止操作按钮，回到 live 重新同步。
- **AI 协作**：AI 实现控件，你验证连续播放与直接 seek 到相同 tick 的状态摘要一致。
- **验收**：T13 状态可复现；live 新消息不污染 replay；缺历史段显式报不完整，不编造库存变化。
- **提交建议**：`feat: add isolated timeline replay and seeking`；`test: match seek and sequential replay state`；`fix: prevent live writes from replay mode`。
- **面试主题**：回放时钟、状态 reducer、历史版本兼容。

### Day 34 — 实时背压与 React 订阅清理

- **实现**：合并/丢弃过期实时位置包但保留权威事件恢复路径；前端位置缓冲上限；低频 UI 与高频 mesh 更新分开；切仓/重连/Strict Mode 不重复注册 listener。
- **AI 协作**：AI 提出慢客户端与重复挂载测试，你检查内存、收包数量和 React renders。
- **验收**：连续切仓/进入回放后监听数回落；慢客户端不无限增长缓冲；权限变化及时退出订阅。
- **提交建议**：`perf: bound telemetry buffering and ui updates`；`test: clean up realtime subscriptions`；`docs: define realtime freshness policy`。
- **面试主题**：背压、采样、丢旧帧与丢业务事件的区别。

### Day 35 — 轻量运营回放演示与 v0.5

- **实现**：录制实时任务→封路告警→断网恢复→时间轴回放；补一条 Playwright 流程检查任务 ID/库存/回放模式；发布 `v0.5-operations`。
- **AI 协作**：AI 用用户视角检查“当前状态”和“历史状态”是否显著区分。
- **验收**：不需要解释隐藏操作就能看懂；回放显示历史布局；UI 没有暗中触发重复任务。
- **提交建议**：`test: cover operational live and replay flow`；`docs: publish realtime and replay walkthrough`。
- **面试主题**：如何给非技术运营人员解释数据陈旧和同步状态？

## 第 6 周：后台任务、并发与故障验证

### Day 36 — Redis/BullMQ 第二阶段接入

- **实现**：Compose Redis、worker；选择回放索引或日报生成之一作为真实后台任务；job intent/outbox 与业务提交一致，后台投递；为输入定义版本与范围。
- **AI 协作**：AI 做队列骨架，你检查没有把每个机器人 tick 变成队列 job，也没有复制库存状态。
- **验收**：源数据已提交后能触发处理；Redis 暂停时意图仍保留；核心 WMS/runner 行为符合故障策略。
- **提交建议**：`feat: add durable asynchronous report jobs`；`feat: relay database job intents to bullmq`；`docs: define queue and simulator responsibilities`。
- **面试主题**：长任务队列与实时仿真主循环为什么分开？

### Day 37 — Worker 幂等、重试与失败恢复

- **实现**：job 业务 key、数据库唯一结果/状态；有限重试、退避、失败记录与受控重跑；模拟提交后 worker 退出、任务删除后重新入队。
- **AI 协作**：AI 生成重投场景，你验证 BullMQ jobId 不是唯一持久幂等手段。
- **验收**：T15 不生成重复逻辑结果；失败可追溯；Redis 恢复后补处理；任务不依赖“恰好执行一次”。
- **提交建议**：`feat: make background outcomes idempotent`；`test: recover repeated and interrupted jobs`；`ops: add bounded failure replay procedure`。
- **面试主题**：队列去重与业务幂等的生命周期差异。

### Day 38 — WMS 竞争与载货正确性

- **实现**：真实 PostgreSQL 多连接执行 T02–T06：来源库存/目标容量争抢、重复取放发运、盘点与分配冲突、载货故障；检查事务回滚、关联流水和最终数量。
- **AI 协作**：AI 写并发 harness，你使用 barrier/故障点放大窗口，核对最终 DB 不只数 HTTP 200。
- **验收**：库存/容量不超分配；失败无半成品；transit 与有效任务匹配；至少记录 20 轮或明确实际轮数。
- **提交建议**：`test: exercise inventory and transport contention`；`fix: resolve reproduced cargo transaction races`（如有）；`docs: record inventory correctness evidence`。
- **面试主题**：库存占用、货位容量、机器人占格是三类不同资源。

### Day 39 — 路径与多车性质测试

- **实现**：固定 seed 生成小地图与任务，检验 path 合法、BFS 对照、每 tick 无 cell/edge 冲突、通道容量、无路结果；添加封路、故障、充电组合序列。
- **AI 协作**：AI 生成候选反例，你保存失败 seed 并尽量缩小地图，不让测试完全照抄调度实现。
- **验收**：T07–T10 可复现；遇闭环等待输出未完成原因；不把“没撞车”统计成“全部任务成功”。
- **提交建议**：`test: validate planner and fleet invariants across seeds`；`fix: address minimal scheduler counterexample`（如有）；`docs: separate safety and completion results`。
- **面试主题**：不变量测试、随机生成与反例缩减。

### Day 40 — Runner 与 Socket 故障矩阵

- **实现**：T11/T12/T14：进程中断、第二 runner、数据库短暂不可用、重复/缺失事件、快照窗口、过期游标、切仓与权限撤销；重启后核对状态与授权。
- **AI 协作**：AI 提议故障注入点，你确认实测目标窗口和恢复步骤，不只抛一个模拟异常。
- **验收**：不会双写或无 DB 继续权威运动；断线最终同步；旧房间/旧请求不泄露或覆盖数据。
- **提交建议**：`test: inject runtime and synchronization failures`；`fix: harden fenced recovery and resync`（如有）；`docs: publish failure recovery matrix`。
- **面试主题**：断线、掉进程、失去数据库分别怎样影响系统？

### Day 41 — 观测、对账与历史完整性

- **实现**：统一 request/task/robot/event ID；记录 tick lag、队列积压、replan 次数、等待原因、Socket 恢复、数据库耗时；对账含 transit；历史归档按快照+事件段处理。
- **AI 协作**：AI 写统计/清理脚本，你检查没有删掉回放基线、日志不暴露秘密；清理仅作用于明确演示空间。
- **验收**：给任务 ID 可追踪业务/仿真/推送；已知差异会报警；保留范围内回放完整，范围外明确提示。
- **提交建议**：`feat: correlate warehouse operational telemetry`；`ops: verify reconciliation and history retention`；`docs: add diagnosis runbook`。
- **面试主题**：观测、审计、回放事件分别服务什么问题？

### Day 42 — 轻量正确性报告与 v0.6

- **实现**：汇总 T01–T15 的已跑/未跑/失败/修复结果，记录环境、SHA、seed、SQL 与限制；发布 `v0.6-reliability`。T16 性能与连续运行下周完成。
- **AI 协作**：AI 排版报告，你逐条核查事实，不让它把目标值写成实测。
- **验收**：展示一个真实反例及修复证据；明确网格模型假设和未覆盖真实机器人风险。
- **提交建议**：`docs: publish warehouse correctness report`；`ci: gate critical business and simulation regressions`。
- **面试主题**：怎样用证据支持“正确”，同时说明保证范围？

## 第 7 周：3D 性能、长期运行与部署

### Day 43 — 实例化与绘制调用

- **实现**：记录优化前 draw calls/triangles/frame time；重复货架/货箱使用共享 geometry/material 与 InstancedMesh；稳定 instanceId↔locationId 映射；颜色与矩阵增量更新。
- **AI 协作**：AI 改组件，你核对筛选、排序、重建后拾取映射没有错位，共享资源没被误销毁。
- **验收**：同地图/相机/DPR 前后对比；点击详情仍正确；不能只凭用了实例化就宣布提速。
- **提交建议**：`perf: instance repeated warehouse geometry`；`test: preserve slot picking after instancing`；`docs: compare draw calls and frame timings`。
- **面试主题**：draw call、三角形数、实例化与拾取的取舍。

### Day 44 — 资源生命周期与质量档位

- **实现**：排查手动资源/缓存/共享资源所有权；反复挂载/离开场景；提供 DPR、阴影、标签数量档位；减少无意义透明层。若有余力，替换一台授权 GLB 并比较体积，否则保留几何模型。
- **AI 协作**：AI 找创建未释放和重复加载路径，你核对 R3F 管理与手工 dispose 边界。
- **验收**：多次进出后 geometry/texture 计数不持续增长；低配模式可用；无 WebGL 有 2D 替代，GLB 资产有来源许可。
- **提交建议**：`fix: manage scene resource ownership and cleanup`；`feat: add adaptive scene quality presets`；`test: exercise repeated scene mount lifecycle`。
- **面试主题**：JS GC 为什么不自动释放所有 GPU 资源？

### Day 45 — React、状态订阅与服务端热点

- **实现**：用 profiler 找整页重渲染、标签更新、Query 瀑布请求；高频姿态 ref 读取、选择器细化；分析 API/数据库热点与 A* 长任务。只有实测阻塞才引入 worker_threads 等额外复杂度。
- **AI 协作**：AI 提出优化候选，你一次改一个因素，验证没有破坏状态同步。
- **验收**：位置更新不导致整个 WMS 页面逐 tick 重绘；tick 超时有 lag；优化前后同场景结果可比较。
- **提交建议**：`perf: isolate telemetry from react business renders`；`perf: optimize measured query or planner hotspot`；`docs: record profiling decisions`。
- **面试主题**：React memo/selectors、Node event loop、CPU 与 I/O 瓶颈。

### Day 46 — 场景与仿真两套性能基准

- **实现**：场景 100/500/2000 货位、1/5/10 车显示；后端独立跑 1/5/10 台真实模拟；固定相机轨迹、预热、60 秒采样，记录硬件/GPU/浏览器/DPR、frame p95、draw calls、tick p95、消息字节和任务结果。
- **AI 协作**：AI 统计原始数据，你标明哪些是渲染 fixture、哪些真的跑调度，自动化软件渲染单独列。
- **验收**：主要目标是声明环境的 500 货位+5 车；性能没达标如实降级；每次完整仿真之后对账。
- **提交建议**：`perf: add separate rendering and simulation benchmarks`；`docs: publish reproducible performance matrix`；`perf: select measured default quality`。
- **面试主题**：FPS、frame time p95、tick lag 和业务吞吐各说明什么？

### Day 47 — 容器、Nginx 与候选部署

- **实现**：构建 web/api/simulator/worker；Compose 依赖、迁移、seed、持久卷、健康检查；Nginx 静态资源与 Socket.IO 升级/轮询路径、超时、HTTPS；公开访客隔离与任务额度。
- **AI 协作**：AI 写配置，你检查前端无服务端秘密、基础设施端口不公开、runner 只受控认领。
- **验收**：新环境可启动；外网打开 3D/业务与 Socket；刷新深层路由正常；两访客数据互不可见。
- **提交建议**：`build: package warehouse demo services`；`ops: configure nginx and websocket hosting`；`test: verify public demo isolation`。
- **面试主题**：WebSocket 反向代理、连接超时、水平扩展前提。

### Day 48 — 连续运行、备份与恢复

- **实现**：专用环境连续运行 30–60 分钟，循环任务/封路/暂停/回放；记录资源曲线与最终对账；备份恢复到隔离库；验证 checkpoint、历史与布局；公共 Demo 设自动停止与清理期限。
- **AI 协作**：AI 辅助分析趋势，你确认没有用每分钟重置掩盖泄漏；恢复目标路径/数据库明确。
- **验收**：T16 有完整日志；不会持续重复增加 listener/资源；恢复后货物、任务、历史一致；清理不损坏其他空间。
- **提交建议**：`test: run warehouse soak and recovery scenarios`；`ops: document verified backup restore and cleanup`；`docs: report long-running resource behavior`。
- **面试主题**：内存泄漏、缓存稳定基线、恢复点与运行限制。

### Day 49 — 轻量候选版审查

- **实现**：用新浏览器或请朋友执行入库、任务、故障、回放四条脚本；检查 loading/empty/error/无图形支持；冻结新增功能，发布 RC。
- **AI 协作**：AI 根据实际反馈排序，你优先修业务误解、掉状态和无法演示问题。
- **验收**：主线可独立操作；失败状态有下一步；未实现项不伪装成可用按钮。
- **提交建议**：`docs: record release candidate feedback`；`fix: resolve confirmed demo blockers`。
- **面试主题**：可演示、可用、生产可用三种标准有什么差异？

## 第 8 周：复验、GitHub 展示与面试

### Day 50 — 干净启动与关键回归

- **实现**：从新目录/依赖环境启动；执行迁移/seed、Vitest、Jest/Supertest、T01–T16 适用回归与 3 条 Playwright 流程；重新验证重启与断网。
- **AI 协作**：AI 严格按 README 执行，你记录所有隐藏配置和手工步骤并修复。
- **验收**：不依赖本机旧数据；固定 seed 可复现；关键失败会阻止发布；留下 SHA 与版本记录。
- **提交建议**：`test: verify clean setup and release regressions`；`fix: remove undocumented environment assumptions`；`docs: update reproducibility evidence`。
- **面试主题**：测试分层、确定性 fixture、视觉截图不能证明什么？

### Day 51 — README、架构与证据索引

- **实现**：首屏放项目价值、Demo、GIF、业务数据来源、性能/正确性报告；补地图坐标、库存账、调度边界、同步/回放、权限、脚本、License；整理已有 5–8 篇 ADR。
- **AI 协作**：AI 优化文案和英文摘要，你删掉“工业级控制”“任意无碰撞”等未经支持的表述。
- **验收**：30 秒看懂用途，3 分钟找到三个亮点与证据；模拟数据与模拟机器人标识明确。
- **提交建议**：`docs: prepare warehouse portfolio readme`；`docs: link architecture and experiment evidence`；`docs: add english project overview`。
- **面试主题**：如何把复杂系统讲清楚，而不是列技术栈？

### Day 52 — 业务与技术两段录像

- **实现**：3–5 分钟业务演示：入库/质检/运输/发运/库存；2–3 分钟技术演示：封路/故障/transit/断线恢复/历史回放/性能报告；录真实流程与小 GIF。
- **AI 协作**：AI 写讲稿，你用自己的话讲并操作，显示必要版本/时间信息。
- **验收**：不靠剪辑隐藏失败；回放和实时显著区分；视频链接可用、无秘密信息；2D 替代路径可说明。
- **提交建议**：`docs: add business and simulation demonstration videos`；`docs: provide repeatable demo scripts`。
- **面试主题**：90 秒、5 分钟、技术深挖三种表达。

### Day 53 — 简历与三个技术故事

- **实现**：按实测写三条经历：后端驱动 3D、仿真与库存一致性、实时回放/性能；准备一个失败反例、一项优化、一项主动裁剪；标记核心代码入口。
- **AI 协作**：AI 质疑所有“提升、稳定、低延迟”，你提供分母、环境与报告，否则改成准确描述。
- **验收**：能解释简历每个名词和数字；无虚构硬件接入、商业用户、生产规模。
- **提交建议**：`docs: write verified resume project statements`；`docs: map interview stories to code and reports`。
- **面试主题**：哪些 AI 帮写、哪些是你的关键判断？

### Day 54 — 独立编码与系统设计模拟

- **实现**：不看 AI 写一个小地图 A* 或优先队列、一个去重/补缺口 reducer、两条库存对账 SQL；解释 useFrame/ref 与 Query/Zustand；画 50 台车/多仓扩展需要改什么，先设计不强行实现。
- **AI 协作**：完成后让 AI review 与追问，自己修一个真实缺陷。
- **验收**：能独立解释和修改核心模块；不把理论扩展当已实现性能；说清粗锁方案的瓶颈。
- **提交建议**：`docs: record independent coding and scaling exercises`；`test: capture discovered regression`；有实际修复再做 `fix: ...`。
- **面试主题**：算法、数据库、事件流、图形性能综合。

### Day 55 — 发布 v1.0.0

- **实现**：核对 CI、启动脚本、Demo、视频、报告、环境模板、数据/资产许可；扫描秘密；写真实 release notes，tag 并部署；只修发布阻塞问题。
- **AI 协作**：AI 最后审阅，你拒绝临时大升级、新框架和未验证功能。
- **验收**：三个入口可用：业务演示、历史回放、复现报告；核心回归通过；已知限制完整。
- **提交建议**：`chore: prepare v1.0.0 warehouse release`；`docs: publish release notes and known limits`。
- **面试主题**：发布门槛、版本兼容、回滚与数据恢复。

### Day 56 — 轻量复盘与岗位匹配

- **实现**：总结 8 周、3 个最难问题、3 个仍未解决限制；查 10–15 条适合经验的 React/Web3D/数字孪生/全栈 JD，区分已证明/理解/待补；做 30 分钟模拟面试。
- **AI 协作**：让 AI 依据真实仓库追问，自己先答；不同岗位选择不同亮点，不强行一个版本适配所有岗位。
- **验收**：能从数据库到画面讲完整链路；能承认算法活性、设备模拟和规模限制；下一阶段学习清楚。
- **提交建议**：`docs: publish final retrospective and job skill mapping`。
- **面试主题**：重新做会删掉什么？最有价值的技术决定是什么？

## 每日记录模板

```markdown
# Day NN：主题
- Issue / PR：
- 今天的可观察目标：
- 实际完成和未完成：
- AI 帮了什么，我修改/否决了什么：
- 验证命令、地图版本、seed、结果：
- 数据库不变量 / 调度规则 / UI 状态边界：
- 发现的反例及复现步骤：
- 今天能独立解释的概念：
- 明天第一步：
```

每周可合并成一个 devlog。记录真实失败比每天重复“完成任务”更有价值；休息日不用空提交或改时间。

## 落后时怎么裁剪

第 14 天 WMS 不闭环：优先完成库存与流水，减少美术和图表。第 21 天单车不能正确过账：暂停多车扩张。第 28 天冲突处理不稳定：先减少到 3 台车并保留安全暂停，不能穿模。第 35 天回放无法重建状态：先补事件与快照，延后可选 BullMQ 任务种类。第 42 天仍丢库存/重复过账/越权：延期发布，优先修复。
