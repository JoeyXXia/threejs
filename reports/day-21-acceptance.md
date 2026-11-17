# Day 21 验收：单车全链路与 v0.3

日期：2026-11-17（Asia/Shanghai）。应用功能基线为已推送的 Day 20 `0ad322a3e6ce1446792f13be856848cdfde901b5`。Day 21 没有修改库存/runner 业务代码、数据库结构或依赖；仅新增演示、逐阶段查货测试、媒体/文档及里程碑标题。发布指 Git 注释标签，不是部署或额外 GitHub Release 对象。

[完整连续录像](day-21-demo.webm) · [上架 TRANSIT](day-21-putaway-transit.png) · [出库 TRANSIT](day-21-outbound-transit.png) · [暂存场景](day-21-preview.png) · [最终对账](day-21-reconciled.png)

## 最小方案与验收条件

三个审查组：①业务 UI 复现脚本、媒体播放检查、两种任务逐阶段停步测试；②连续录像及截图；③本报告、devlog、发布说明、README/复现说明与 Git 标签。相关文件见 [devlog](../docs/devlog/day-21.md)。

五项可观察条件：真实 UI 无手工改库跑通；10 个任务阶段货物可定位且有事件证据；暂存不扣现存而人工发运只扣一次；刷新与三库重启后账实一致；录像可完整解码、跳转播放且 Git main/标签可核对。

PostgreSQL 继续为库存、预占、领域 phase、载荷/tick 和事件权威。取/放的同事务边界、统一写锁顺序、lease/epoch/expectedTick/version fencing 不变。前端只呈现已提交段；录像等待不能决定库存。浏览器用 simulation → inventory → simulation 相同水位接受快照，拒绝混合 tick。最可能失败的边界是错过短暂阶段、跨请求读出不同 tick、忽略虚拟 TRANSIT 和未落盘录像；脚本失败即不计完成。

## 实测环境与命令

Windows、本机 Chrome、1440×1100 浏览器窗口。Node v22.14.0，PostgreSQL 18.6（x86_64-windows / msvc-19.44.35228），Prisma 6.19.3。所有业务为合成数据，隔离 QA/测试库，不读取根 `.env` 或改开发库。

| 检查 | 本轮结果 |
| --- | --- |
| `pnpm check` | lint、全仓 typecheck、build 通过；保留既有 chunk >500kB 提示 |
| `pnpm test:unit` | 85 通过：simulation 19 + web 66，无失败/跳过 |
| `pnpm test:integration` | 128 通过：Node 领域/runner 29 + Jest HTTP 99，无失败/跳过 |
| 新增 stop-at-phase 测试 | 上架与出库各五阶段停步，读取持久库存、同水位事件并逐阶段对账通过 |
| `pnpm qa:browser` + `day21-single-robot-demo.js` | 普通新 seed，真实 UI 完整流程一轮通过；10 个阶段、75 条连续事件、7 条同批流水、1 条 DISPATCH，刷新结果保持 |
| ffmpeg 全文件检查 | `-xerror` 解码全部 1016 帧并缩小重编码至本地检查文件，退出 0；原录像没有裁剪、加速或替换画面 |
| Chrome 文件播放检查 | 6 个位置 seek 后继续播放并前进，readyState=4，已目视检查代表帧及归档 PNG |

数据库真实重启证据 `2026-11-17T00:23:19.720Z`（上海 08:23）：普通读库、写测试库、升级库三个隔离库均 consistent=true，物理/预占/事件/检查点差异全部为 0；写测试库持久检查点 17 个。旧租约 fencing、取/放回滚、丢响应重试和 API 真重启用例仍通过，不因演示而跳过。

## 暂停与能力边界

新增测试没有调用 `onModuleInit`，由测试驱动逐 tick 推进，在每个 phase 停住后读取持久库存/事件；没有直接修改任务或余额。录像中的真实 runner 持续运行，TRANSIT 页面也照常读取已提交状态。可以暂停视频并按下表查到该时刻的货物；这**不是产品级实时暂停 API 或历史回放**，这些能力未实现。视频旁白、真实机器人控制、多车避碰、取消/异常恢复、充电、Socket、生产部署均不在本版本范围。

25fps 是录像配置，不是应用渲染性能测量。没有应用 FPS、吞吐或生产并发结果。匿名会话 401、既有 THREE.Clock 警告不被包装成零告警；未为清除非范围警告升级框架。完整实测均为当前固定样本，不构成生产 SLA。

## 原始证据与复现

本地原始证据（忽略入 Git）：`reports/day21-cargo-checkpoints.json`、`integration-transport.tap`、`integration-jest.json`、`integration-inventory.json`，以及 `output/playwright/day-21/result.txt`、`video-check.txt`、`decode-check.txt`。下文将本次实际结果固定为表格，历史不依赖以后被覆盖的原始 JSON。

复现：`pnpm check` → `pnpm test:unit` → `pnpm test:integration`，等待测试库关闭后启动 `pnpm qa:browser`，按 [录像说明](../scripts/browser-checks/README.md) 登录、设置窗口、录像并运行两个 Day 21 回调。不能将旧 QA 库的半程流程当作完整复验。结束关闭浏览器并向 QA 终端输入 `stop`，确认环境退出。

验收通过后只提交本轮文件和指定媒体，正常推送 main 及新注释标签 `v0.3-single-robot`，不强推或改旧标签；远端提交核对见本轮最终回复。用户原有录像删除、output/tmp 和 PDF 不纳入提交，不推进 Day 22。

## 固定浏览器运行证据

完成时间：2026-11-17T00:26:01.255Z；批次：`DAY21-1794875130580`。
入库单：`eda33eb5-b2dc-4b32-ad36-72ddbec7165d`；出库单：`e9d183ed-3539-4928-b9eb-b49a745ca5b0`。
上架 task：`e0f6a920-51c5-4732-a672-6c50dcf80137`；出库搬运 task：`d5c393fc-da30-46cb-8f9d-09b60470ed8a`。

| 阶段 | 全仓现存 | 预占 | 可用 | HOLD |
| --- | ---: | ---: | ---: | ---: |
| 初始库存 | 62 | 0 | 55 | 7 |
| 收货进入 QC HOLD | 66 | 0 | 55 | 11 |
| 质检放行，货物仍在 QC | 66 | 0 | 59 | 7 |
| 上架完成：储位可分配 | 66 | 0 | 59 | 7 |
| 出库预占 | 66 | 4 | 55 | 7 |
| 到出库暂存：尚未扣现存 | 66 | 4 | 55 | 7 |
| 操作员发运，现存才减少 | 62 | 0 | 55 | 7 |

### 逐阶段快照（浏览器实时运行，非停步测试的另一轮样本）

| 任务 | phase | tick | 已提交 seq | 货物位置 | 件数 | 预占 | 脚本相对秒 |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |
| PUTAWAY | APPROACH | 0 | 5 | QC-01 | 4 | 4 | 4.846 |
| PUTAWAY | LOADING | 11 | 16 | QC-01 | 4 | 4 | 7.545 |
| PUTAWAY | TRANSPORT | 15 | 21 | TRANSIT | 4 | 4 | 8.526 |
| PUTAWAY | UNLOADING | 30 | 36 | TRANSIT | 4 | 4 | 12.349 |
| PUTAWAY | COMPLETED | 34 | 41 | R02-3-L1 | 4 | 0 | 13.378 |
| OUTBOUND | APPROACH | 34 | 45 | R02-3-L1 | 4 | 4 | 18.047 |
| OUTBOUND | LOADING | 35 | 46 | R02-3-L1 | 4 | 4 | 18.259 |
| OUTBOUND | TRANSPORT | 39 | 51 | TRANSIT | 4 | 4 | 19.32 |
| OUTBOUND | UNLOADING | 56 | 68 | TRANSIT | 4 | 4 | 23.623 |
| OUTBOUND | COMPLETED | 60 | 73 | OUT-01 | 4 | 4 | 24.664 |

所有阶段全仓现存均为 66；最终发运后为 62，预占 0，对账 true。捕获水位均在 75 个连续事件中找到同 task/tick，最终水位 75，同批次流水 7 条。脚本相对秒仅辅助定位观测顺序，不等于视频绝对时间或性能基准。

## 录像完整性

原文件：VP9 / 1440×1100 / 40.64 秒 / 无音轨，10364628 字节。SHA-256：

`52a13922ae82cd3a85ff9d6151c34c41a7499f042b4c892282365d8814d9da25`

Chrome 逐点跳转后实际继续播放（秒）：

| 请求位置 | 播放后位置 | readyState |
| ---: | ---: | ---: |
| 8 | 8.26 | 4 |
| 13.4 | 13.6608 | 4 |
| 17 | 17.2651 | 4 |
| 24 | 24.2598 | 4 |
| 29 | 29.2605 | 4 |
| 35 | 35.2649 | 4 |

首次媒体检查的 14 秒抽帧恰逢页面加载过场；改用 13.4 秒查看上架 TRANSIT，24 秒查看出库 TRANSIT，29 秒查看到齐未发运，35 秒查看对账。原始过场未剪掉，也没有将加载画面当作业务成功证据。所有这些位置及相关原图均已打开核验。

完整解码使用已安装的 Playwright ffmpeg n7.0.1：

```powershell
& 'C:/Users/27019/AppData/Local/ms-playwright/ffmpeg-1013/ffmpeg-win64.exe' -hide_banner -xerror -i output/playwright/day-21/day-21-demo.webm -an -vf scale=160:122 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 100k output/playwright/day-21/day-21-decode-check.webm
```

缩小的重编码文件仅用于验证整文件可解码，不是归档录像；已归档文件为原始 1440×1100 连续录制。

审查提交：`4ccf825`（复现脚本、阶段查货及播放检查）、`c1f5553`（验收媒体）；阶段文档随第三组提交，标签应指向包含三组的最终提交。
