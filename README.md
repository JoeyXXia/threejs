# WarehouseTwin

WMS 业务驱动的智能仓库数字孪生演示系统。设备为软件模拟；未来业务库存将由后端 PostgreSQL 真实持久化。

当前进度：Day 2，已接入 PostgreSQL / Prisma、数据库会话、三种仓库角色、空间隔离和资料修改审计。尚未实现库存、3D 场景、调度或回放。

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
pnpm dev
```

登录账户为 `admin@demo.local`、`operator@demo.local`、`viewer@demo.local`，均只可访问空间 A；`other@demo.local` 只可访问空间 B。密码在本地 `.env` 的 `DEMO_PASSWORD`。seed 必须提供至少 12 字符密码，重复执行不会改写已有密码或仓库资料。不要把 `.env`、会话 Cookie、数据库目录提交到仓库。

如果已有 Docker，替代 `pnpm db:local` 执行 `docker compose --env-file .env -f infra/compose.yaml up -d`。Compose 只含 `postgres:18.6`；同样绑定 127.0.0.1:5432，不能与便携实例同时占用该端口。Compose 数据保存在命名卷，今天未在本机执行验证。

打开 [前端](http://127.0.0.1:5173)，[API 存活检查](http://127.0.0.1:3000/health)。两端只绑定本机地址。Vite 将 `/api/health` 转发为 API `/health`；不用跨域配置。API 启动时读取根目录 `.env`，也可通过进程环境变量覆盖；修改端口时同时修改 `API_PROXY_TARGET` 并重启服务。

页面支持登录、刷新权限、到期/401 清除登录状态、退出，以及获授权仓库名称更新。viewer 表单只读，服务端同时拒绝写入；admin/operator 修改须提供原因和当前版本，冲突返回 409。请求有 8 秒超时。`/health` 是存活检查，不检测 DB。数据库不可用时身份与仓库请求不会返回假数据。

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke --dev-api
pnpm smoke --dev-api --with-auth
pnpm test:integration
```

`pnpm check` 顺序执行 lint、typecheck、build；首次安装先执行 `pnpm db:generate`。`pnpm smoke` 在构建后自动启动临时 API 和 Vite dev server，验证健康响应、前端 HTML、TSX 转换、匿名 401 与代理，并清理进程；`--dev-api` 改用 tsx 从源码启动 API；`--with-auth` 读取本地 `.env`，需要已迁移、seed 且正在运行的开发库，再验证代理登录/退出。需空闲 13000 / 15173 端口。这些不是浏览器交互或 WebGL 测试。

`pnpm test:integration` 自动构建 API，在 15432 启动全新 PostgreSQL 测试集群，迁移、重复 seed，然后执行 Jest/Supertest。API 测试占用 13001。测试使用随机密码和 `warehouse_twin_test`，不读取或清空开发库；结束时关闭 API 与数据库。临时数据库文件保留在系统 TEMP，原始测试结果输出到 `reports/day-02-jest.json`、`reports/day-02-environment.json`（均忽略入 Git）；可审查报告见下方。

所有 HTTP 写请求（包括登录/退出）要求 `X-Requested-With: WarehouseTwin`，浏览器 Origin 还须命中 `WEB_ORIGINS`。开发使用 HttpOnly / SameSite=Strict Cookie；生产自动 Secure，需 HTTPS。登录尝试限制为单进程/IP 每分钟 10 次，不依赖 Redis。

单独运行构建后的 API：`pnpm --filter @warehouse-twin/api start`。前端构建产物为 `apps/web/dist`，API 为 `apps/api/dist`。`vite preview` 仅预览静态文件，完整部署的 `/api` 反向代理留到部署阶段。

## 范围和记录

- [范围、四模块边界、坐标与数量单位](docs/adr/0001-scope-and-coordinates.md)
- [Day 1 进度与验证](docs/devlog/day-01.md)
- [身份与仓库授权决策](docs/adr/0002-identity-and-warehouse-access.md)
- [Day 2 开发日志](docs/devlog/day-02.md)
- [Day 2 验收报告](reports/day-02-acceptance.md)
- [项目总计划](doc/planning/WarehouseTwin-项目总计划.md)
- [56 天每日计划](doc/planning/WarehouseTwin-56天每日计划.md)
- [面试与 AI 协作](doc/planning/WarehouseTwin-面试与AI协作手册.md)

原始计划在 `doc/planning`，保留原路径；新增工程文档在 `docs`。沿用当前 `node-react-three` 工作区，逻辑项目名为 WarehouseTwin。[GitHub 仓库](https://github.com/JoeyXXia/threejs)已包含 Day 1 提交；Day 2 的实际修改与提交状态以本地 Git 为准。
