# Day30 — 一致快照、去重与断线恢复

日期：2026-11-23（Asia/Shanghai）。基线是本地已验收但未提交的 Day29；Git main 仍为 `4932ea7`。现有 Socket.IO 能续订持久事件，但 UI 分别读取库存与车队检查点，事件没有与完整快照对齐。本轮只用现有 React、Query、NestJS、Socket.IO、PostgreSQL，不引入框架或提前做运营指标、热力图和回放。

## 三组可独立审查的改动

1. **服务端一致读**：`inventory.controller.ts`、`simulation/*.service.ts` 和 `contracts/src/index.ts`。在单个 Repeatable Read 快照内重查会话/授权并复用布局、库存、车队和单车读模型；这四部分不再各自开事务。Socket 订阅与 HTTP 历史识别缺失游标。
2. **场景同步与显示**：`realtime-sync.ts`、`useRealtimeSnapshot.ts`、`WarehouseView.tsx` 和两个机器人面板。订阅之后才请求快照；缓冲、去重、按 seq 缩小缺口；离线保留最后确认画面并停写；过期游标重建基线。
3. **验收**：`tests/transport/realtime.test.cjs`、前端同步单测、`scripts/browser-checks/day30-recovery.js` 和 [Day30 验收报告](../../reports/day-30-acceptance.md)。

## 权威和同步边界

PostgreSQL 是权威；同仓 seq 跟业务变更在同一事务提交。查询水位、库存、布局和运行检查点来自同一 MVCC 快照。Socket 信封不直接改库存或位姿；React Query 只发布经过 scope、水位、版本、epoch 和 tick 校验的完整快照，Zustand 仍只管场景交互。

最容易失败的边界是订阅刚建立、快照读完但还未送达，期间又有事件提交。必须保留高于本次快照水位的事件；后续恢复从**已显示快照**水位续订，而非已见到但还没投影的 Socket 事件。仓库撤权或会话失效时清空快照，回收请求和监听；已在途发送的数据不承诺可撤回。

## 可观察验收

1. 真实分配在一个一致快照的读事务中途提交：旧快照保留旧预占与同一水位，下一次读取才一起更新。
2. 浏览器首快照送达前的事件不丢；断网后保留旧画面，网络恢复后库存和任务归属追到离线期间的提交。
3. 重复和乱序不会跳过缺口；旧 epoch/tick/version 快照不会改写已确认状态；过期游标不继续盲追。
4. 恢复失败明确显示陈旧并暂停场景操作，重试可复原；续订或请求被拒绝不显示旧授权快照。

本地验收通过：构建通过，单测 134 项、集成 160 项、四库重启对账；Chrome 验证首快照竞态、断线后的库存与任务恢复，以及故意阻断后重试。详见 [验收报告](../../reports/day-30-acceptance.md)。未提交、未推送，未推进 Day31。

## 提交前复验

2026-11-24（Asia/Shanghai），以已推送的 Day29（906a495）为基线复验。pnpm check、134 项单测、160 项集成（Node 61、Jest 99）通过，四个临时 PostgreSQL 库重启后对账通过。08:01:25 的双 Chrome 上下文复验捕获首快照前的 seq 2；离线前后预占 1→2，恢复水位 7，任务恢复；断开快照请求出现陈旧提示和写禁用，重试恢复。Jest 扫描保留的本地 Day29 隔离目录时提示同名工作区包，测试仍全部通过；该目录不纳入提交。
