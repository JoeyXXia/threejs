# Day34 验收 — 位姿采样、慢连接与清理

日期：2026-11-25（Asia/Shanghai）。基线 `172eeb7`；未推进 Day35 演示或发布。

## 策略

- `warehouse:subscribe` 可请求 `telemetry: true`。每页最多 100 个按序提交的事件信封，一连接同一时间最多一页在途；最后一条是可解析的 tick 才附带一个紧凑位姿。其它 tick 保留 seq/version/epoch 等元数据；告警不被丢掉。4s 未 ACK 即断开，期间授权定期复查。原 HTTP 事件页、历史帧、事务和旧订阅者不受线格式影响。
- 浏览器只保留一个位姿样本；按 scope、已确认水位、epoch、布局、封路 revision 和任务核验。跳过多 tick 时只用最新确认格，只有相邻确认段可插值。从不把位姿写入库存、任务或回放。
- 位置密集时整仓 HTTP 快照采样间隔设为 1s；业务事件、告警和补缺口优先。路由切换或浏览器断线会取消上一代请求和定时器；退出回放重新订阅。未测生产吞吐、应用 FPS、内存占用或服务 SLA。

## 复验命令

```powershell
pnpm check
pnpm test:unit
$env:TEST_API_PORT_BASE='13040'
pnpm test:integration
# 隔离 QA
$env:QA_API_PORT='13036'
pnpm qa:browser
git diff --check
```

浏览器登录隔离测试账户后，用 Playwright CLI 执行 `run-code --filename scripts/browser-checks/day34-telemetry.js`。数字采样口径：Chrome Strict Mode 开发构建，截取一段三车运行；页面有效 tick 从 mesh canvas 诊断采样，React 计数仅涵盖仓库页面组件实际提交，不等于 app 全树渲染或 FPS。原始日志留在本地。

## 实测证据

- `pnpm check`、补跑的 `pnpm lint`、`git diff --check` 通过；Vite 仍提示产物 chunk 偏大。
- `pnpm test:unit` 通过：core 55、web 91，共 146 项。包含位姿单槽/拒绝陈旧数据/重复订阅释放测试。
- `pnpm test:integration` 通过：真实 Socket/API、事务和运行时等 Node 集成 66 项，Jest API 集成 99 项，共 165 项。四个隔离测试库均完成 PostgreSQL 重启，重启前后的回放帧摘要一致，库存、预留、事件与检查点对账通过。
- 21:57 上海时间的本地 Chrome：三车样本 3,212 ms，观察到 13 个不同 mesh tick、4 次仓库页面组件提交、3 次 HTTP 快照 GET、12 个带位姿的包。切仓两次往返、进出回放和断网重连后的连接数依次为 `1,1,1,1,0,1,0,1`。
- 真实 Socket.IO 慢客户端测试通过：650 ms 不 ACK 后仍只有 1 页；该页包含 8 个连续事件信封、移除 8 份完整 tick 载荷、附带 1 份位姿。HTTP 原始事件页仍可取到对应的三车记录；撤权后在断言的 2,300 ms 内收到 404 撤权通知并断开，无需等到 4s ACK 超时。
