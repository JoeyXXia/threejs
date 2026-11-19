# Day25 — 设备故障与载货恢复

日期：2026-11-19（Asia/Shanghai）。本轮仅 Day25，不以日期/触发次数递增。

## 开工核对

本地 main 与 `git ls-remote origin refs/heads/main` 同为 `bf8d5f7c3076badf3c3b14e365ce8d5b2e4c3a60`。已读 doc/planning 每日计划/总计划约束、最近 Day24 devlog/验收/ADR、simulation/fleet/navigation、contracts、fleet API、Transport/Putaway、数据库约束和真实库测试。Day24 已交付空闲格封锁、有界重规划/暂停及旧提案拒绝；当前缺少可操作的设备故障/维修与安全取消。未发现本项目冲突进程。

原有 `reports/day-07-demo.webm` 删除以及 output/tmp/本地PDF保留，不暂存。沿用 React/R3F/Drei、Zustand/Query、NestJS/PostgreSQL，不添加框架、消息服务、真实控制或 Day26 充电。

## 最小方案与三个审查组 / 涉及文件

1. **纯核心**：新增 `packages/simulation/src/recovery.ts` / `recovery.test.ts`；修改 `fleet.ts`、`navigation.ts`、`index.ts`。设备故障独立于运输phase，按边界停住，维修保留原阶段；导航与设备暂停互不误清；取消只在取货前且保留占格和历史。
2. **权威与事务**：修改 `packages/contracts/src/index.ts`、API `simulation/fleet.service.ts` / `fleet.controller.ts`、`transport/transport.service.ts` / `putaway.service.ts`；新增 `202611190001_cancel_phase` / `202611190002_recovery_guards` 两个迁移，修改 schema和 `reconcile.cjs`；更新 `tests/transport/fleet.test.cjs`、`scripts/integration.mjs`。严格控制接口、原子审计/检查点/领域取消、旧提案拒绝；只放宽取货前取消的数据库状态边。
3. **可观察界面和证据**：web `FleetPanel.tsx`、`FleetModels.tsx`、`fleet-contracts.test.ts`、`App.tsx`、`styles.css`；新增 `scripts/browser-checks/day25-recovery.js`，更新 README/复现说明、本ADR/devlog/验收报告和经检查的截图。显示PAUSED/NEEDS_RECOVERY、阶段和故障起始tick，原生禁用非法操作。局部表格折行避免本日长资源列表溢出。

## 五个可观察验收条件

1. 四个未完成阶段均可在提交边界注入故障；后续tick不移动、不耗电、不取放、不清货物/claim/目标容量或占用许可。
2. 维修从原phase/phaseTicks/claim继续，不重复take/drop；刷新/接管/真实PG重启不把故障车重置为可运行。
3. APPROACH/LOADING 取消原子释放来源预占及目标容量，无物理库存流水；保留任务墓碑/原地占格/设备故障，重复或旧claim操作不重复释放。
4. 载货、卸货中及完成后不能直接取消或重开；数据库也拒绝载货阶段改CANCELLED；导航解封不等于设备维修。
5. viewer403、跨空间404、伪造字段400；事件失败检查点/货物/领域阶段/审计整体回滚，旧提案409；每项成功控制均有操作者、原因和连续事件。

## 权威/事务与最易失败边界

PostgreSQL保存设备故障和原任务，NEEDS_RECOVERY从故障+loaded推导；纯核心提案、NestJS锁下授权和写入，Query展示，Zustand不保存第二份业务状态。详见 [ADR0016](../adr/0016-phase-preserving-device-recovery.md)。危险窗口是取货恰逢取消/故障、卸货后迟到维修、复用旧claim、双暂停互相误清、取消时误释放物理通道或关闭载货claim。用仓库/runtime锁、最新phase/claim校验、stateVersion fence、独立暂停原因与不变物理占格限制。

取消仅指运输任务，不新增整单取消/重开；历史ALLOCATION保留，已取消来源不可重领，需新业务单据继续。通用ERROR/撤权/耗尽不通过软件维修强行恢复；不保证任意布局全局无死锁。

## 验收命令

```powershell
pnpm db:generate
pnpm check
pnpm test:unit
pnpm test:integration
# 集成数据库完全退出后，保持独立终端 stdin
pnpm qa:browser
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day25 open http://127.0.0.1:15174 --browser chrome
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day25 run-code --filename scripts/browser-checks/day25-recovery.js
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day25 close
# QA stop 后等待退出
git diff --check
```

实际结果、失败修正与限制记录于 [Day25验收报告](../../reports/day-25-acceptance.md)。仅验收通过才明确暂存上述文件，按三组提交并正常推main；不触发部署/标签/PDF任务。

最终check通过；单元122/122（50+72），集成152/152（53+99），真实PG重启三库差异0。新上架夹具首轮400已修正并全量重跑。浏览器功能首轮通过后修复长资源表溢出及截图轮询滞后，新库复验完整通过：载货故障原地持通道许可、刷新保留、维修原claim完成；75条连续事件/57批tick、五次有原因控制，唯一取消/取放，最终库存对账一致。两张最终截图在reports，非同水位截图差异与限制如实记录。
