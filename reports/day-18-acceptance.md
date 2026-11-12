# Day 18 单车任务与确认段显示：验收报告

日期：2026-11-12（Asia/Shanghai）。起点提交：`4588a10d85e874d66a6b6f3b1516bd7c546fe523`。范围见 [日志](../docs/devlog/day-18.md)，权威/事务/同步边界见 [ADR 0010](../docs/adr/0010-single-robot-and-confirmed-poses.md)。

## 实测汇总

| 项目 | 本轮结果 |
| --- | --- |
| 安装 | `pnpm install --frozen-lockfile` 退出 0；只新增 API 对现有 simulation workspace 的链接，不升级依赖。 |
| 工程检查 | `pnpm check` 退出 0；lint、strict 类型检查及共享包/API/前端构建通过。最终浏览器回调就绪修正后又跑 `pnpm lint`，退出 0。 |
| 纯模拟与任务 | 2 个文件、19 项通过，包括原 16 项确定性测试和新增 3 项阶段测试。 |
| 前端与算法 | 11 个文件、62 项通过，包括新增 3 项确认段插值/低显示帧率输入/协议校验。原 BFS 对照保持通过。 |
| 真实 PostgreSQL | Node 15 项、Jest 6 套件 99 项，合计 **114 项通过**。新增机器人场景 7 项。 |
| 重启对账 | 两个隔离库真实重启后，`consistent=true`，现存流水、预占/订单、在途和暂存容量差异均为 0。 |
| 浏览器 | Playwright CLI 驱动独立 Chrome；最终业务回调、完成后整页刷新场景就绪检查、会话过期检查均通过。 |

单测总计 **81 项**。本地环境为 Node v22.14.0、PostgreSQL 18.6（x86_64-windows）。Chrome UA 为 HeadlessChrome/157.0.0.0，WebGL 扩展返回 `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002560) Direct3D11 vs_5_0 ps_5_0, D3D11)`。这里只记录实际标识，不将其视为性能测量。

## 数据库专项断言

1. 同一服务器任务经历四阶段，取货后 DB 阶段 IN_TRANSIT，卸货后 STAGED。两条运输流水，现存仍 62、预占仍 1；再执行 advance 不产生额外流水。
2. 读取、重复启动不改变 tick/任务 ID；并发启动只创建一个 TransportTask；重叠回调只前进一步。
3. viewer 启动 403、跨空间读取 404、body 伪造 actorId 400；撤销角色后下一步停止，tick 不前进。
4. 注入 take 失败：旧位置保留，载货 false，DB 仍 READY，无运输流水。注入 drop 失败：载货 true，DB 仍 IN_TRANSIT，仅已有取货流水；两者均通过对账。
5. 运输事务收到不匹配 expectedLayoutId 时，在写库存前拒绝；随后正确模拟仍能完成。
6. 新建空内存服务模拟重启：读不到旧运行；对于 DB 已 IN_TRANSIT 的任务重新启动返回 409，不从头取货。这是限制测试，不是恢复成功测试。

原始本地结果位于忽略的 `reports/simulation-unit.json`、`reports/unit.json`、`reports/integration-jest.json`、`reports/integration-transport.tap`、`reports/integration-environment.json`、`reports/integration-inventory.json`，不上传原始临时数据。

## 浏览器闭环

独立、全新 QA 数据库，仅用普通 seed，不调用 reserve/layout-v2 夹具。通过已有出库命令 API 创建并预占 1 件，再通过实际页面选择分配与 OUT-01，点击启动。

最终任务 `57059e6d-1a74-40b3-ba14-29852b3bac85`：

| 观测 | 结果 |
| --- | --- |
| 整页刷新 | 任务 ID 不变，tick 不倒退；完成后再次刷新仍 tick=47。额外等待 Canvas 模型和相机就绪后确认同一任务。 |
| 浏览器主线程阻塞 | 约 1100ms 有界阻塞前后，后端 tick 从 2 到 7，任务不依赖渲染循环推进。不是实际 FPS 统计。 |
| 载货与路线 | TRANSPORT 阶段显示载货、货箱及当前路线；最终为空载，位置 (27,3)，tick=47，逻辑 11750ms，电量 99.61%。 |
| 503 断流 | 面板显示陈旧，实际 Canvas 坐标/已确认 tick 保持在最后端点；后续显示帧未沿 route 外推。恢复后读取到最终完成状态。 |
| 库存 | 前后全仓 onHand=62、reserved=1；最终 available=54、HOLD=7，OUT-01 预占 1 件；在线对账 consistent=true。未执行 dispatch。 |
| 只读与会话 | B 仓按钮禁用，直接启动请求 403；返回 A 仓仍是原任务。测试会话到期后，机器人面板和 Canvas 均被移除。 |

截图已逐张检查：

- [载货与路线](day-18-carrying.png)
- [断流后的确认端点](day-18-stale.png)
- [刷新后的完成任务与场景](day-18-completed.png)

## 复验命令

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test:unit
pnpm test:integration
pnpm qa:browser
# 等 QA READY；另开终端，从仓库根目录运行：
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day18 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day18 run-code --filename scripts/browser-checks/day18-robot.js
# QA 终端输入 expire 后：
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day18 run-code --filename scripts/browser-checks/day18-session-expiry.js
# 验收后关闭独立浏览器，并在 QA 终端输入 stop
```

机器人主回调要求全新 QA 库；创建/预占的夹具是真实业务命令，不会自动重置旧数据。环境变量固定临时数据库、端口和公开测试凭据，不使用开发数据或开发登录密码。

收尾环境问题：QA 包装器缺少临时缓存的 pg_ctl.exe，stop 退出 1。确认残留 PID/端口/数据目录属于本轮 QA 后，使用原 npm 安装的 pg_ctl 正常停止该集群。最终检查因审批超时延迟到 2026-11-13，重试确认四个测试/QA 端口均无监听、PID 文件已移除。未强杀或操作开发库，缓存缺失根因未确定。功能验收仍采用 11 月 12 日的实测，未冒填 13 日复测结果。

## 边界与限制

- **仅单 API 进程**，内存保存位置、tick 和阶段；无持久 checkpoint、lease、epoch 或数据库事件水位，无法安全多实例运行。Day 19 再实现，不提前宣称完成。
- DB 过账与内存发布并非一个原子提交。若进程在提交后退出或收到不确定数据库结果，必须停止并人工检查，不能凭客户端到达通知补账。本轮测试失败停止和拒绝重初始化，不代表可恢复。
- 单车、静态布局、单条 allocation；无多车避碰、动态封路、充电/低电量调度。装卸各 4 tick、250ms 轮询和 1500ms 陈旧阈值为演示选择，未做性能调优。
- `useFrame` 仅更新显示 ref，面板定时器只更新陈旧提示。5/30/60/144 FPS 的纯函数输入对照不是硬件 FPS 测量；未开展长时间 FPS、tick 耗时、大地图或多仓吞吐基准。
- 背景标签页可能暂停轮询/渲染；返回后按服务器状态重读。未开展跨浏览器、移动端或断网重放专项测试。
- 保留构建的 >500kB chunk 提示及浏览器 Three.Clock 弃用警告；预期的匿名/到期 401、模拟 503 和 viewer 403 不是未说明的失败。
- 历史 PDF、用户已有 output/tmp 不上传。无新标签、发布或部署；远程 CI 结果须推送后另查，未当作本轮本地证据。
