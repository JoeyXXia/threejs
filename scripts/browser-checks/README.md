# 浏览器验收（Playwright CLI）

## Day 19 持久状态与事件水位

在全新 `pnpm qa:browser` 环境运行 `day19-runtime.js`。它通过既有出库命令准备 1 件预占，在页面启动单车，完成后刷新并核对页面/库存/事件水位、连续 seq 和最后事件中的 task/tick。等待真实 Canvas 和相机就绪后截图。真实后端进程重启及双客户端 fencing 由数据库集成测试覆盖，不用浏览器刷新冒充后端重启。命令、证据日期与限制见 [Day 19 报告](../../reports/day-19-acceptance.md)。结束关闭该测试会话并输入 stop。

## Day 18 单车任务

使用全新 `pnpm qa:browser`，从仓库根目录运行独立会话的 `day18-robot.js`。它通过已有命令 API 准备 1 件出库预占，在页面启动任务，验证刷新、浏览器有界阻塞、503 断流与恢复、库存守恒和只读权限。QA 终端输入 `expire` 后运行 `day18-session-expiry.js`，确认旧控件和场景清除。命令和实测结果见 [Day 18 报告](../../reports/day-18-acceptance.md)。回调要求普通 seed，不执行 reserve/layout-v2，也不在同一库重复创建样例后仍期待暂存位只有 1 件。结束仅关闭该测试会话并输入 stop。

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

## Day 12 台账与对账

从仓库根目录启动新的 `pnpm qa:browser`。使用新命名浏览器会话 `warehouse-day12` 打开 QA 地址并按快照登录管理员。依次运行下列脚本，结束时关闭该会话并向 QA 终端发送 `stop`。

```powershell
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day12 run-code --filename scripts/browser-checks/day8-inbound.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day12 run-code --filename scripts/browser-checks/day12-wms.js
```

先完成收货及质检，再通过出库页面预占 3 件，最后核对台账筛选、过期批次预警、审计和只读对账。截图位于 `output/playwright/day-12`。

## Day 13 库存与场景联动

从仓库根目录启动新的 `pnpm qa:browser`，以普通 seed 和独立会话 `warehouse-day13` 登录管理员，进入 A 仓场景，再运行以下命令。

```powershell
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day13 run-code --filename scripts/browser-checks/day13-scene.js
```

脚本收货 3 件，通过预警打开对应批次并对照 3D、2D 和详情。质检放行后再次检查同批次。最后拦截 A 仓请求后切到 B 仓，并用 503 验证错误恢复。截图位于 `output/playwright/day-13`。结束后关闭该浏览器会话并向 QA 终端发送 `stop`。

## Day 14 WMS 录像

启动新 `pnpm qa:browser`，在 `output/playwright/day-14` 打开独立 Chrome 会话 `warehouse-day14`。登录测试管理员并进入 A 仓场景后，从该目录运行下列命令。

```powershell
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day14 video-start day-14-demo.webm --size=1440x1100 --fps=25
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day14 run-code --filename ../../../scripts/browser-checks/day14-demo.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day14 video-stop
```

确认录制启动、操作回调通过且文件可解码。录像暂停仅供观看，断言使用实际操作响应和 UI 就绪条件。结束后关闭该会话并向 QA 终端发送 `stop`。

## Day 15 导航网格

从仓库根目录启动新 `pnpm qa:browser`，以普通 seed 和独立会话 `warehouse-day15` 打开 QA 地址，按当前快照登录管理员并进入 A 仓场景。

```powershell
New-Item -ItemType Directory -Force output/playwright/day-15
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day15 open http://127.0.0.1:15174 --browser chrome
# 登录后执行
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day15 run-code --filename scripts/browser-checks/day15-navigation.js
npx --yes --package @playwright/cli playwright-cli -s=warehouse-day15 close
# 最后向 QA 终端发送 stop
```

脚本逐格核对架体与服务点颜色，验证切换 2D 和 QC 筛选后图像保持一致，通过响应拦截制造断图，再恢复真实布局。返回可走格数、货位数、独立服务点数和分区序列，截图写入 `output/playwright/day-15`。运行结束后移除响应拦截。

## Day 20 整单上架与人工发运

使用全新 `pnpm qa:browser` 环境（不要执行 reserve 等夹具命令），确认 QA READY 后打开独立会话：

```powershell
New-Item -ItemType Directory -Force output/playwright/day-20
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day20 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day20 run-code --filename scripts/browser-checks/day20-putaway-dispatch.js
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day20 close
# 向 QA 终端输入 stop，确认退出。
```

回调以测试账户登录，真实 UI 创建 4 件新批次入库单、收货和质检；选择空储位启动上架；创建/分配新批次出库单，验证提前发运 409；软件机器人搬运到暂存，刷新后保持检查点/场景；人工确认发运时让真实后端先提交、再由 Playwright 丢弃响应，随后通过 UI 原参数重试。断言两次发运 key 相同、搬运不扣现存、确认只扣一次、最终仓库对账一致。截图位于 `output/playwright/day-20`，脚本返回实际库存摘要。每轮使用新隔离库，不能把脚本中断后的部分流程当作通过。

## Day 21 单车全链路录像与阶段观测

先顺序运行 `pnpm check`、`pnpm test:unit`、`pnpm test:integration`，等测试集群退出后启动全新 `pnpm qa:browser`。不要使用 `reserve`、`layout-v2` 或手工 SQL 改库存。录像前登录测试管理员、进入 A 仓场景并等 Canvas 就绪，避免录到登录内容。

```powershell
New-Item -ItemType Directory -Force output/playwright/day-21
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day21 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day21 resize 1440 1100
# 按当前快照登录 admin@demo.local / browser-fixture-only-2026，并进入 A 仓场景。
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day21 video-start output/playwright/day-21/day-21-demo.webm --size=1440x1100 --fps=25
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day21 run-code --filename scripts/browser-checks/day21-single-robot-demo.js
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day21 video-stop
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day21 run-code --filename scripts/browser-checks/day21-video-check.js
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day21 close
# 向 QA 终端输入 stop，确认环境退出。
```

主回调必须从仓库场景启动，要求初始现存 62 且无任务。全程通过 UI 操作，运行中的上架/出库各捕获五个 phase，三次 API 读水位相同才接受快照；在途时打开台账展示虚拟货位。最终核对新批次 7 条流水、唯一 DISPATCH、连续事件、同水位 tick、刷新结果与只读对账。返回的相对秒是脚本观测时间，不能直接当视频绝对秒或性能结果。

录像需要完整解码和实际播放后才归档。播放检查脚本的 file URL 对应本工作区，其他克隆路径需修改；抽帧点对应本轮 40.64 秒录像，重录后应按真实内容调整，不能将过场当在途证据。25fps 仅是录像设置。ffmpeg 完整检查命令、SHA-256 和本轮结果见 [Day 21 验收报告](../../reports/day-21-acceptance.md)。重复录制留在本地 output 或新运行副本，不覆盖 reports 中已归档媒体/历史 PDF。

视频暂停和集成测试停止逐 tick 推进用于查货，产品没有暂停 API 或历史回放；录像中 runner 没有被伪造暂停。仅单车，不宣称多车协调。原始 CLI/解码输出与辅助文件留在 output，只有明确的本轮录像和 PNG 进入 reports。

## Day 22 持久五车与真实等待

必须使用新 `pnpm qa:browser` 隔离库，且先等待集成测试 PostgreSQL 完全退出。不要向 QA 输入 reserve/layout 等额外夹具命令。

```powershell
New-Item -ItemType Directory -Force output/playwright/day-22
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day22 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day22 run-code --filename scripts/browser-checks/day22-fleet.js
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day22 close
# 向 QA 终端输入 stop，并等待退出。
```

脚本从登录页启动，用 QA 测试管理员进入 A 仓；UI 初始化五车、选择车辆并分配。入库/出库准备夹具使用当前账户真实授权 API（非 SQL），三台不同车辆顺序完成 QC 上架，再给五车各分配一个出库任务，观察至少 70 tick 的冲突等待。断言刷新后归属不变、库存 65/预占 5、对账一致，并逐条检查捕获水位之前的持久 FLEET_TICK，不允许同格、进入他车原占格或 edge swap。最后换 viewer 验证原生提交按钮 disabled、写入 403、跨空间 404。

返回的 carrying/wait 数量是轮询观测次数，不是唯一动作数或性能指标。五个并发出库任务不保证全部完成，共享暂存点/完成停车可造成真实等待；不自动挪车、重置或改库存来制造完成。截图写入 `output/playwright/day-22/day-22-fleet.png`，完整脚本成功且人工检查后才复制到 reports。单次中断或仅截图成功不算整体验收通过。

## Day23 单容量资源

用新 `pnpm qa:browser` 隔离环境，等待 PostgreSQL 集成集群退出后启动，不执行额外夹具命令。

```powershell
New-Item -ItemType Directory -Force output/playwright/day-23
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day23 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day23 run-code --filename scripts/browser-checks/day23-resources.js
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day23 close
# QA 终端输入 stop，等待退出。
```

脚本在登录页使用 QA 测试账户，真实 UI 初始化五车、填写四种资源 JSON、保存并检查空闲车已持有所在许可；经普通授权 API 准备 WMS 单据，UI 分配三台车顺序上架，再分配五个并发出库。观测 RESOURCE_BUSY 的资源/阻挡车及等待 tick；在捕获水位内逐条验证持久 FLEET_TICK 许可与物理占格一一对应，以及原同格/edge swap/保守进入约束。刷新后归属保持；viewer 原生按钮禁用且资源写入 403，跨空间 404。返回的是轮询观测次数，不是吞吐或唯一业务动作数。并发未全部完成属于真实等待，不移走完成车或伪造完成。

截图在 `output/playwright/day-23/day-23-resources.png`；完整回调成功并人工检查后才归档 reports。QA 不能与集成 PostgreSQL 同时运行（共用便携运行时文件），中断的部分结果不计通过。

## Day24 封锁、绕行与暂停

先完成集成测试并等数据库完全退出，再用新 `pnpm qa:browser` 隔离普通 seed 环境，保持该终端 stdin，不输入额外夹具。

```powershell
New-Item -ItemType Directory -Force output/playwright/day-24
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day24 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day24 run-code --filename scripts/browser-checks/day24-navigation.js
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day24 close
# QA 输入 stop，确认退出。
```

从登录页使用 QA 管理员进入 A 仓，UI 初始化三车。普通授权 API 准备出库订单与分配，UI 给 robot-2 领任务、封锁其未来路线格，验证合法绕行；再封锁未占用目标，验证 NO_PATH 告警、至少八 tick 不移位不改货物/归属、刷新持久保留。解封后原任务完成，再清理第一处封锁，共四个 revision。按固定水位检查连续历史、所有持久 tick 不进入封锁格、最终库存与对账，再换 viewer 验证原生禁用和 403，另断言占格/旧 revision 409。UI 409 允许有界重读重试，不修改服务器状态骗过 fence。

截图位于 `output/playwright/day-24/day-24-paused.png` 与 `day-24-completed.png`。只有完整回调成功且人工检查后才归档 reports；载货暂停的确定性正例还由真实库测试覆盖。脚本轮询/截图时刻不是性能测量或整份仓库的原子快照，不声称全局无死锁。

## Day25 设备故障与原任务恢复

用新 `pnpm qa:browser` 普通 seed 隔离库，先等集成PG完全退出；保持QA终端stdin，不输入额外夹具命令。

本日固定使用本机已缓存的CLI 0.1.24离线执行，避免未指定版本时npx追逐未缓存版本。新机器若无该缓存需先安装对应测试工具；它不是应用运行依赖。

```powershell
New-Item -ItemType Directory -Force output/playwright/day-25
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day25 open http://127.0.0.1:15174 --browser chrome
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day25 run-code --filename scripts/browser-checks/day25-recovery.js
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day25 close
# QA输入stop，确认退出。
```

脚本从登录页开始，普通授权API准备真实出库分配，UI初始化3车/配置从取货点到暂存点的单容量资源、给robot-2分配。先注入取货前故障、取消运输验证预占释放且故障保留、维修；新建第二单，取货后UI注入故障，验证NEEDS_RECOVERY、至少8tick不移位/耗电/丢货、实际通道owner保留、载货取消409、刷新不丢状态。维修后原claim一次完成，最终保持暂存占格与许可、库存对账一致，再逐条核对捕获水位前连续事件和唯一取放/取消。最后viewer原生禁用、API403。

截图 `day-25-loaded-fault.png` / `day-25-repaired.png` 完整成功并人工检查后才复制reports；原始日志/诊断留output，不提交本地PDF。脚本有45秒观测界限，超时不把真实堵塞改成通过，不移走其他车或改库存。不是工业实时保证，也不是新增fleet API SIGKILL实验。

## Day26 电量与充电

在全新隔离 pnpm qa:browser 环境下，创建 output/playwright/day-26，然后按 Day25 的固定 CLI 版本打开新会话 warehouse-day26；运行 day26-energy.js。演示资源将充电配置到出库停靠格；先完成真实运输、再用 UI 充电，核对电量、占位、原归属、唯一取放历史、对账和 viewer 403。不改数据库制造低电量；低电量和争抢反例由隔离集成测试负责。结束后关闭 Chrome、QA 输入 stop。
## Day 28 车队阶段录像

在全新隔离 QA 数据库运行一次。若 Windows 把默认 API 端口 13004 纳入保留范围，可先设 `$env:QA_API_PORT='13036'`（确认端口空闲），然后 `pnpm qa:browser`，等待 `QA READY`。浏览器入口仍为 `http://127.0.0.1:15174`。用 QA 管理员登录，停在含「演示仓库 A ADMIN」的页面，不录登录。需要一个启用 WebGL 的 Chrome 会话。

```powershell
New-Item -ItemType Directory -Force output/playwright/day-28 | Out-Null
function pw28 { npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day28 @args }
pw28 open http://127.0.0.1:15174 --browser chrome
# 用 Playwright CLI 的 snapshot/fill/click 或 run-code 登录；不要关闭浏览器会话。
pw28 video-start output/playwright/day-28/day-28-demo.webm --size=1440x1100 --fps=25
pw28 run-code --filename scripts/browser-checks/day28-fleet-demo.js
pw28 video-stop
pw28 close
```

录前将浏览器视口设为 1440×1100（可在登录脚本里 `await page.setViewportSize({ width: 1440, height: 1100 })`）。脚本走真实授权 API 布置与操作两单和五车，通过原应用场景录制；字幕由脚本读取已提交快照，不是新增产品 UI。用本地浏览器打开生成的 WebM，确认六段均可播放、字幕完整，再归档；失败片段和原始日志留本地。验收结束在 QA 启动终端输入 `stop`。

## Day 29 双浏览器实时订阅

按上节启动全新隔离 QA，并登录测试管理员。使用 Playwright CLI 执行 `run-code --filename scripts/browser-checks/day29-realtime.js`；脚本复制隔离测试会话到第二个 Chrome 上下文，检查独立 WebSocket 收到相同序列并自动刷新预占，随后退出并断言两个连接清理。权限、回滚与补发的独立会话用例见 [Day29 验收](../../reports/day-29-acceptance.md)。

## Day 30 快照竞态与网络恢复

全新隔离 QA 登录管理员后，运行 `run-code --filename scripts/browser-checks/day30-recovery.js`。在第二个 Chrome 上下文暂缓真实首快照响应，等预占提交事件确实到达后再放行；用网络离线模拟验证新预占与车队任务在重连后出现；最后阻断快照请求，验证陈旧提示、操作禁用和重试。该脚本通过现有业务 API 生成提交，不用假库存响应。

## Day 31 运营指标和两种热力

全新隔离 QA 登录管理员后，运行 `run-code --filename scripts/browser-checks/day31-operations.js`。先验证零分母与全仓库存层，再通过真实 API 制造单容量通道竞争，同时核对设备故障不等于拥堵；按事件窗口复算热力。截图留在 `output/playwright/day-31/`。用例不发运、不把模拟设备连接到外部。
