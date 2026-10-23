# WarehouseTwin

WMS 业务驱动的智能仓库数字孪生演示系统。设备为软件模拟；未来业务库存将由后端 PostgreSQL 真实持久化。

当前进度：Day 1 工程骨架，提供 React 页面与 Nest `GET /health`。尚未实现数据库、认证、库存、3D 场景、调度或回放。

## 开发

应用使用 Node **22.14.0**、pnpm **11.25.0**（见 `.nvmrc`、`packageManager`）。本机 pnpm 启动器自身携带 Node 24.19.0，因此 engines 同时允许该版本；实际脚本通过 PATH 使用 Node 22.14.0。其他机器先安装匹配工具链；用 `pnpm exec node --version` 检查应用脚本运行时。

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm dev
```

打开 [前端](http://127.0.0.1:5173)，[API 存活检查](http://127.0.0.1:3000/health)。两端只绑定本机地址。Vite 将 `/api/health` 转发为 API `/health`；不用跨域配置。API 启动时读取根目录 `.env`，也可通过进程环境变量覆盖；修改端口时同时修改 `API_PROXY_TARGET` 并重启服务。

页面连接检查有 5 秒超时、失败文本与重试入口。`/health` 是存活检查，不检测 DB。`.env` 不提交；`.env.example` 无秘密，不放前端密钥。

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke --dev-api
```

`pnpm check` 顺序执行前三项。`pnpm smoke` 在构建后自动启动临时 API 和 Vite dev server，验证健康响应、前端 HTML、TSX 转换与代理，并清理进程；`--dev-api` 改用 tsx 从 TypeScript 源码启动 API。需可用的 13000 / 15173 端口。它不是浏览器 UI / WebGL 测试。

单独运行构建后的 API：`pnpm --filter @warehouse-twin/api start`。前端构建产物为 `apps/web/dist`，API 为 `apps/api/dist`。`vite preview` 仅预览静态文件，完整部署的 `/api` 反向代理留到部署阶段。

## 范围和记录

- [范围、四模块边界、坐标与数量单位](docs/adr/0001-scope-and-coordinates.md)
- [Day 1 进度与验证](docs/devlog/day-01.md)
- [项目总计划](doc/planning/WarehouseTwin-项目总计划.md)
- [56 天每日计划](doc/planning/WarehouseTwin-56天每日计划.md)
- [面试与 AI 协作](doc/planning/WarehouseTwin-面试与AI协作手册.md)

原始计划在 `doc/planning`，保留原路径；新增工程文档在 `docs`。沿用当前 `node-react-three` 工作区，逻辑项目名为 WarehouseTwin。当前目录初始无 Git 仓库，未自动创建远程或伪造提交记录。
