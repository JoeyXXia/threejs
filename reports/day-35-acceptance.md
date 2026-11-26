# Day35 验收 — 实时运营到只读回放

日期：2026-11-26（Asia/Shanghai）；基线 `ea3b597`。

## 可观察验收

1. 实时看见一次 UI 分配、原任务 ID、封路后 `NO_PATH`；录像文字足以区分暂停、离线、恢复和只读回放。
2. 离线显示最后确认快照、禁用提交；重连后补上另一上下文已确认的预占与解封，保留原 claim。
3. 回放时拖动到封路帧，确认为同一任务与归档布局；该帧的库存与已恢复实时库存不同。回放只走归档读取，不打开实时连接或发业务写请求。
4. 返回实时后，原任务取货、落货各一次，未发运，持久事件连续，库存对账一致；浏览器只提交一次任务分配。

## 复验命令

```powershell
pnpm check
pnpm test:unit
$env:TEST_API_PORT_BASE='13040'; pnpm test:integration
$env:QA_API_PORT='18135'; $env:QA_WEB_PORT='18136'; $env:QA_PG_PORT='18137'
pnpm qa:browser
```

登录后用 Playwright CLI [录制并运行运营演练](../scripts/browser-checks/README.md#day-35--运营回放录像)。失败片段和原始日志仅留本地。

## 实测（09:58，Asia/Shanghai）

- 真 Chrome、隔离 PostgreSQL / NestJS：浏览器 `fleet/assign` 仅一次，`robot-2` 的 claim `f7e60b6a-5301-4e46-a14f-953ae1785603` 和账本任务 `063f66ee-2267-4814-8ccf-d76358779fea` 在实时与回放匹配。
- 封闭暂存服务格 `(27,3)`，原任务显示 `NO_PATH`。离线保持预占 1、禁用提交。离线期间的提交水位为 seq 44，重连后读取到 seq 45，预占变为 2。拖回 seq 19 时，UI 取归档布局 v1 并显示预占 1；回放仅请求历史窗口和归档布局，产生 0 个业务写、0 个新实时连接。此演练没有发布新布局版本；旧布局在新版本发布后仍可读取的边界由 Day32 集成测试覆盖。
- 核对 seq 1–79 连续；1 次任务分配，2 次封路变更，取货和落货各 1 次，0 次发运。全仓现存 62 件，库存对账一致。
- `pnpm check`、最终 `pnpm lint`、`git diff --check` 通过；单测 146 项（core 55、web 91），集成 165 项（Node 66、Jest 99），4 个 PostgreSQL 隔离库重启后的库存、预留、事件及检查点对账通过。构建仍报告较大 chunk；Jest 有本地 Day29 嵌套 worktree 的同名包警告。
- [归档录像](day-35-demo.webm)：Chrome 实际解码为 1440×1100、27.76 秒；1–27 秒按 2 秒间隔定位并复播 14 个样本，核看七章字幕及实际告警、离线快照和归档三维布局。文件 6,826,043 字节，SHA-256 `2aea0b3d62f5067eae3271cf8c497fdb6d56cbb9b35fd4d703c531716d9b68ae`。该分辨率和时长仅描述录像。

## 限制

网络变化由 Playwright 对录制浏览器模拟；通过独立授权的测试请求上下文准备业务数据，无手工改库。无生产吞吐、网络恢复 SLA 或真实硬件测量。
