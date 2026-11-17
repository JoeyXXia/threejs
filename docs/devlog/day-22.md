# Day 22：持久多车分配与保守下一步协调

日期：2026-11-17（Asia/Shanghai）。源码基线与本轮开始时远端 main 为 `53d42c5bb65ffa4ac48be0add64625a38ad23dcc`，对应已验收的 Day 21。依据 `doc/planning/WarehouseTwin-56天每日计划.md`、最近 devlog、实际单车 runner/测试确定续做 Day 22，不按定时触发次数加一。早间只完成纯核心，历史现场保留在 [阶段进度](../../reports/day-22-progress.md)；本轮补齐持久化、API、页面与全链路验证。未推进 Day 23，未生成 PDF、发布标签或部署。

## 当前实现摘要与最小方案

基线已有持久单车检查点、QC 上架/出库搬运、人工发运、库存业务幂等键、数据库 lease/epoch/tick/version fence。本日不是复制三个内存 runner：复用既有领域服务、仓库/runtime 锁、纯路径与 phase，增加一个统一车队检查点和数据库永久任务归属。

拆为三个可独立审查的改动：

1. **纯计算核心**：`packages/simulation/src/fleet.ts`、`fleet.test.ts`、`index.ts`、`scripts/day22-fleet-demo.mjs`。3–5 台车，任务唯一归属/一车一活动任务；集中判断下一格，固定优先级→连续等待→稳定 id 排序。
2. **权威与事务**：`packages/database/prisma/schema.prisma`、`202611170001_fleet/migration.sql`、`reconcile.cjs`；`packages/contracts/src/index.ts`；API `fleet.service.ts`、`fleet.controller.ts`、`simulation.service.ts`、`app.module.ts`；`tests/transport/fleet.test.cjs`、`scripts/integration.mjs`。加入唯一 claim、批次过账、模式兼容、授权、数据库约束与失败/接管/重启验收。
3. **读取与证据**：web `FleetPanel.tsx`、`FleetModels.tsx`、`fleet-data.ts`、`fleet-contracts.test.ts`、场景/视图接线和 App 标题；`scripts/browser-checks/day22-fleet.js`、复现说明、ADR/报告与验收截图。Query 按用户/空间/仓库隔离；R3F/Drei 只插值确认段，无逐帧 React setState。

## 五个可观察验收条件

1. 同领域任务并发双领只能一个成功，同车相同请求重试不重置；忙车不能再领第二活动任务。
2. 3–5 台车无同格、edge swap 或进入他车本 tick 起始占格；idle/完成/ERROR 车辆持续占格。
3. UI/API 可读等待原因、阻挡车和连续/累计 tick；对向或共享服务点不能完成时保留真实等待。
4. 所有车的接受位置、phase、载荷、claim、取放库存/流水、检查点和事件同事务；故障整批回滚，过期提案/旧 owner 拒绝，实际数据库重启后无对账差异。
5. 五车真实页面可见，三台不同车分别完成真实上架；五车并发出库保持归属和等待，刷新不重置；viewer 只读、跨空间不可读。

## 状态权威与事务/同步边界

PostgreSQL 的库存/预占/领域 phase、`WarehouseRuntime.fleet`、tick/version/seq 和 `FleetClaim` 是权威。纯 `assignments` 历史不是跨进程唯一锁；`proposalKey` 不是库存业务唯一键。数据库唯一索引保证仓库/kind/task 唯一、active 仓库/robot 唯一，触发器拒绝变更归属/删除/重新激活并核对载荷与领域阶段。

分配先在事务外规划，再按 ACL SHARE→Warehouse→WarehouseRuntime 上锁重查版本/布局/电量，创建领域任务、claim、车队快照及事件同事务。runner 先取得数据库时钟租约/epoch，在事务外做统一一步提案；提交先按稳定顺序锁操作员 ACL，再锁 runtime 并检查 owner/epoch/expectedTick/version。所有接受效果复用原 take/drop 服务，一起过账，尾部再次检查租约。任何失败不留下部分车位/库存；权限/布局/账本异常停止活动任务，保留最后车位、载荷和在途货物。

未启用车队时旧单车 API 不变。只能旧任务完成后显式初始化，保留原车位置/电量/统一 tick；旧地图不兼容则拒绝。切换后不允许旧启动覆盖、重置/缩放车队或让异常载荷消失。完整理由见 [ADR 0013](../adr/0013-persistent-fleet-coordination.md)。

## 验收命令与记录

```powershell
pnpm db:generate
pnpm check
pnpm test:unit
pnpm --filter @warehouse-twin/simulation build
node scripts/day22-fleet-demo.mjs
pnpm test:integration
# 等隔离测试 PostgreSQL 完全关闭后再启动：
pnpm qa:browser
# 独立 Playwright CLI 会话步骤见 scripts/browser-checks/README.md
```

最终实测数量、事件水位、库存摘要、截图和失败修正统一记录在 [Day 22 验收报告](../../reports/day-22-acceptance.md)，不以早间纯核心数字替代当前整体验收。Git 提交/推送核对在本轮最终交付回复记录；验证或推送未通过则不得视为完成。原有录像删除、output/tmp 和本地 PDF 均不暂存。

## 最可能失败的边界与明确限制

- **安全不等于活性**：共享 QC/暂存服务点、窄路对向或完成停车会阻挡其他车；真实并发反例保留等待/货物，不伪造完成。三车上架正例刻意顺序执行，不宣称三车同时通过共享 QC。
- **旧数据/竞争**：不兼容旧布局、双客户端领取、过期版本、租约接管、取货时事件异常、取货后撤权均有回归；禁止绕过领域服务直接改库存。
- 所有产品车辆初始 priority 相同，无优先级配置台；无通道/工作站资源许可、动态重规划、自动回充、产品级恢复、真实机器人或 Socket。纯分配历史上限 10000，不做长周期吞吐/FPS 结论。
- 已测真实数据库重启、独立客户端租约接管；没有单独宣称新增 fleet API SIGKILL 故障已测。旧单车相关回归不能冒充新车队同类故障证据。
