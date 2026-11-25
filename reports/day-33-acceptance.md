# Day33 验收 — 历史时间轴与实时隔离

日期：2026-11-25（Asia/Shanghai）。基线 `80bd206`。仅在 Day32 历史 API 上实现前端只读回放。

## 复验命令

```powershell
pnpm check
pnpm test:unit
$env:TEST_API_PORT_BASE='13040'
pnpm test:integration
# 独立测试终端
$env:QA_API_PORT='13036'
pnpm qa:browser
git diff --check
```

登录隔离 QA 管理员后运行 Playwright CLI `run-code --filename scripts/browser-checks/day33-replay.js`。截图和原始日志留在 `output/playwright/day-33/`，不上传。

## 同步与限制

- 只用有权限的归档 GET。以 workspace/user/warehouse 和时间范围对缓存分区；进入回放卸载实时视图，历史用独立 Zustand store，返回实时挂载新会话。回放区域无业务命令，既有服务器 ACL 不变。
- 页面以本机时间输入、用 UTC 调接口。默认最近 60 秒；最多读取 16 页，每页 100 条事件，覆盖不全时提示缩小范围，不能连续播放截断的历史。UI 不自动刷新当前播放数据。
- 时间轴只显示有轨迹的逻辑 tick，0.5×/1×/2× 的定时配置分别为 500/250/125 ms，并非应用 FPS 或真实物理时间。seek 直接恢复确认格；帧间业务事件不用于猜测逐批逐货位库存。未测生产延迟和长期历史容量。

## 实测证据

- 构建、类型检查、lint 通过，Vite 保留分包大小提示；单测 143 项（核心 55、Web 88）通过。新增六例覆盖跨基线顺播/seek、起始目标、分页缺失/重复/越界、水位和 scope、无效导航、空窗、速度和仓库间 store 隔离。
- Chrome（09:51:29，Asia/Shanghai）：归档样本从 tick 1 顺播至 tick 23 / seq 30，回到起点再直接拖至同一末帧，摘要完全相同：现存 62、预占 1、可用 54、待检 7，封路 revision 1，共三车，其中高亮车 robot-2 位于 (9,3) 且载货。最终截图目检符合任务高亮、其他两车保留和红色封闭格。
- 回放期间由独立测试请求提交新预占，读取水位 seq 45；回放仍停在 seq 30，页面发出 0 次业务写请求、打开 0 条实时连接。测试拦截真实历史响应移除一条事件后，页面明确报历史缺段、不显示库存；返回实时重新建立 Socket，预占显示为 2。
- 全量集成退出 0：164 项（Node 65、Jest 99）通过，四个临时 PostgreSQL 库真实重启后，库存、检查点、事件水位及历史摘要复核通过。保留在本地输出区的 Day29 隔离工作树仍触发 Jest 同名包提示，不影响本轮结果。
