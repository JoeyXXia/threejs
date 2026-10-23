# ADR 0001：Day 1 范围、状态权威与坐标

日期：2026-10-23。状态：采用。依据：`doc/planning` 中三份原始计划。

## 用户故事与数量变化

运营人员收货 SKU-A / 批次 B01 共 10 件到质检区，质量 HOLD，仓内总量增加 10；质检通过转为 RELEASED。创建上架任务时预占来源并预留目标容量，位置不变。取货时来源转入机器人虚拟 transit 库位；卸货时 transit 转入目标货位，释放预占和容量预留。这些库内转移总量均不变。

出库指定一个 SKU / 批次 / 数量，预占后经过库位、transit、拣货工作站和出库暂存区。运输完成仅表示到达暂存区，仍持有订单预占；运营人员确认发运后才扣减仓库总量。载货故障保留 transit 库存，进入恢复流程，不能直接消除货物。

这是后续实现契约，Day 1 尚未实现上述业务。

## 四个模块边界

| 模块 | 权威与职责 | 边界 |
| --- | --- | --- |
| WMS / API | PostgreSQL 保存单据、余额、预占、容量、流水和任务；Nest 负责命令、验证与授权 | 库存阶段变化、流水、事件同事务；ORM 模型不直接作为前端契约 |
| Simulation | 纯 TS 算法 + 服务端单仓 runner；固定 tick 提交机器人与阶段状态 | A* 只规划四邻接几何路径；调度另管冲突；DB 不可用则停止推进 |
| Sync / Replay | 事务内持久化 seq 事件和快照；提交后 Socket 投递 | 缺口补拉或重取快照；回放使用历史布局与记录，不重新运行当前算法 |
| Web / Scene | React 业务界面、R3F 场景、Three.js 几何与渲染 | Query 管业务缓存；Zustand 管 UI；ref 管高频显示插值，均不是库存权威 |

目录按需建立：今天只有 `apps/web`、`apps/api`、`scripts`、文档。contracts、simulation、database、scene 包在有真实共享逻辑时创建，不预建空抽象。

## 坐标与单位

- 布局按版本保存；起步目标 30 × 20 格，不是已生成的地图。
- 网格 `(gridX, gridZ)` 使用从 0 开始的整数，边界为 `0 <= gridX < width`、`0 <= gridZ < depth`。四方向移动，无对角。
- 世界坐标是右手系，Y 向上，X 对应 gridX，Z 对应 gridZ；一世界单位约定为一米。`cellSize = 1` 米，原点 `(originX, originZ) = (0, 0)` 是网格外缘左上角。俯视地图中 +Z 向下。
- 格心：`worldX = originX + (gridX + 0.5) * cellSize`，`worldZ = originZ + (gridZ + 0.5) * cellSize`。地面 Y=0，模型中心 Y 由高度决定。
- 世界到网格：先减原点再除 cellSize，向下取整；随后校验边界。例：格 `(2,3)` 对应格心 `(2.5, 0, 3.5)`；X=30 或 X<0 均在宽 30 的地图外。
- 货位有稳定业务 ID 和层高；机器人到的是合法地面 `serviceCell`，不能驶入货架占格，也不模拟举升物理。
- 数量用整数件，`on_hand >= 0`、`0 <= reserved <= on_hand`；容量按件数。库位占用 + 目标容量预留不得超过容量。
- 权威模拟步长后续采用 250ms，每步最多一格；模拟时间、服务器时间、浏览器显示时间分开。

坐标转换代码和测试按 Day 4 接入实际布局时实现，今天只确定契约。

## 不做项与事实边界

一仓、一个固定版本布局起步；单次运输一个 SKU / 批次，不自动跨批拆单。设备、地图与场景均为合成演示，不接真实 AGV/AMR、PLC、传感器；不实现 ROS2、SLAM、连续物理、工业安全认证、任意地图编辑器或任意地图无死锁保证。Redis/BullMQ 在第 6 周接入。无 LLM / API key 需求。

未来 WMS 业务将真实持久化，设备始终软件模拟。Day 1 无数据库和库存，不展示假库存。`/health` 仅说明 HTTP 服务存活，不表示数据库就绪或业务正确。3D 场景、身份权限、迁移均不在今天范围。

## 工具链决策

采用 pnpm workspace，应用 Node 22.14.0、pnpm 11.25.0、TypeScript 5.9.3；精确直接依赖与 `pnpm-lock.yaml` 固定传递依赖。pnpm 11 工作区设置写入 YAML。`pnpm exec node --version` 实测为 22.14.0，与 `.nvmrc` 一致；本机 pnpm 启动器自身携带 Node 24.19.0，所以 engines 允许这两个版本，但今天的应用验收在 22.14.0 下进行。

React 19.3.1 / React DOM 19.3.1、R3F 9.8.2、Drei 10.7.9、Three.js 0.186.1，通过 registry peerDependencies 与安装严格 peer 检查核对。[R3F 官方版本配对说明](https://r3f.docs.pmnd.rs/getting-started/installation)规定 R3F 9 配 React 19。Vite 8.3.5、React 插件 6.1.2 支持所选 Node。Nest 12.2.0 使用 Express adapter。Prisma 等数据库依赖在 Day 2 依据当时 engine / PostgreSQL 兼容要求锁定，不提前安装候选预发布版本。

React 描述业务 UI 与状态；Three.js 提供场景、相机、几何、材质与渲染；R3F 是 Three.js 的 React renderer；Drei 提供常用辅助组件。今天锁定渲染依赖，但不加载 Canvas，不宣称完成 WebGL 运行验证。
