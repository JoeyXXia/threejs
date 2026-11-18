# Day24 — 通道封锁与有界重规划

日期：2026-11-18（Asia/Shanghai）。按实际交付续做 Day24，不按触发次数递增。仅推进本 Day。

## 开工核对与当前实现

核对 `doc/planning/WarehouseTwin-56天每日计划.md` 的 Day24、总体约束、Day23 devlog/验收/ADR、fleet/core/contracts/UI/真实库测试。main 与远端基线一致：`2d4bb5f0570f0febba4f3460d98962ef8d1793ca`。Day23 已有持久 3–5 车、唯一任务归属、原子取放、下一步保守协调、单容量资源许可及等待；尚无动态封锁。用户已有 `reports/day-07-demo.webm` 删除与本地 output/tmp/PDF 保留，不纳入提交。

## 最小方案 / 三个独立审查组

1. **纯核心与反例**：新增 `packages/simulation/src/navigation.ts`、`navigation.test.ts`，修改 `fleet.ts`、`index.ts`。追加可兼容导航版本，空闲格封锁、合法绕行或明确有界暂停，禁止旧路径继续执行；不改旧任务历史，不增加新框架。
2. **权威状态、事务与回归**：修改 `packages/contracts/src/index.ts`、`apps/api/src/simulation/fleet.service.ts` / `fleet.controller.ts`、`packages/database/reconcile.cjs`、`tests/transport/fleet.test.cjs`、`scripts/integration.mjs`。事务外计算、事务内重新授权及版本 fence；地图/路径/告警/历史原子写入；真实库回滚、接管、货物守恒和重启验证。
3. **可观察 UI 与证据**：修改 `apps/web/src/warehouse/FleetPanel.tsx`、`FleetModels.tsx`、`fleet-contracts.test.ts`、`App.tsx`；新增 `scripts/browser-checks/day24-navigation.js`，更新复现说明/README，新增本 ADR/devlog/验收报告及经过检查的截图。UI 输入格坐标和原因、显示地图 revision/红色封锁/暂停原因，Query/Zustand 权限不变。

## 五项可观察验收

1. 占格与当前已确认 `from→to` 段拒绝封锁；viewer 403，越权仓库 404；同 revision 重复设置不重复写事件。
2. 可达时未来路线不含封锁格，不瞬移、不改 task/claim、phase、载荷或电量；历史已走路径不误判为未来路径。
3. 全断路/预算耗尽显示 NO_PATH/BUDGET + ROUTE_BLOCKED；多 tick 不移动/取放/丢货，重开后原任务最多一次 take/drop。
4. 地图变化使旧 revision/旧 runner proposal 提交 409，事件失败则封锁与路径一起回滚，不能半成功。
5. UI 刷新保留地图/暂停/归属；地图变更历史连续可追踪，最终台账一致；实际数据库重启后检查点/资源/导航及库存对账通过。

## 最可能失败的边界

计算期间 runner 进入下一格或布局变更；把旧路段误当当前路径；载货暂停错误释放 TRANSIT/预占/资源；仅替换 APPROACH 忽略未来载货腿；无限逐 tick 重算；在完成车挡路时伪造“最终全部完成”。分别用 stateVersion/tick/layout fence、未来路径切片、保留 phase/claim、双腿验证、仅新 revision 重试与保守占格处理。预算拒绝有合法路也必须暂停，不回退穿墙直线。

## 状态权威与同步边界

见 [ADR0015](../adr/0015-controlled-closures-and-bounded-replanning.md)。PostgreSQL 权威，纯核心出提案、NestJS 认证/事务，React/R3F/Drei 展示，Query 同步、Zustand 仅选择。不引入生产机器人控制、消息队列、新服务、框架、Socket 或 Day25 故障恢复。

## 验收命令与证据

```powershell
pnpm check
pnpm test:unit
pnpm test:integration
# 集成环境退出后，独立终端（保持 stdin）
pnpm qa:browser
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day24 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day24 run-code --filename scripts/browser-checks/day24-navigation.js
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day24 close
# QA 输入 stop 并等待退出
git diff --check
```

实际结果、截图、水位、重启时间及限制在 [验收报告](../../reports/day-24-acceptance.md) 记录；未测量不填。构建既有场景大 chunk 警告不在本日优化。通过后仅按三个审查组提交，正常推 main，无标签/部署/PDF 归档。

最终 `pnpm check` 通过，单元115/115（44+71）、真实库集成143/143（44+99），PG重启三库差异0。浏览器首轮记录了 robot-1 被停车车保守阻挡的完成超时，不算整体验收；全新QA第二轮用 robot-2 完整通过，55批持久tick、四次地图变化、66条连续事件，刷新保留暂停，解封后原任务完成且库存对账一致。两张人工检查截图在 reports，原始诊断/本地PDF未提交。第二轮之后再执行 lint 与 diff whitespace 检查。
