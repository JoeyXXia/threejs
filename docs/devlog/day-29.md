# Day29 — Socket.IO 事件与授权房间

日期：2026-11-23（Asia/Shanghai）。基线 `4932ea72ac04829d56091b76cdd349d8f68dc7c7`。Day28 已验收五车与持久状态；此前仓库页面仍通过 HTTP 轮询，数据库已有按仓库排序的 `WarehouseEvent`、HTTP 历史页和业务提交锁。本日复用这些机制，只加已提交事件订阅。

## 三组可独立审查的改动

1. **提交信封与 Gateway**：`packages/database/prisma/` 增加可空的提交元数据列，`warehouse-state.ts` 在追加事件事务内记录 version/epoch，`packages/contracts/src/index.ts` 与 `simulation.service.ts` 统一 HTTP 与 Socket 事件字段。Nest 中的 `apps/api/src/realtime/warehouse.gateway.ts` 复用会话、仓库授权与现有 HTTP listener。
2. **仓库页消费与清理**：`apps/web/src/warehouse/RealtimeStatus.tsx`、`WarehouseView.tsx`、`App.tsx` 与 Vite 代理。Socket 只接收确认事件，按仓库失效 Query 缓存；库存、机器人位姿和业务操作仍走 HTTP。切换页面、仓库或退出解绑，原场景和 Zustand UI 状态不改。
3. **复验与说明**：`tests/transport/realtime.test.cjs`、合同用例、`scripts/browser-checks/day29-realtime.js`、本日志及 `reports/day-29-acceptance.md`。没有增加消息代理、另一套登录或部署。

## 状态权威和事务边界

- PostgreSQL 中业务账本、`WarehouseRuntime` 和 `WarehouseEvent` 为权威。业务变更、seq/version 增量、epoch 采样和事件在同一事务提交；回滚不留事件也不推进 seq。旧事件的 version/epoch 为 `null`，不拿当前 runtime 值伪造历史。
- Gateway 仅接收允许的 Origin 和原 HttpOnly 会话 cookie；在握手及每次转发读批次时验证会话，订阅和转发都查 `(userId, spaceId, warehouseId)`。房间名由服务端组合，不由客户端指定；按各连接游标单发，不向未经本批重新授权或游标不同的房间整体广播。
- 同一 `RepeatableRead` 快照内读会话、权限和事件。只发送已提交行；每连接一页在途，收到 ack 才推进、超时解绑。认证或授权撤销后，下次授权检查会断开；已经读取或发出的在途批次不可撤回。
- 最大失败边界：握手后权限变化、快照边界附近业务提交、漏 ack 或重加入。客户端从首个订阅基线开始核对 scope 与连续 seq，不将 payload 直接写进 Query。Day30 才做一致快照＋缓冲、产品级断线补齐、重复/旧 epoch 的状态合并。

## 可观察验收

1. 两个浏览器上下文订阅同仓，从同一 seq 看见同一库存事件，另一端不手动刷新也能看到真实预占变化。
2. 没有 cookie、非允许 Origin、跨仓或伪造空间/房间均不能读；撤权、会话过期、退出后连接解绑。
3. 故意在持有事务并追加“已卸货”样式事件后回滚，两端都不收到，之后真实事件按原 seq 连续提交。
4. 能按显式 after 补发任务、库存、位置和异常事件；同 seq 的内容在两个客户端一致，有真实提交元数据。

见 [Day29 验收报告](../../reports/day-29-acceptance.md)；本地 PDF、旧录像的已有删除、`output/` 和 `tmp/` 不纳入变更。

实测构建通过，129 项单测、158 项集成全过，四库重启后对账通过。两个 Chrome 上下文均收到 seq 1–2，预占自动由 0 刷新为 1，退出后两条连接关闭。

## 独立提交复验

2026-11-23（Asia/Shanghai）。从 Day28 基线隔离 Day29，未纳入本地 Day30 或旧录像/PDF 改动。锁定依赖离线安装、Prisma 生成、构建检查通过；单测 129 项、集成 158 项（Node 59、Jest 99）全部通过，四个临时库重启对账通过。22:33:25 双 Chrome 上下文收到相同的 seq 1–2，预占从 0 更新为 1，退出后两条 Socket 关闭。
