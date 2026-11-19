# Day26 — 电量、充电与无进展

日期：2026-11-19（Asia/Shanghai）。开工确认本地与远端 main 同为 `7b3a6b26d4caf91053f23719c910dcd4ba37becf`；Day25 真实库/浏览器证据已经记录并提交。对照每日/总计划，核对车队步进、资源仲裁、封锁、故障、领域过账和相关测试，确认缺的是回充准入、充电动作与无进展诊断。已有录像删除、output/tmp 与本地 PDF 保留。

## 最小改动与审查组

1. **纯核心与反例**：`packages/simulation/src/energy.ts`、`energy.test.ts`、`fleet.ts`、`resources.ts`、`navigation.ts`、`simulation.ts`、`task.ts`、`index.ts`。整数耗费、容量受控的充电步进、低电量停止及稳定告警键。
2. **持久化与回归**：`apps/api/src/simulation/fleet.{service,controller}.ts`、`packages/contracts/src/index.ts`、`tests/transport/fleet.test.cjs`、`scripts/integration.mjs`。接单预算、授权充电命令、检查点/事件原子提交与真实库证据。无迁移，无新服务。
3. **操作界面与证据**：`apps/web/src/App.tsx`、`warehouse/FleetPanel.tsx`、`FleetModels.tsx`、`fleet-contracts.test.ts`，`scripts/browser-checks/day26-energy.js`、复现说明、README、ADR、日志和验收报告。现有 React/R3F/Drei、Query/Zustand 分工不变。

## 可观察验收

1. 接单预算计入取货、载货卸货、空载回充和余量；不足或回充不可达，拒绝且不新增领域运输、容量预占或归属。
2. 两车争用同一充电位只能有一个物理占位；仅在已到位的确认 tick 加电，不超过100%，满电仍保留实际占用。
3. 已载货而剩余耗费过高时不挪车、不扣电、不再次取放，不释放原归属/在途库存。
4. 20个连续等待 tick 显示 NO_PROGRESS；同一等待段仅一条告警进入事件，冲突不通过瞬移消除；权限/版本/地图检查拒绝无效操作。

## 最可能失败的边界

回充估算不是预约：有充电路径不意味着当时有空位；满电停车仍可能堵住另一辆。充电与封路/接单竞争使用同一版本门禁，必须停止旧计划才可封锁其未走路径。持久检查点中的载货停机、设备故障和交通告警不能互相当成安全解除。详见 [ADR0017](../adr/0017-fleet-energy-and-stall-diagnostics.md)。

## 验收命令

```powershell
pnpm check
pnpm test:unit
pnpm test:integration
# 确认集成 PostgreSQL 已退出，另开隔离 QA
pnpm qa:browser
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day26 open http://127.0.0.1:15174 --browser chrome
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day26 run-code --filename scripts/browser-checks/day26-energy.js
npx --offline --yes --package @playwright/cli@0.1.24 playwright-cli -s=warehouse-day26 close
# QA 输入 stop，等待退出
git diff --check
```

实测结果和明确限制见 [Day26 验收报告](../../reports/day-26-acceptance.md)。不推进 Day27、不做发布/部署、保留本地 PDF。

最终 check 通过，单元 128/128、集成 155/155；三个隔离库真实重启对账一致。浏览器完成真实出库后验证 99.40% → 100.00%、唯一物理许可保留、viewer 403 与台账一致。仅提交本轮清单中的源码和已审查证据。
