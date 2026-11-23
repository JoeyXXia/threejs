# Day29 验收 — Socket.IO 授权与提交边界

日期：2026-11-23（Asia/Shanghai）。基线 `4932ea7`。范围：仓库场景只读实时事件和 HTTP 失效刷新，未引入 Day30 一致快照、历史回放或多实例消息代理。

## 复验命令

```powershell
pnpm db:generate
pnpm check
pnpm test:unit
$env:TEST_API_PORT_BASE='13040' # 仅当 Windows 保留默认 HTTP 测试端口时替换
pnpm test:integration
# 隔离浏览器 QA 使用独立终端
$env:QA_API_PORT='13036'
pnpm qa:browser
git diff --check
```

升级现有本地业务库应按 README 生成 Prisma 并执行 `pnpm db:migrate`，无需 reset 或重新 seed。浏览器验收在 15174 登录隔离 QA 用户后运行 `scripts/browser-checks/day29-realtime.js`。

## 浏览器证据

2026-11-23 21:57:00（Asia/Shanghai），两个 Chrome 上下文各持一条 WebSocket；仓库 seq 从 0 到 2，两端收到相同的 `OUTBOUND_CREATE` 和 `OUTBOUND_ALLOCATE`。第二端未手动刷新，真实预占从 0 变为 1。退出共享测试会话后两条连接均关闭，两端都回到登录界面。不同会话的权限和退出隔离由集成用例校验。

首次全量复验让新用例的真实 API 和旧手动 tick 测试共享一个库，自动 runner 改动旧夹具时触发 fencing 冲突。实时用例改用专用临时数据库，不调整旧测试断言或生产调度逻辑。

## 回归结果

- `pnpm db:generate`、`pnpm check`、复跑前 `pnpm lint`、`git diff --check` 均通过。Vite 仍提示有超过 500 kB 的构建分包；本日没有测量线上加载性能。
- `pnpm test:unit`：129 项通过（核心 55、Web 74）。Socket 与 HTTP 事件共享信封，合同测试允许旧元数据为 null 并拒绝字段缺失或非法 epoch。
- `TEST_API_PORT_BASE=13040` 下全量集成复跑退出 0：Node 59 项、Jest 99 项，共 158 项。四个临时数据库在真实 PostgreSQL 重启后对账一致；旧 schema 升级保留既有业务行和凭据。
- 真实 NestJS/Socket.IO 集成确认：无 cookie、错误 Origin、越权仓库、伪造 room 或空间订阅被拒；撤权、过期及退出断开相应连接，独立会话保持连接。未提交的卸货探针在事务持有和回滚后均未收到，仓库没有事件行；提交的预占、任务、位置、故障事件同 seq 内容一致；显式 after 补发并与既有 HTTP 历史页一致。

## 协议和限制

- WebSocket 经同源 `/socket.io`，非原生 WebSocket 消息协议；无长轮询回退。升级请求的 Origin 必须在 `WEB_ORIGINS`，身份来自原服务端 session。反代需要透传 WebSocket Upgrade。
- 一条连接只订阅一个仓库：`warehouse:subscribe({spaceId, warehouseId, after?}, ack)`。不带游标时确认当前仓库水位；显式游标从下一条补发。在确认前不转发。无权仓库统一不暴露是否存在，超出水位返回 `CURSOR_AHEAD`。
- `warehouse:events` 包含仓库 scope 和最多 100 条事件，每条有 `seq, version, epoch, tick, kind, payload, createdAt`。客户端确认 `true` 后推进连接游标；超过 4 秒不确认或拒绝会断开。未知历史元数据为 `null`，seq 是仓库内排序键，epoch 是 runner 任期；createdAt 不作为提交顺序或投递延迟的证明。
- 单进程示例最多 64 个 Engine.IO 连接。relay 定时从 PostgreSQL 读取，并在读批次时重新核对会话和授权；不保证回收已在途数据，也不承诺送达延迟或生产吞吐。实时不可用时仍可从 HTTP 读取；客户端不直接应用事件 payload，不保证库存与轨迹来自同一次 HTTP 快照。

## 独立提交复验

2026-11-23（Asia/Shanghai）。从 Day28 基线隔离 Day29，未纳入本地 Day30 或旧录像/PDF 改动。锁定依赖离线安装、Prisma 生成、构建检查通过；单测 129 项、集成 158 项（Node 59、Jest 99）全部通过，四个临时库重启对账通过。22:33:25 双 Chrome 上下文收到相同的 seq 1–2，预占从 0 更新为 1，退出后两条 Socket 关闭。
