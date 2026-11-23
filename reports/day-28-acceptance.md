# Day 28 验收：五车演示与 v0.4 阶段归档

- 日期：2026-11-23（Asia/Shanghai）；基线 `e97cce182aa5ca405dd4f24b4e3786cecf87f509`（Day27）。
- 环境：Windows 本机、Node.js 22.14.0、Chrome / Playwright CLI 0.1.24，临时 PostgreSQL，原 React/R3F 场景与 NestJS API。使用种子数据、真实 API 与真实数据库，无模拟网络响应、生产数据库或手工库存造数。
- 命令：`pnpm check`、`pnpm test:unit`、`pnpm test:integration`、`git diff --check`，浏览器按[复现步骤](../scripts/browser-checks/README.md#day-28-车队阶段录像)。

## 回归结果

- `pnpm check` 退出 0，包含类型和构建；Vite 仍提示场景 chunk 超过 500 kB，本日不改动打包策略。
- `pnpm test:unit` 退出 0，核心 55 项、Web 73 项，共 128 项通过。
- 更新的 JavaScript 测试/录屏脚本通过 `node --check`；变更通过 `git diff --check`。
- `TEST_API_PORT_BASE=13040` 下 `pnpm test:integration` 退出 0：transport 57/57，Jest 99/99，共 156 项；两个真实 API 进程重启用例通过，三库在真实 PostgreSQL 重启后对账均通过。

## 验证环境修正

`netsh int ipv4 show excludedportrange protocol=tcp` 显示本机 `12936–13035` 被保留：首次 QA 在 API 端口 `13004` 启动报 `EACCES`，首次集成的两个真实 API 重启用例在 `13019` 健康检查超时（同轮 transport 子套件 55/57）。只挪重启端口的中间复验可以进入下一阶段，但多个 Jest HTTP 夹具仍在保留区。最终保持实现和断言不变，给 QA 与测试起点分别配置回环端口：

```powershell
pnpm check
pnpm test:unit
$env:TEST_API_PORT_BASE='13040' # HTTP 集成夹具保留各自偏移，本机会落在 13041–13059
pnpm test:integration
# 独立终端，确保回环端口空闲：
$env:QA_API_PORT='13036'
pnpm qa:browser
git diff --check
```

## 录屏与运行证据

[44.88 秒 WebM](day-28-demo.webm)，1440×1100，6,478,582 字节。SHA-256：`d412abc8e1d2dd899b29c7eed703b8a5ceddd6b59ea330f52aae466c6d8c15d7`。Chrome 本地解码，12 个定位点均能继续播放；人工抽帧核对原场景和可读字幕。录屏从登录后开始；下列视频时间是定位点，不是提交时钟。

| 录像位置 | 实测证据 |
| --- | --- |
| 5 秒 | 五台车、五个不同格；三台在本例保持停车。 |
| 10 秒 | 封闭 `(1,7)`，地图修订 0→1；改变未来路线并继续，动态封锁格从未进入。 |
| 16 秒 | robot-2 已载货，在 tick 22 于 `(8,3)` 故障；保持位姿、99.78% 电量、货物/claim 和 `aisle`。 |
| 21–22.5 秒 | robot-1 在 tick 51 首次被脚本读到 `RESOURCE_BUSY / aisle / robot-2`；未通过假完成清仓。 |
| 24–29.5 秒 | 维修后续跑原 claim，robot-2 在 tick 85 完成，仍占暂存点通道 `(27,3)`。 |
| 30.5–31.5 秒 | robot-2 移至 `(27,2)` 释放通道，tick 87 达到满电（从落货后的 99.40% 到 100%），满电仍拥有 `dock`。 |
| 35–43 秒 | tick 105 两单落货完成，事件 seq 1–123 连续。最终库存 62 件、预占 2 件，可用 53、待检 7；WMS 对账一致。 |

脚本逐个核查 105 个持久 `FLEET_TICK`，五车没有同格、进入其他车起始格、穿货架/动态封锁或越界；每车每步至多移一格，资源内部实车与所有者一致。事件包含 `TRANSPORT_TAKEN`、`TRANSPORT_DROPPED` 各 2 条，`FLEET_FAULT`、`FLEET_REPAIR`、`FLEET_CHARGE` 各 1 条，`OUTBOUND_DISPATCHED` 0 条。验收采集时间：2026-11-23 10:04:31（Asia/Shanghai）。隔离 QA 在采集结束后正常停止。

## 限制

本例只有两单和两台移动车辆，另三台保持停车；不等同于五台同时通过瓶颈，也不保证任意负载无死锁。离散格和软件电量不是可用的机器人控制器、运动轨迹或硬件耗能测量。录制帧率参数不是应用 FPS；事件水位与浏览器采样画面可能不同步。原始命令日志、失败试录、抽帧及其他 QA 临时文件留本地。
