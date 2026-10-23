# Day 01：范围、坐标与工程骨架

日期：2026-10-23（Asia/Shanghai）。对应原计划 Day 1，未进入 Day 2。

## 可观察目标与结果

- [x] 阅读 `doc/planning` 的项目总计划、56 天每日计划、面试与 AI 协作手册。用户指向的 `docs/planning` 实际不存在，保留原始文件位置，通过 README 链接。
- [x] ADR 0001 记录入库→质检→上架→出库搬运→发运故事、四模块边界、不做项、网格/世界坐标和整数件单位。
- [x] pnpm workspace：React/Vite 与 Nest API；基类 TypeScript strict、额外索引/可选属性检查、ESLint。
- [x] `GET /health` 提供服务存活响应；前端实际请求经代理读取，支持超时、失败提示、重试和 effect 清理。
- [x] `.env.example`、`.gitignore`、README 启动说明、精确版本及锁文件。
- [x] 前后端构建与启动验收，结果如下。

Day 1 范围完成。WMS/DB、认证、3D 场景、Query/Zustand、机器人、Socket、回放、CI 都尚未实现；未安装数据库或队列依赖。今天没有任何库存数据，不能把 `/health` 成功当作 T01–T16 通过。

## 实际环境与验证

Windows / PowerShell。应用 Node v22.14.0，pnpm 11.25.0；pnpm 启动器自身使用捆绑 Node v24.19.0。应用运行时由 `pnpm exec node --version` 确认。直接依赖见 package.json，全部传递依赖见 pnpm-lock.yaml。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，3 个 workspace projects，Already up to date |
| `pnpm lint` | 通过，0 warnings；最后修改 smoke 后复跑通过 |
| `pnpm typecheck` | web/API 均通过 |
| `pnpm build` | Nest tsc 和 Vite production build 均通过；Vite 转换 16 个模块 |
| `pnpm check` | lint → typecheck → build 整体通过 |
| `pnpm smoke` | 通过；构建后的 Nest、Vite 开发服务器、健康 JSON、404、页面 HTML、React 模块转换、API 代理 |
| `pnpm smoke --dev-api` | 通过；tsx 直接执行 TypeScript API 源码，并重复上述 HTTP 验证 |

HTTP 验证使用临时端口 13000、15173，脚本 finally 关闭服务。测试健康 JSON：`{"status":"ok","service":"warehouse-twin-api","devices":"simulated"}`。未进行浏览器交互、WebGL、数据库、性能或业务不变量测试；无地图版本和 seed（尚无模拟器）。未将计划中的规模或 FPS 当作实测成果。

## 发现的问题与修正

1. 沙箱中 npm 访问 `127.0.0.1:7890` 代理返回 EACCES；通过受审核的外部网络执行查询/安装完成。严格 peer 检查通过。React 19 配 R3F 9、Drei 10，未套用 React 18 的教程组合。
2. pnpm 11 的项目设置应写入 `pnpm-workspace.yaml`。最初 `.npmrc` 的 store 配置未按预期生效，已删除该配置，改用 YAML `storeDir: .pnpm-store` 并重新安装；依赖缓存被 gitignore 忽略。
3. 终端 Node 与 pnpm 启动器 Node 不同；起初以为脚本使用 24.19，实际 `pnpm exec node --version` 和 smoke 错误栈均显示 22.14，已修正 `.nvmrc`、engines 和说明。engines 允许启动器的 24.19，但未把它记为应用实测版本。
4. 第一次 smoke 中两个服务均成功启动，沙箱 HTTP 访问却超时；在允许本机网络访问的执行环境复验，两种 API 启动方式均通过。这是执行环境限制，不以服务启动日志替代 HTTP 成功断言。
5. 收尾保存曾因自动审批服务达到用量限制而未执行；用户要求继续后重新检查文件并补写本日志。

## 状态权威和今天的边界

`/health` 无业务写操作，今天没有数据库事务和同步协议。前端只有连接状态与重试计数，检查 JSON 时将网络数据视为 unknown 并验证关键字段。后续库存以 PostgreSQL 为权威；设备为模拟；动画完成不得决定任务或发运结果。ADR 已固定这些边界。

## AI 协作与独立学习

AI 完成计划阅读、骨架代码、工具链核对、验证和文档初稿。实现选择：保留最小目录，没有预建空 packages，没有提前实现 3D、数据库或 Redis。用户明确收窄为“先只做 Day 1”，已遵守。用户尚未亲自审查/修改代码，未替用户声称已独立掌握概念。

建议独立口述：React / R3F / Three.js 分别负责什么；库存权威为何不能在前端；运输完成为何不等于发运；`(2,3)` 为何映射到格心 `(2.5,0,3.5)`。这些是学习提示，尚未验收回答。

## Issue / PR / 提交

初始目录没有 `.git`。用户随后要求提交到 GitHub，已初始化本地 `main` 分支并准备首个 Day 1 提交，包含计划、范围文档、骨架、锁文件和启动验证；未包含依赖缓存、构建产物或实际 `.env`。远程仓库地址待用户提供，尚未创建 PR。提交 SHA 以 Git 实际记录为准。

## 下次第一步

### 本地启动补验

用户要求本地运行后，发现根目录 `pnpm dev` 的单引号路径 filter 在 Windows 脚本环境下无法匹配包。已改为包名 filter `@warehouse-twin/*`，实际启动确认同时运行 `tsx watch` 与 Vite，分别监听 3000 / 5173。此前 smoke 的直接服务启动没有覆盖这个根命令，故补记该缺口与修复。开发服务器在本机执行环境中运行，避免沙箱隔离导致外部浏览器访问超时。

等用户要求进入 Day 2 后，先核对 PostgreSQL 运行环境及 Prisma/Node 兼容版本，再实现数据库、身份和仓库授权。今天停止在 Day 1。
