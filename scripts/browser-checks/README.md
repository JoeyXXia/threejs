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

## Day 8 入库与质检

启动新的 `pnpm qa:browser` 临时环境。以下命令从仓库根目录执行，用独立会话 `warehouse-day8` 打开 QA 地址、snapshot 后按当前 ref 登录；不运行 reserve/layout-v2 夹具命令。

```powershell
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day8 open http://127.0.0.1:15174 --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day8 snapshot
# 按当前 ref 登录后读取场景 snapshot，再依次运行：
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day8 run-code --filename scripts/browser-checks/day8-inbound.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day8 run-code --filename scripts/browser-checks/day8-access.js
# QA 终端执行 expire，保持在 A 仓入库页，再运行：
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day8 run-code --filename scripts/browser-checks/day8-session-expiry.js
```

inbound 回调真实提交两单，验证后端收货成功却丢失响应后的原 key 重试、3 件放行、2 件过期拒绝、整页重载及 3D/2D/API 对照。普通 seed 首次执行结果为现存 67、可用 58、预占 0、HOLD 9；重复执行会新建不同批次并增加数量，不是重置脚本。access 验证 B 仓只读及切仓隔离；expiry 验证清单/表单退出。截图在 `output/playwright/day-08`，仅合成测试记录，不包含开发口令。截图核对后可复制到 reports 作为证据；结束关闭本次会话并向 QA 终端发送 stop。

## Day 9 出库与预占

启动新的 `pnpm qa:browser` 临时环境，不执行 reserve/layout-v2，也不复用已经预占的旧 QA 数据。以下从仓库根目录执行，snapshot 后使用当前 ref 登录：

```powershell
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day9 open http://127.0.0.1:15174 --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day9 snapshot
# 登录并读取场景 snapshot 后，逐条执行：
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day9 run-code --filename scripts/browser-checks/day9-outbound.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day9 run-code --filename scripts/browser-checks/day9-access.js
# QA 终端执行 expire，保持在 A 仓出库页，再运行：
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day9 run-code --filename scripts/browser-checks/day9-session-expiry.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day9 close
# 最后向 QA 终端发送 stop。
```

outbound 回调要求起始 SKU-A/B01 储存区可分配 25，真实创建 18 件并预占；模拟后端已提交但响应丢失，验证原 key 重试只增加一次。再创建 8 件，验证剩余 7 件时整单拒绝；刷新后核对分配与 3D/2D/API，最终现存/可用/预占/HOLD 为 62/37/18/7。该脚本有实际写入，不能在同一库重复执行冒充首次验收。access 检查只读与切仓；expiry 检查退出后出库记录和表单清除。截图保存于 `output/playwright/day-09`，人工查看后复制到 reports；仅关闭本次命名浏览器，不影响其他会话。

## Day 11 盘点与审批

从仓库根目录启动新的 `pnpm qa:browser`，使用普通 seed。在独立会话打开 QA 地址，按快照中的表单登录。依次执行：

```powershell
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day11 open http://127.0.0.1:15174 --browser chrome
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day11 snapshot
# 按当前快照登录后运行
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day11 run-code --filename scripts/browser-checks/day11-count.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day11 close
# 最后向 QA 终端发送 stop
```

脚本冻结账面 9 件的储位，验证推荐下降、出库分配拒绝，录入 12 件并批准，然后拒绝空暂存位盘点。执行后重载验证终态，截图位于 `output/playwright/day-11`。每次执行需使用新 QA 库。
