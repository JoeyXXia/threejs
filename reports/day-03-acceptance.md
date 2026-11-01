# Day 3 验收报告：布局、货位与库存基础

日期：2026-11-01（Asia/Shanghai）。基线 `66edbd1`，报告对应其后的本地 Day 3 改动，不把基线 SHA 当作本次实现 SHA。

## 环境和样本

Windows x64，Node v22.14.0、pnpm 11.25.0、Prisma/Client 6.19.3、Nest 12.2.0。没有新增依赖或服务。真实 DB `SELECT version()` 为 `PostgreSQL 18.6 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit`；不是 SQLite、内存数据库或 ORM mock。

两个空间各一仓，固定合成布局 v1。测试 API 使用 13001 / 13002、测试 DB 15432；开发库另在 5432。测试 runner 不读开发 `.env`，使用随机凭据、独立临时集群，finally 停止服务。数据库重启后的实际查询结果：

| 项目 | 每仓实际值 | 两仓合计 |
| --- | --- | --- |
| 网格 | 30×20，cellSize=1 | 两张隔离副本 |
| 区域 / 货架 | 6 / 2 | 12 / 4 |
| 业务货位 | 17（12 储存 + 5 工作站） | 34 |
| SKU / 批次 | 2 / 2 | 4 / 4 |
| 余额 / OPENING 流水 | 11 / 11 | 22 / 22 |
| onHand / reserved | 62 / 0 件 | 124 / 0 件 |
| available / HOLD | 55 / 7 件（HTTP 样本查询） | 同规则各仓独立 |

每仓货架投影 6 个不可通行格；BFS 实测其余 594 个地面格连通，所有服务点均在连通地面上。储位坐标位于货架投影内，而 serviceCell 在相邻地面；两层共享服务点不代表真实举升模拟。

## 5 项可观察验收

| 条件 | 实际验证 | 结果 |
| --- | --- | --- |
| API 提供有版本的真实布局和库存 | layout/inventory 与 DB 逐行/汇总对照，返回空位，含 layoutId/version；API 重启后身份及结果保持 | 通过 |
| 货位服务点合法且样本通道连通 | BFS、货架投影核对、服务点范围/邻接断言；无效草稿发布、已发布快照修改被拒 | 通过 |
| 数量和归属约束在 DB 生效 | 负数、超预占、容量合计、混 SKU/批次、跨仓 endpoint、SKU/batch 错配全部拒绝；真实并发容量争抢仅成功一个 | 通过 |
| 初始库存可追溯且 seed 不重复入账 | 重复/并发 seed 前后 ID、余额、流水不变；强制流水插入失败则整个 seed 事务回滚 | 通过 |
| 余额可由完整流水重算并持久化 | 期初、测试转移两端、零净额键均重算一致；故意制造偏差/缺行能检测；DB 重启后 0 差异 | 通过 |

## 执行结果

- `pnpm db:generate`：通过。
- `pnpm check`：lint、strict 类型检查、web/API 生产构建通过。
- `pnpm test:integration`：**2 suites，44 tests passed，0 failed**；其中 Day 3 专项 26、Day 2 回归 18。
- 3 条迁移在全新测试库成功部署；Jest 后实际停止并重启 PostgreSQL，所有余额/流水重算一致。
- 原 Day 2 开发库仅有 `202611010001_identity`；本次成功增量应用 `202611010002_layout_inventory` 与 `202611010003_inventory_constraints`。比较前后：4 个用户及凭据不变、仓库名称与业务版本不变；seed 后 22 余额、22 流水。
- `pnpm reconcile`：`consistent: true`，`mismatches: []`。
- `pnpm smoke --dev-api --with-auth`：健康响应、404、HTML、React 模块、匿名 401、代理登录/身份/退出/旧令牌拒绝通过。

本地原始证据为 `reports/day-03-environment.json`、`reports/day-03-jest.json`、`reports/day-03-inventory.json`，均可由测试命令重新生成，作为本地构建产物忽略入 Git。增量升级前后核对结果在忽略目录 `.local/day-03-upgrade-evidence.json`；没有把凭据本身写入报告。

## 关键失败和事务证据

首次开发库核对早于数据库 ready，连接失败；就绪后重新执行，迁移与比较通过。没有失败测试被填成通过。

测试库中的强制失败触发器只用于证明期初流水写入异常时不会留下余额或半套布局；finally 移除触发器。完整转移和新版本身份复用在最终回滚的测试事务里执行，不创建真实运输任务。两个连接竞争容量的临时余额最后清理，最终全量重算再次通过。

## 边界与未测事项

- 不包含库存写 HTTP API、入库/质检命令、分配、目标容量预留、盘点冻结、transit、任务或发运。reserved 只有基本约束，今天均为 0，不宣称已有预占账本。
- 重算覆盖 onHand；DB 不会强制每个合法正数余额变更都同时产生流水，维护端必须遵循事务约定并运行对账。故意的偏差测试验证了检测能力。
- 每个 HTTP 响应内部用 Repeatable Read；两个请求之间不是同一快照。未来前端组合布局/库存需对照 layoutId/version。
- 发布检查验证几何/服务点；只对当前固定样本实测 BFS 连通，不保证任意地图连通、无死锁或可调度。
- 无 R3F 场景、库存 UI、浏览器端到端测试、FPS/吞吐/压力测试，也未实测 Compose。样本数不能当作性能规模。
- 本次数据库重启后的对账不等于模拟器 lease/epoch 恢复（尚无 runner）。完整 T01–T16 验收仍未完成。
- 便携开发 DB 在 TEMP，可能被系统清理；不作为正式仓储存储。此次未验证生产部署或跨平台 runner。

设计说明见 [ADR 0003](../docs/adr/0003-layout-and-inventory-foundation.md)，实际过程见 [Day 3 日志](../docs/devlog/day-03.md)。
