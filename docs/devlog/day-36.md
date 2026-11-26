# Day36 — 出库发运日报和事务 Outbox

日期：2026-11-26（Asia/Shanghai）。已核对 Day35 的浏览器录像、验收报告和 GitHub `main` / `v0.5-operations`，均归档于 `05d38462fea213013de5647d80d8af6a5880dc78`。Day36 之前 PostgreSQL 有业务和回放事件，尚无 Redis、后台 worker 或待办持久表。

## 三组可独立审查的改动

1. **持久意图**：迁移、Prisma 模型和仓库事件追加，只有真正发运的 `OUTBOUND_DISPATCHED` 创建日报待办；同一事务包含出库状态、库存流水、事件和待办。
2. **后台投递**：`apps/api/src/jobs`、`infra/compose.yaml` 和 worker Dockerfile。独立 Node 进程从 PostgreSQL 查询待办、用 BullMQ 投递并生成报告；NestJS API 与仿真 runner 不建立 Redis 连接。
3. **验收与运维**：运输集成用例、隔离 Redis 故障用例、README 和 [Day36 验收](../../reports/day-36-acceptance.md)。不新增 HTTP API、前端、历史回填或发布。

## 权威与故障边界

- PostgreSQL 已提交的事件和库存账本是权威。日报 v1 只衍生 `format / spaceId / warehouseId / utcDay / throughSeq / dispatchedOrders`，统计该仓库 UTC 日内、到指定水位为止的实际发运单数，不复制库存，不推进仿真。
- 投递只读已提交待办。Redis 返回接收成功只会更新下一次扫描时间，不能标记完成；worker 从库中重查意图和源事件，用条件更新在同一个 PostgreSQL 事务保存结果和完成时间。Redis ID 只是传输去重，数据库源键和条件更新才是结果保护。
- 最易失败的边界是队列接收了任务，但结果还没写回数据库；未完成待办仍能被扫描。进程退出、永久失败的有限重试策略和受控重跑留到 Day37；不声称恰好执行一次。

参考：[BullMQ 连接配置](https://docs.bullmq.io/guide/connections) · [Redis 不可用时快速失败](https://docs.bullmq.io/patterns/failing-fast-when-redis-is-down)。这里快速失败的是独立投递连接，不是发运请求。

## 本轮实测

通过 146 项单测、167 项集成和 4 个隔离库重启对账；Compose 镜像构建、容器内 worker 真实读取 PostgreSQL 并生成日报通过。暂停 Redis 期间保留 1 条待办，实际发运与 3 个车队 tick 仍提交；恢复后补生成第二笔发运对应的日报，旧水位报告不变。未改本地 PDF 和用户已有改动，未执行 Day37 或部署。
