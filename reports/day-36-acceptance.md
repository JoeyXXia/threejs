# Day36 验收 — 发运事务、Redis 暂停和日报补处理

日期：2026-11-26（Asia/Shanghai）；基线 `05d3846`。

## 可观察验收条件

1. 在真实 PostgreSQL 事务插入发运事件和待办后，另一连接看不到它们；注入回滚后库存、水位与待办未变。重试实际发运产生且仅产生一份待办。
2. Redis/BullMQ 正常时，独立 worker 按已提交源事件所在仓库、UTC 日和水位写入日报；不把请求审计事件或模拟 tick 算作发运。
3. 暂停隔离 Redis 容器，实际观察投递失败。此时第二次发运和车队 tick 仍提交，对账一致，未完成待办保留。
4. 恢复 Redis 后第二份报告完成，第一份的旧水位结果不变；报告过程不改库存。Compose 可选服务和 worker 镜像可校验。

## 复验命令

```powershell
pnpm install --frozen-lockfile
pnpm db:generate
pnpm check
pnpm test:unit
docker pull redis:7.4-alpine
$env:TEST_DISPATCH_REDIS='1'      # 测试只暂停自己创建的临时容器
$env:TEST_API_PORT_BASE='13040'   # 如默认测试端口被 Windows 保留
pnpm test:integration
docker compose --env-file .env -f infra/compose.yaml --profile reports config --quiet
docker compose --env-file .env -f infra/compose.yaml --profile reports build report-worker
git diff --check
```

默认集成总是检查发运事务；有 Docker 时显式启用 Redis 暂停用例。测试数据、日志和 JSON 证据仅留本地。

## 已取得的证据

- `pnpm install --frozen-lockfile`、`pnpm db:generate` 和 `pnpm check` 通过，单测 146 项（core 55、web 91）。Vite 仍提示产物 chunk 偏大。
- Compose `reports` 配置通过，镜像最终构建成功。在独立 Compose 项目，使用真实出库服务执行分配、取放与发运，容器内 worker 生成一份 `format=1` 的日报，源水位 `6`、`dispatchedOrders=1`；测试项目的容器、网络和临时卷已清理，未部署。
- 21:59（上海时间）的故障用例使用 Redis 7.4.12：暂停期间观测到投递失败，数据库保留 1 条未完成待办，第二笔发运及 3 个车队 tick 已提交，库存为现存 60、预占 1 且对账通过。恢复后水位 `6` 与 `13` 的 v1 日报分别为 `1` 与 `2` 单；旧水位结果不变，worker 未改变库存。
- 同一集成轮次验证了另一 PostgreSQL 连接看不到未提交的发运事件和待办；注入回滚后库存与水位原样，实际重试发运仅写入 1 条意图。
- 启用真实 Redis 暂停用例的 `pnpm test:integration` 通过：Node 68 项、Jest 99 项，4 个隔离 PostgreSQL 测试库重启后对账通过；最终 lint 和 `git diff --check` 通过。

## 限制

日报使用源事件记录时间的 UTC 日和来源水位，不是按上海日切的定时任务，也不是库存表或对外承诺的 SLA。升级不向历史发运补写待办；未测大事件表上新增部分索引的迁移时间。Redis 为开发 Compose 内网服务，不暴露宿主端口；worker 幂等重跑、永久失败及重试策略由 Day37 验收。
