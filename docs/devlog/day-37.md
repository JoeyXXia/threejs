# Day37 — 发运日报的失败追踪、重跑与重投

日期：2026-11-27（Asia/Shanghai）；这是上午补跑，仅推进 Day37。基线 GitHub `main`：`abf6edbd72f358107bf9784bc23f6de5581a347a`。Day36 已验收发运与待办同事务及 Redis 暂停恢复，单次处理失败仍缺少持久终态和受控重跑。

## 三组可独立审查的改动

1. **持久状态与代次栅栏**：Prisma 迁移、`dispatch-report.ts`。同一仓库、发运事件序号和格式版本仍只对应一行；结果和完成时间同事务写入。迁移不清理旧任务，兼容 Day36 未带代次的 Redis 消息（视为代次 0）。
2. **重试与重跑**：`main.ts`、`retry.ts`。一个稳定传输 ID 绑定一个代次；新入队任务最多尝试 3 次，指数退避基数 500 ms。最后一次失败时写 PostgreSQL；若失败时数据库不可达，之后从 Redis 保留的失败任务补记。运维只能显式指定未完成、已失败的任务和当前代次；重跑递增代次，不改源键或库存。
3. **故障证据**：新增真实并发和 Redis/子进程集成用例，[验收报告](../../reports/day-37-acceptance.md)及运维命令。不新增 API、UI 或框架。

## 权威与风险

PostgreSQL 的业务唯一键、完成结果和代次是权威，Redis 的 jobId 只做传输级去重。最容易失败的是结果已提交而 Redis 尚未确认时进程退出；以及 Redis 任务已删后再次投递、旧代次与新代次交叉。在更新前后均检查代次和状态，旧投递不能改已经存在的结果或覆盖新代次。失败元数据保留最近一次终态，不记录原始连接串，也不是全量尝试日志。

升级时先停 Day36 worker，再迁移和启动 Day37 worker；保留 Redis 队列和 PostgreSQL 数据，不混用两个版本的 worker。无部署、无额外定时任务，不推进 Day38。

参考：[BullMQ 重试与退避](https://docs.bullmq.io/guide/retrying-failing-jobs) · [BullMQ jobId 的去重范围](https://docs.bullmq.io/guide/jobs/job-ids)。

专项和全量验收通过：耗尽 3 次后记录失败，运维重跑仅推进代次 `0 → 1`；提交后进程退出、自动重投、删除 Redis 任务后重投都不改首次结果或库存。146 项单测、169 项集成及 4 库重启对账通过，独立 Compose 也成功生成日报。详见 [Day37 验收报告](../../reports/day-37-acceptance.md)。
