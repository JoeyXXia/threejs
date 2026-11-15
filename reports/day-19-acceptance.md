# Day 19：持久检查点与提交事件验收

首次实现/验收：2026-11-13（Asia/Shanghai）；2026-11-15 续做收尾。源码起点 `632805b1ada7293c6954f706119fdbbc13fb866e`。范围见 [开发日志](../docs/devlog/day-19.md)，设计见 [ADR 0011](../docs/adr/0011-persistent-runtime-and-events.md)。

## 11 月 13 日实测结果

| 检查 | 结果 |
| --- | --- |
| 客户端生成 | `pnpm db:generate` 退出 0，Prisma 6.19.3 客户端生成成功。 |
| 工程检查 | `pnpm check` 退出 0，lint、strict 类型检查、共享包/API/前端构建通过。 |
| 单元测试 | 纯模拟 19 项 + 前端/算法/契约 65 项，合计 **84 项通过**。 |
| 真实库/API | Node 22 项 + Jest 6 套件 99 项，合计 **121 项通过**。 |
| 双 runner | 两个 Prisma 客户端、不同 owner：有效 lease 内第二个不能准备提交；接管 epoch 增长，旧 runner 提案返回 409 且数据不变。 |
| tick/version | 同一 expectedTick 二次提交被拒；已计算提案遇 WMS 版本变化被拒；相同业务 key 重放不增加事件。 |
| 原子提交 | 注入 SIM_TICK 事件失败，take、余额、任务、审计、检查点与 seq 全部回滚；去除故障后原提案可成功，不留序号空洞。 |
| 可见水位 | 第一事务持锁未提交时，读取水位不前进；第二写者在锁后分配下一 seq；主动回滚不消耗可见序号，更新事件被追加式约束拒绝。 |
| 租约 | 注入慢事件写入与临近到期 lease，整个 tick 被拒，检查点/事件不改变。优雅释放后可从原 tick 续跑。 |
| 事件读取 | 每页最多 100 条；连续分页、viewer 读取、跨空间拒绝、非法/未来游标分别验证。 |
| 真进程重启 | 实际停止 API 子进程，再启动新进程；恢复同一 task，从已提交 tick 继续，不重建库存或重新取货。 |
| 三库重启 | 原回归库、业务写入库、升级夹具库都真实重启；库存、预占、事件及检查点对账零差异，业务写入库核对 13 个检查点。 |

测试环境为 Node v22.14.0、PostgreSQL 18.6 x86_64-windows。原有 >500kB chunk 提示保留，未把构建成功当作性能达标。

### 进程重启证据（11 月 13 日）

```text
taskId         879210e4-e3f2-46af-9efe-9d80fc90f219
停止后保存     tick 2 / epoch 1
新进程恢复     tick 3 / epoch 2
完成           tick 47 / watermark 53
```

该测试操作真正的 API 子进程，不只新建服务对象；同时保留独立客户端的旧 epoch 拒写测试。没有将“一个进程被替换”写成两个完整 API 长时间并行压测。

### 无损升级证据

第三个独立数据库先应用 Day 18 的前 10 条迁移并 seed，再执行 Day 19 SQL。逐行比较 User、Warehouse、InventoryBalance、InventoryMovement、Batch、WarehouseAccess，完全一致，包括测试密码哈希未覆盖。

观测到用户 4、仓库 2、余额 22、流水 22；新增 runtime 2 行，owner/checkpoint 均空，tick/epoch/seq 从 0 开始。这是隔离库升级验证，没有修改用户开发库。旧事件不回填为虚构历史。

## 浏览器证据（11 月 13 日，未于 15 日重录）

Playwright CLI 使用独立 Chrome 和全新 QA 库，通过真实页面启动 1 件已预占运输，完成后整页刷新并等待 Canvas 模型、相机就绪。

```text
taskId                  062a326a-b865-48b1-ac22-8272ca38841b
tick / epoch            47 / 1
页面、库存、事件水位     53 / 53 / 53
返回事件数              53，seq 从 1 连续到 53
库存                    现存 62 / 可用 54 / 预占 1 / HOLD 7
```

最后事件的 taskId/tick 与持久状态一致，刷新不重置任务。这里在完成态核对多个接口水位相等，不宣称活动运行中的不同 HTTP 请求自动共享快照。

[已检查的页面截图](day-19-runtime.png)。11 月 13 日 QA 包装器停止退出 0；本轮未复用 Day 18 的旧截图。

## 复验命令与证据入口

### 11 月 15 日收尾复验

已实际重跑 `pnpm check`、`pnpm test:unit`、`pnpm test:integration`，全部退出 0；单测仍为 84 项，数据库/API 仍为 121 项。三个测试库再次重启，库存/预占/事件/检查点差异均 0，业务库核对 13 个检查点；升级夹具再次确认 4 用户、2 仓库、22 余额、22 流水未改变。

这次 API 进程重启样例 taskId 为 `f5475c57-9898-491e-a8c1-c264972d1e17`，仍从 tick 2/epoch 1 恢复到 tick 3/epoch 2，完成于 tick 47、水位 53。原始 JSON/TAP 会被复验覆盖，当前本地文件对应 15 日；上文保留 13 日的历史测量，不混用截图日期。今天未重录浏览器。最终确认 15432、15434、13004、13019、15174 五个测试/QA 端口均已关闭。

```powershell
pnpm db:generate
pnpm check
pnpm test:unit
pnpm test:integration
# 独立 QA，等 QA READY；从仓库根目录另开终端：
pnpm qa:browser
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day19 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day19 run-code --filename scripts/browser-checks/day19-runtime.js
```

浏览器脚本要求全新普通 seed；结束关闭本轮会话，在 QA 终端输入 stop。仅使用临时数据库/端口和公开测试凭据。

本地原始证据：`reports/day19-restart.json`、`reports/day19-upgrade.json`、`reports/integration-inventory.json`、`reports/integration-transport.tap`、两个单测 JSON 及 Jest JSON。这些临时原始文件忽略入 Git；报告、测试源码和截图纳入提交。

## 限制和未测

- 未实现 Socket、Redis/BullMQ、真实设备、多车冲突、自动发运和永久 ERROR 的恢复命令；没有推进 Day 20。
- 独立数据库客户端的 fencing 与真正 API 重启已测；未做两个完整 API 长时间同时运行的压力测试、数据库网络分区或数据库时钟跳变。
- 默认 5 秒 lease、250ms 驱动、100 条分页为实现选择，未测吞吐/FPS或接管 SLA。粗粒度锁和长事务可能增加等待。
- 所有当前应用业务写入口接入公共边界，不包括离线 seed、直接 SQL 或管理员绕开服务写库。未来写入口必须继续遵循它。
- 事件未做压缩、裁剪和长期容量测量，seq/tick 使用 Int；永久保留策略及过期游标协议尚待设计。
- 11 月 13 日首次真实库运行曾因 scope 对象展开带入 actorId 失败，修正为显式列字段后重跑通过；不隐去失败或把静态类型检查当作运行时证明。
- 历史 PDF/output/tmp 保留，不上传。不创建新标签或部署；远程 CI 结果另查，不预填成功。
