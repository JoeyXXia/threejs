# 浏览器验收（Playwright CLI）

这些 `.js` 是 CLI `run-code --filename` 接受的单一 async 函数表达式，不是 `@playwright/test` spec。仅使用独立临时 QA DB / 浏览器，不读开发 `.env` 或个人浏览器。

1. 先 `pnpm db:generate`、`pnpm build`。交互终端运行 `pnpm qa:browser`，等 `QA READY`。不要管道运行：stdin 结束会清理服务。
2. QA 地址 `http://127.0.0.1:15174`，API 13004，临时 PostgreSQL 15434。账户 `admin@demo.local`，公开测试夹具密码 `browser-fixture-only-2026`；该密码仅对这个临时集群有效，不是开发凭据。QA 额外授予该用户 B 仓只读及一个真正空库存仓，生产 seed 不包含这些权限。
3. 在 `output/playwright/day-04` 目录使用独立命名 CLI 会话；先 snapshot，再按当前 ref 登录。不要把 Cookie/存储状态或开发口令写到日志。

```powershell
npx --yes --package @playwright/cli playwright-cli -s=warehouse-qa open http://127.0.0.1:15174/ --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=warehouse-qa snapshot
# 使用当前表单 ref 登录后：
npx --yes --package @playwright/cli playwright-cli -s=warehouse-qa run-code --filename ../../../scripts/browser-checks/selection.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-qa run-code --filename ../../../scripts/browser-checks/raycast.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-qa run-code --filename ../../../scripts/browser-checks/navigation.js
```

`selection.js` 固定 seed=20261102 抽 10 位并与 API 对照；`raycast.js` 验证真实鼠标点击、空位和遮挡；`navigation.js` 验证快速移动、筛选、resize、context loss、切仓、空仓、HTTP 503 和恢复。HTTP 503 只在该浏览器上下文注入，不修改后端。

QA 终端命令：`layout-v2` 发布 R01 移动两格的新版本，随后用 `layout-refresh.js` 验证；`reserve` 仅修改 QA 一个余额的 reserved=2，随后用 `capture.js` 对照详情并生成 `reports/day-06-preview.png`；`expire` 使 QA 会话过期；`stop` 关闭 DB/API/Vite 并保留临时数据文件。

冷启动无 WebGL：给另一个命名会话使用 config `{ "browser": { "launchOptions": { "headless": true, "args": ["--disable-webgl"] } } }`，打开登录页并 snapshot 后执行 `cold-webgl.js`。它会等待渲染降级提示、验证 WebGL2=null，再读取 2D 的 17 行和批次详情。

CLI 截图/快照位于忽略的 `output/playwright/`；只关闭本次命名会话，不用 `kill-all` 影响其他浏览器。图像差异不用于判断相机是否完成，验收使用完成标记和实际目标。

最后可在仓库页运行 QA 终端 `expire`，再执行 `session-expiry.js`；验证返回登录表单且清除 Canvas 与库存汇总。此检查会结束当前测试登录状态。

## Day 7 演示与持久化

新启动普通 QA 环境，勿执行 `reserve`/`layout-v2`/`expire`。在 `output/playwright/day-07` 打开独立 `warehouse-day7` Chrome 会话，snapshot 后使用当前 ref 登录。登录后先读取场景快照，再执行：

```powershell
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day7 video-start day-07-demo.webm --size=1440x1100 --fps=25
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day7 run-code --filename ../../../scripts/browser-checks/day7-demo.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day7 video-stop
```

逐条检查成功后才执行下一条，尤其不要把回调通过当作录像成功。缺 ffmpeg 时用 `npx --yes --package @playwright/cli -c "playwright install ffmpeg"` 安装测试工具二进制；失败的 video-start 若保留状态，先 video-stop，再重新开始。保存后确认文件实际存在且可解码。

回调先对照 API 和真实 raycast 的两个货位，再逐行核对全部 17 行，执行整页 reload 并重新对照布局/库存（只排除 asOf）与 UI 汇总。末尾验证 HOLD 详情并截图；暂停仅为录像阅读节奏，不用固定延迟替代就绪断言。文件在当前目录，录屏没有开发 Cookie/数据库密码；结束后只关闭该会话并在 QA 终端执行 `stop`。
