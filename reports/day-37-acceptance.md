# Day37 验收 — 有限重试、受控重跑与重投

日期：2026-11-27（Asia/Shanghai），基线 `abf6edb`。

## 可观察验收

1. 向真实 PostgreSQL 注入报告写入故障：BullMQ 耗尽 3 次，无半成品，PostgreSQL 保留失败代次、失败时间与次数。
2. 故障修复后通过运维命令只重跑指定失败代次；重复运维请求、过期代次、已完成报告不能重新改写。
3. 子进程在真实 PostgreSQL 提交以后、Redis ACK 以前退出；BullMQ 重投后，该业务键的行、结果和第一次完成时间均不变。
4. 删除 Redis 任务后重新入队并确认实际消费；仍不重复生成结果、不改库存；Day36 的 Redis 暂停/恢复回归继续通过。

## 复验命令

```powershell
pnpm db:generate
pnpm check
pnpm test:unit
docker pull redis:7.4-alpine
$env:TEST_DISPATCH_REDIS='1'
$env:TEST_API_PORT_BASE='13040'
pnpm test:integration
git diff --check
```

不启用 Docker 时仍运行 PostgreSQL 并发和代次校验；启用后仅操作本轮测试创建的 Redis 容器。注入故障使用隔离数据库，生产 worker 没有测试故障开关。

## 本轮实测

- Prisma client 生成、`pnpm check`、最终 `pnpm lint`、146 项单测及 worker Compose 镜像重建通过。新镜像在独立 Compose 项目实测处理一笔真实发运，水位 6、日报发运数 1；仅清理本轮测试环境，未部署。
- 10:40（上海时间）隔离定向复验，两条 Day37 用例通过。真实 BullMQ 用尽 3 次后记录失败，修复后通过运维命令从代次 0 进入 1。故意在结果提交后、ACK 前退出（退出码 73），Redis 状态仍是 `active`；替换 worker 自动重投一次，删除任务再重新入队后又处理一次。两次重投都未改数据库原结果或首次完成时间。
- 两个已发运业务键各一份报告，水位 `6` / `12` 的累计发运数分别是 1 / 2；重投前后现存 60、预占 0、可用 53、待检 7，库存对账一致。首次独立用例因继承生产队列的 30 秒停滞检查租约，在 20 秒窗口内未看到重投；改用独立测试命名空间复验，没有改变生产 worker 的租约。
- 全量集成 169 项通过（Node 70、Jest 99），包含 Day36 真实 Redis 暂停恢复及两条 Day37 用例；4 个隔离 PostgreSQL 库重启对账通过。Jest 仍报告既有 Day29 嵌套工作树的同名包警告。`git diff --check` 通过。

## 适用边界

3 次上限适用于一个保留的 BullMQ 任务，Redis 丢失尚未在数据库记录的处理计数时，重建任务可能重新计数；不承诺全局恰好一次。数据库保留一个业务结果和最近一次终态失败证据，不做告警平台、通用队列或自动无限重跑。Day36 已入队的历史任务继续沿用其旧重试参数。
