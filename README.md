# WarehouseTwin

WMS 业务驱动的智能仓库数字孪生演示系统。样本为合成数据，库存与流水由 PostgreSQL 持久化，设备为软件模拟。

Day36 增加可选的 BullMQ 发运日报 worker。已提交发运在同一 PostgreSQL 事务写入待办；Redis 故障只延迟日报，不阻塞核心 WMS 或模拟。见 [Day36 验收](reports/day-36-acceptance.md)。

Day37 为同一发运日报加有限退避重试、数据库失败记录和指定代次重跑。Redis 任务重投不覆盖已完成报告。见 [Day37 验收](reports/day-37-acceptance.md)。

Day34 区分实时位姿采样与权威业务事件：新版 Socket 每页最多一个最新位姿，浏览器单槽直接更新模型，业务事件仍按 seq 恢复。见 [Day34 验收](reports/day-34-acceptance.md)。

Day33 提供独立只读历史回放：支持拖动、暂停、倍速和任务高亮；使用旧布局和确认帧，不把实时更新混入历史。见 [Day33 验收](reports/day-33-acceptance.md)。

Day32 增加历史基线、紧凑轨迹与只读分页接口，保留旧布局并按提交序号读取全车上下文。已有本地库需运行 `pnpm db:migrate`。接口和限制见 [Day32 验收](reports/day-32-acceptance.md)；本版不含时间轴界面。

Day31 增加运营指标、库存热力和通道等待热力。库存按实地点位现存件数，等待按当前布局已提交的车辆等待时间，不把经过次数当拥堵。指标的时间窗、完成率分母及复验见 [Day31 验收](reports/day-31-acceptance.md)。

Day30 将仓库场景的布局、库存与运行状态合成一次一致读。断线恢复从最后确认水位续订；过期游标重新取完整基线，离线或恢复失败会标明并停用场景写操作。见 [Day30 验收](reports/day-30-acceptance.md)。

Day29 增加仓库场景的 Socket.IO 授权订阅。只转发 PostgreSQL 已提交事件，按仓库检查会话与权限；画面以 HTTP 快照为准，业务事件触发库存刷新。已有本地库运行 `pnpm db:generate` 和 `pnpm db:migrate`，无需重置。协议和验收见 [Day29 报告](reports/day-29-acceptance.md)。

Day28 归档第 4 周版本 `v0.4-fleet-simulation`。新版[五车录像](reports/day-28-demo.webm)串联封路绕行、通道等待、带货故障/恢复、充电和库内取放对账。见[阶段说明](docs/releases/v0.4-fleet-simulation.md)和[实测报告](reports/day-28-acceptance.md)。没有接入真实设备，也不保证拥堵最终解除。

Day35 的第 5 周[运营录像](reports/day-35-demo.webm)串联实时任务、封路告警、断线恢复与独立只读回放。见 [`v0.5-operations` 阶段说明](docs/releases/v0.5-operations.md)和[实测报告](reports/day-35-acceptance.md)。

Day26 新增车队电量准入、单容量充电与无进展诊断，见 [Day26 验收报告](reports/day-26-acceptance.md) 与 [ADR0017](docs/adr/0017-fleet-energy-and-stall-diagnostics.md)。接单核算空载、载货与回充余量；空载车可申请充电，满电不清实际占格。载货能量不足原地保货，持续等待提示人工检查，不自动解死锁。

Day25 新增步边界设备故障、原任务维修与取货前运输取消，见 [Day25 验收报告](reports/day-25-acceptance.md) 与 [ADR0016](docs/adr/0016-phase-preserving-device-recovery.md)。载货故障显示 NEEDS_RECOVERY，保留TRANSIT/容量/通道许可；维修不重开取放，载货取消409。取货前取消释放业务预占但不挪车、不清设备故障；取消运输保留终态历史，不是出库整单取消/重开，已取消来源不可重新领取。不含 Day26 充电或真实设备控制。

Day24 受控通道封锁与有界重规划，见 [Day24 验收报告](reports/day-24-acceptance.md) 与 [ADR0015](docs/adr/0015-controlled-closures-and-bounded-replanning.md)。操作员输入空闲格与原因，可封锁/解封；动态 revision 独立于静态布局版本。有路绕行，无路/预算耗尽暂停告警并保留在途货物和资源，只在新地图变化时重试，旧计算不能覆盖新状态。不保证无死锁。

Day23 单容量通道与工作站资源许可，见 [Day23 验收报告](reports/day-23-acceptance.md) 与 [ADR0014](docs/adr/0014-physical-resource-permits.md)。进入前申请、确认出清后释放，故障/空闲占格不随进程租约过期释放；配置保存后不可重置，不提供自动充电或无死锁保证。

Day22 已完成多车分配与保守下一步协调。main 支持显式初始化 3–5 台软件车、持久唯一归属、同事务批次取放和占格/等待展示，见 [Day 22 验收报告](reports/day-22-acceptance.md) 与 [ADR 0013](docs/adr/0013-persistent-fleet-coordination.md)。不保证无死锁，不含 Day 23 通道许可。上一阶段标签 `v0.3-single-robot` 仍归档 Day 21，不覆盖旧版本。[40.64 秒完整录像](reports/day-21-demo.webm)、[Day 21 验收报告](reports/day-21-acceptance.md) 与 [v0.3 发布说明](docs/releases/v0.3-single-robot.md) 展示收货、质检、上架、出库搬运、人工发运和 TRANSIT/最终对账。版本以 Git 标签归档，不代表部署、产品级暂停/历史回放或多车避碰。Day 20 已完成整单上架与人工发运。新增质检放行后 QC → TRANSIT → STORAGE 单车搬运，目标容量/批次预留与来源预占同事务建立；上架落货后可用于出库分配。出库页支持整单到齐暂存区后人工确认发运，网络结果不确定时原参数重试不重复扣货。详见 [Day 20 验收报告](reports/day-20-acceptance.md) 和 [ADR 0012](docs/adr/0012-putaway-and-operator-dispatch.md)。Day 19 持久 runner、tick 与事件水位继续复用。PostgreSQL 保存检查点、owner lease、epoch 和提交序号；旧 runner、旧 tick 或旧状态版本不能覆盖已提交状态。入库、出库、盘点、运输及仓库资料写入使用统一仓库/runtime 提交锁，取放、检查点和事件同事务提交。真实 API 停止/重启续跑与限制见 [Day 19 验收报告](reports/day-19-acceptance.md) 和 [持久运行设计](docs/adr/0011-persistent-runtime-and-events.md)。Day 19 当时前端每 250ms 轮询，仅显示已确认轨迹；取放到达暂存区后不自动发运。纯核心与 A* 见 [Day 17](reports/day-17-acceptance.md)、[Day 16](reports/day-16-acceptance.md)，导航网格见 [Day 15](reports/day-15-acceptance.md)。收货、质检、预占、盘点和台账已接入 PostgreSQL。Day 14 阶段演示见 [v0.2-wms 发布说明](docs/releases/v0.2-wms.md)。

## 开发

应用使用 Node **22.14.0**、pnpm **11.25.0**（见 `.nvmrc`、`packageManager`）。Day 2 本机 pnpm 启动器自身已更新到 Node 24.22.1，因此 engines 允许 24.19 以上的 24.x；实际应用与测试通过 PATH 使用 Node 22.14.0。用 `pnpm exec node --version` 检查应用脚本运行时。

```powershell
pnpm install --frozen-lockfile
pnpm db:generate
pnpm setup:local
pnpm db:local
```

`setup:local` 创建含随机密码的根 `.env`，已有该文件时拒绝覆盖。`db:local` 启动 npm 包提供的真实 PostgreSQL，保持该终端运行；Windows 二进制缓存及数据位于系统 TEMP 下的 `warehouse-twin-pg-18.6.0-beta.19` / `warehouse-twin-dev-day02`，不会安装系统服务。TEMP 数据可能被系统清理，仅用于本地演示。其他平台使用 `.local/postgres-dev`，本次未验证。

另开终端：

```powershell
pnpm db:migrate
pnpm seed
pnpm reconcile
pnpm dev
```

登录账户为 `admin@demo.local`、`operator@demo.local`、`viewer@demo.local`，均只可访问空间 A；`other@demo.local` 只可访问空间 B。密码在本地 `.env` 的 `DEMO_PASSWORD`。seed 必须提供至少 12 字符密码，重复执行不会改写已有密码或仓库资料。不要把 `.env`、会话 Cookie、数据库目录提交到仓库。

如果已有 Docker，替代 `pnpm db:local` 执行 `docker compose --env-file .env -f infra/compose.yaml up -d postgres`。基础服务 `postgres:18.6` 绑定 127.0.0.1:5432，不能与便携实例同时占用该端口。Compose 数据保存在命名卷。运行 `pnpm db:migrate` 和 `pnpm seed` 后，可选择在同一个 Compose 项目启用后台日报：

```powershell
docker compose --env-file .env -f infra/compose.yaml --profile reports up -d --build report-worker
```

`reports` profile 启动内网 Redis 与独立 worker；默认不启用，不提供外部 Redis 端口。发运后用授权的数据库账号查看 `"DispatchReportJob"` 的 `result` / `completedAt`；值为 `NULL` 表示未完成，不等同于未发运。已存在的历史发运不回填待办。

Day37 升级前先停旧 `report-worker`，运行 `pnpm db:generate`、`pnpm db:migrate` 并重建 worker。若日报未完成且 `lastFailedGeneration` 等于 `generation`，先排除故障，再用授权账号、显式设置目标 `DATABASE_URL`，在构建后执行 `pnpm --filter @warehouse-twin/api reports:retry <待办UUID> <当前失败代次>`。命令不读取隐式 `.env`，不删除 Redis 任务；重复或过期请求退出码为 2 且无写入。

打开 [前端](http://127.0.0.1:5173)，[API 存活检查](http://127.0.0.1:3000/health)。两端只绑定本机地址。Vite 将 `/api/health` 转发为 API `/health`；不用跨域配置。API 启动时读取根目录 `.env`，也可通过进程环境变量覆盖；修改端口时同时修改 `API_PROXY_TARGET` 并重启服务。

页面支持登录、刷新权限、到期/401 清除登录状态、退出，以及获授权仓库名称更新。viewer 表单只读，服务端同时拒绝写入；admin/operator 修改须提供原因和当前版本，冲突返回 409。请求有 8 秒超时。`/health` 是存活检查，不检测 DB。数据库不可用时身份与仓库请求不会返回假数据。

登录后由路由进入获授权仓库。Query 按用户/空间/仓库缓存配对快照，Zustand 只保存页面选择/图层；接口版本不一致时重取一次，失败不显示旧库存或假默认值。点选货位查看详情，货架遮挡不穿透；可用搜索或 2D 列表选择。区域筛选只影响展示，不改库存或障碍。无 WebGL 时可直接使用 2D 列表。

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke --dev-api
pnpm smoke --dev-api --with-auth
pnpm test:unit
pnpm test:integration
```

`pnpm check` 顺序执行 lint、typecheck、build；首次安装先执行 `pnpm db:generate`。`pnpm smoke` 在构建后自动启动临时 API 和 Vite dev server，验证健康响应、前端 HTML、TSX 转换、匿名 401 与代理，并清理进程；`--dev-api` 改用 tsx 从源码启动 API；`--with-auth` 读取本地 `.env`，需要已迁移、seed 且正在运行的开发库，再验证代理登录/退出。需空闲 13000 / 15173 端口。这些不是浏览器交互或 WebGL 测试。

`pnpm test:unit` 先构建共享契约，再运行 Vitest，输出 `reports/unit.json`。`pnpm test:integration` 自动构建契约/API，在 15432 启动全新 PostgreSQL 测试集群，迁移、重复 seed，再执行 Jest/Supertest。API 测试占用 13001 / 13002；随机密码与独立 `warehouse_twin_test` 不读取或清空开发库。最后重启 DB、重算全部余额并关闭服务。临时文件保留于 TEMP，原始证据为 `reports/integration-jest.json`、`reports/integration-environment.json`、`reports/integration-inventory.json`（忽略入 Git），历史日报保留当时结果。

Day 8 集成新增同一临时集群内的 `warehouse_twin_inbound_test` 和 API 13003，单独迁移/seed，防止入库测试数据改变旧授权/库存固定样例；重启后分别对账，两库证据在 `integration-inventory.json` 的 `databases` 中。既有开发库升级先 `pnpm db:generate`、`pnpm db:migrate`，不使用 reset。

Day 9 出库集成沿用上述写测试库，API 使用 13005，每例独立建仓。重启后除原 onHand 流水对账，还调用 `reconcileReservations`，核对余额 reserved 与有效分配合计、订单数量与分配合计；顶层 consistent 同时要求两类差异为零。

Day 10 在同一写测试库直接调用 Nest 内部过账服务，每例独立建仓。目标容量由 READY、IN_TRANSIT 任务占用。暂存保留订单预占，发运才扣减仓内现存。重启对账增加在途归属、阶段预占和暂存容量检查。领域约束见 [ADR 0007](docs/adr/0007-transport-ledger.md)。

Day 11 使用同一写测试库和临时 API 13006 验证盘点。侧栏“盘点与审批”支持当前布局中的储位与出库暂存位。管理员和操作员可开盘和录数，管理员批准或拒绝。HTTP 使用仓库前缀下的 `GET/POST count-orders` 和 `POST count-orders/:orderId/submit|approve|reject`，写请求沿用 `key` 和 `reason`。冻结保护与过账约束见 [ADR 0008](docs/adr/0008-inventory-count.md)。

Day 12 使用同一写测试库和临时 API 13007 验证台账。仓库管理员和操作员可从侧栏打开“仓库台账”。仓库前缀下的 `GET wms` 支持流水类型、批次和各自的流水及审计游标，每页 25 条。`GET wms/reconcile` 只读取当前仓库并返回差异。台账的过期、7 天内到期与质检隔离预警使用该请求的同一时间点。

入库入口为侧栏“仓库名 入库与质检”，API 前缀 `/spaces/:spaceId/warehouses/:warehouseId/inbound-orders`：GET 列表/选择项、POST 创建、POST `:orderId/receive`、POST `:orderId/inspect`。写请求带 `key` 和 `reason`，质检另带 `decision=PASS/REJECT`；只允许 admin/operator。日期是 UTC，页面选择的到期日从零点开始到期。收货可接收过期批次到 HOLD，但放行会拒绝。收货/质检只支持全量；放行后的整单上架在场景“软件机器人”选择“质检放行上架”，仍为软件模拟。外部变化仍手动刷新，自己的操作成功后精确重读相关 Query。

出库入口为侧栏“仓库名 出库与预占”，API 前缀 `/spaces/:spaceId/warehouses/:warehouseId/outbound-orders`：GET 列表/推荐、POST 创建、POST `:orderId/allocate`、POST `:orderId/dispatch`。写请求带 `key`、`reason`，创建另带 `skuId`、`batchId`、`quantity`。创建不占库存；分配重新验证当前布局 STORAGE、RELEASED、未过期来源，同批不足整单拒绝，不自动跨批。QC 即使已放行也不计储存区可分配量，不能直接使用仓库汇总 available 代替。分配成功只增加 reserved，后续位置转移由运输阶段过账。分配和运输排除活动盘点冻结位置；跨刷新未知创建结果先刷新核对，预占后到期不自动释放。

浏览器复验：交互终端运行 `pnpm qa:browser`，使用独立临时 DB，不读取 `.env`。详见[验收说明](scripts/browser-checks/README.md)；当前已实测正常 Chrome 与禁用 WebGL 的独立会话。CLI 截图和快照保存在忽略的 `output/playwright/`，最终截图见 [Day 6 预览](reports/day-06-preview.png)。这不代表已完成跨设备性能测试。

Day 3 只读入口：`GET /api/spaces/:spaceId/warehouses/:warehouseId/layout` 与同前缀 `/inventory`（直接 API 端口不带 `/api`）。需要登录 Cookie，viewer 可读，跨仓返回 404。返回布局版本、货位/服务点、货架阻挡和真实批次余额；空位显式返回 0，待检或到期库存不计 available。两个请求组合时应核对 layoutId/version 一致。

每仓 seed 当前建立 17 个货位、2 SKU、2 批次与 11 条期初余额/流水，现存 62 件。数据来自[合成布局说明](data/layouts/README.md)。`pnpm reconcile` CLI 在同一只读快照中用流水重算现存，并核对预占、订单、在途归属和暂存容量。任一组有差异以非零退出。已有本地数据库先执行 `pnpm db:generate`、`pnpm db:migrate`、`pnpm seed` 再启动。

所有 HTTP 写请求（包括登录/退出）要求 `X-Requested-With: WarehouseTwin`，浏览器 Origin 还须命中 `WEB_ORIGINS`。开发使用 HttpOnly / SameSite=Strict Cookie；生产自动 Secure，需 HTTPS。登录尝试限制为单进程/IP 每分钟 10 次，不依赖 Redis。

单独运行构建后的 API：`pnpm --filter @warehouse-twin/api start`。前端构建产物为 `apps/web/dist`，API 为 `apps/api/dist`。`vite preview` 仅预览静态文件，完整部署的 `/api` 反向代理留到部署阶段。

## 范围和记录

- [范围、四模块边界、坐标与数量单位](docs/adr/0001-scope-and-coordinates.md)
- [Day 1 进度与验证](docs/devlog/day-01.md)
- [身份与仓库授权决策](docs/adr/0002-identity-and-warehouse-access.md)
- [Day 2 开发日志](docs/devlog/day-02.md)
- [Day 2 验收报告](reports/day-02-acceptance.md)
- [布局与库存模型决策](docs/adr/0003-layout-and-inventory-foundation.md)
- [Day 3 开发日志](docs/devlog/day-03.md)
- [Day 3 验收报告](reports/day-03-acceptance.md)
- [场景、数据与交互决策](docs/adr/0004-scene-data-and-interaction.md)
- [Day 4 日志](docs/devlog/day-04.md) · [验收报告](reports/day-04-acceptance.md)
- [Day 5 日志](docs/devlog/day-05.md) · [验收报告](reports/day-05-acceptance.md)
- [Day 6 日志](docs/devlog/day-06.md) · [验收报告](reports/day-06-acceptance.md)
- [Day 7 日志](docs/devlog/day-07.md) · [验收报告](reports/day-07-acceptance.md) · [演示录像](reports/day-07-demo.webm)
- [入库与质检事务决策](docs/adr/0005-inbound-and-inspection.md)
- [Day 8 日志](docs/devlog/day-08.md) · [验收报告](reports/day-08-acceptance.md)
- [出库与预占事务决策](docs/adr/0006-outbound-allocation.md)
- [Day 9 日志](docs/devlog/day-09.md) · [验收报告](reports/day-09-acceptance.md)
- [搬运账本与暂存容量](docs/adr/0007-transport-ledger.md)
- [Day 10 日志](docs/devlog/day-10.md) · [验收报告](reports/day-10-acceptance.md)
- [盘点冻结与审批](docs/adr/0008-inventory-count.md)
- [Day 11 日志](docs/devlog/day-11.md) · [验收报告](reports/day-11-acceptance.md)
- [Day 12 日志](docs/devlog/day-12.md) · [验收报告](reports/day-12-acceptance.md)
- [Day 13 日志](docs/devlog/day-13.md) · [验收报告](reports/day-13-acceptance.md)
- [Day 14 日志](docs/devlog/day-14.md) · [验收报告](reports/day-14-acceptance.md) · [WMS 录像](reports/day-14-demo.webm)
- [项目总计划](doc/planning/WarehouseTwin-项目总计划.md)
- [56 天每日计划](doc/planning/WarehouseTwin-56天每日计划.md)
- [面试与 AI 协作](doc/planning/WarehouseTwin-面试与AI协作手册.md)

原始计划在 `doc/planning`，保留原路径；新增工程文档在 `docs`。沿用当前 `node-react-three` 工作区，逻辑项目名为 WarehouseTwin。[GitHub 仓库](https://github.com/JoeyXXia/threejs)；阶段发布通过 Git 标签追溯，具体提交和同步状态以 Git 为准。

## Day 22 多车使用

已有库升级先停止旧 API，执行 `pnpm db:generate`、`pnpm db:migrate`，再启动应用；不要 reset。未启用多车的仓库继续使用旧单车流程。在场景中输入原因并初始化 3–5 台车；只能在旧单车没有活动/异常任务时切换，保留旧位置、电量和 tick。初始化后不能重置车队或改车数来丢弃任务。

接口位于仓库前缀下：`GET fleet`、`POST fleet/initialize`（count/reason）、`POST fleet/assign`（robotId/kind/reason 与既有来源/目标 ID）。GET 对 viewer 开放，POST 仅 admin/operator；调用方不能指定 actor、路径、tick 或库存。分配与固定优先级/等待排序由后端决定。取/放继续走原领域唯一动作键，发运仍在出库页面人工确认。

空闲、已完成和 ERROR 车继续占格；同一出入口/目标可能出现真实对向等待，页面展示 OCCUPIED、EDGE_SWAP、TARGET_CONFLICT 及阻挡车/等待 tick。无自动挪车、重新规划、恢复操作台或无死锁承诺。不要手改数据库解除货物预占；相关资源与恢复机制在后续计划实施。
