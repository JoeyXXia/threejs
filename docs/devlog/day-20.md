# Day 20：机器人取放货与 WMS 原子衔接

起始核对：2026-11-16；续做验收：2026-11-17（Asia/Shanghai）。基线为已推送的 Day 19 `0d991e944fd0b891922e2b481bc4a33aa61d1822`。按 `doc/planning/WarehouseTwin-56天每日计划.md`、Day 19 devlog/报告和实际代码确定下一项为 Day 20，不按触发次数或日期跳天。保留用户既有录像删除、`output/`、`tmp/` 和本地 PDF。

## 当前实现与最小方案

Day 19 已原子提交出库取放货、检查点、载荷和事件，Day 10 已有内部发运领域方法，但缺少质检放行上架和操作员 HTTP/UI 发运入口。本轮只补这两条链路，复用 React/R3F/Drei、Query/Zustand、NestJS/PostgreSQL 和纯单车核心；不加入 Socket、多车、真实设备、额外框架或 Day 21 发布。

分成三组可独立审查的改动：

1. **上架领域与持久 runner**：Prisma `PutawayTask`/迁移；`putaway.service.ts`；模拟服务 kind 分支与兼容契约；RobotPanel 类型/来源/目标选择；对账和盘点活动保护；升级检查脚本。
2. **人工发运**：`TransportService.dispatchInTransaction`；`OutboundService` 幂等命令；Controller 发运路由；OutboundView 显式确认与不确定结果重试。
3. **测试与证据**：直接领域/真实库测试、上架 API 真中断重启、旧检查点契约测试、完整浏览器链路与丢响应重试；ADR 0012、验收报告和 README。

## 五个可观察验收条件

1. PASSED 整单通过机器人 QC → TRANSIT → STORAGE，落货后 reserved=0，库存可分配；搬运不改变全仓 onHand。
2. 同一 task/phase 重复调用、重复 expectedTick 或已提交后丢失响应不重复记流水；取/放阶段故障回滚余额、phase、审计、检查点及事件水位。
3. 独立写连接不能抢占同一储位最后容量或混入不同批次；盘点冻结、过期、未放行、viewer/跨仓请求在写入前被拒。
4. 上架取货后真正停止/重启 API，从持久 tick 下一步续跑，epoch 递增；不重新初始化任务或重复取货。
5. 整单全部到暂存区后仍不扣全仓现存，只有操作员确认发运扣减；同请求键重试只扣一次，三库重启后物理/预占/事件/检查点对账无差异。

## 状态权威、事务与同步边界

PostgreSQL 为唯一业务权威。ACL SHARE → Warehouse → WarehouseRuntime 为统一写锁顺序；几何/A* 与纯 tick 在事务外计算，提交时复查布局、版本、租约/epoch。上架创建同事务预占来源与目标容量；取/放阶段同事务写领域 phase、TRANSIT/货位余额、唯一流水、审计、载荷、tick 与事件，租约过期则整笔回滚。人工发运同事务检查整单到齐、扣暂存预占/现存、记 DISPATCH 流水、更新订单和持久幂等响应。

页面只显示已确认轨迹和重读库存，不以动画、墙钟或乐观缓存推进业务；所有新写请求复用权限与仓库隔离。旧 format=1 出库检查点通过缺省 kind/receipt 兼容。详见 [ADR 0012](../adr/0012-putaway-and-operator-dispatch.md)。

## 最可能失败的边界与限制

- 空储位虽然没有 onHand，仍可能已被上架任务预留；容量、批次和盘点不能只看余额。
- QC/在途预占不是普通出库 Allocation，必须进入预占对账；储位落货不继续预占。
- 数据库已提交但客户端未收到响应：重试不能依赖 UI 成功标记；发运复用持久请求键，tick 依赖 fencing。
- 任务/布局/权限/version 在路径计算后变化必须拒绝旧提案；ERROR 不自动恢复，不提供手工改库存的恢复入口。
- 只做整单单储位上架、单车、全量发运。创建时检查批次过期；无在途过期自动释放/回库策略。无生产吞吐、帧率或并发性能结论。

## 验收命令

```powershell
pnpm db:generate
pnpm check
pnpm test:unit
pnpm test:integration
pnpm qa:browser
# 新隔离 QA 环境、浏览器登录后执行：
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day20 run-code --filename scripts/browser-checks/day20-putaway-dispatch.js
# 关闭浏览器，向 QA 终端输入 stop，检查退出。
```

实际验收：生成客户端、check 均通过；单测 85（19+66）、真实数据库/API 测试 127（28+99）通过，无失败/跳过；三库重启后物理、预占、事件和检查点差异均为 0。上架在取货后真中断重启，tick 15→16、epoch 1→2，最终 tick 34。浏览器 fresh QA 全链路通过，现存 62→66→66→66→62，暂存预占 4，已提交发运丢响应后同 key UI 重试不重复扣减，最终对账一致；两次脚本修正和限制均保留在 [Day 20 报告](../../reports/day-20-acceptance.md)。

Git 交付要求：仅本轮相关文件按上述三组提交并正常推送 main，远端必须包含本轮提交才算 Day 20 完成。最终 SHA 和远端核对由本轮最终回复记录；若推送失败保持本 Day 待交付，不推进 Day 21。未改动本地 PDF，不暂存原有录像删除或 output/tmp，不发布标签或部署。

审查提交：`bbd713e`（整单上架/持久 runner）与 `84beae1`（人工发运）；本文件、验证脚本及截图随第三组验收证据提交。远端提交状态以实际 main 核对为准。
