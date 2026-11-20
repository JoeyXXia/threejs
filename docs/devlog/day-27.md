# Day27 — 多车重启与调度回归

日期：2026-11-20（Asia/Shanghai）。开工核对本地与 GitHub main 均为 `a15d948679334f182a7f694a55d272578368bc5a`。Day26 已有电量准入、单容量充电和无进展诊断的实现及真实库、浏览器证据。对照每日计划和总计划 T11，已有单车 API 停进程回归、多车双连接拒旧写及 PostgreSQL 重启对账，但尚缺固定五车、多任务、进程前后切点的一体化证据。

## 两个独立审查组

1. **集成测试**：`tests/transport/fixtures/fleet-runner.cjs` 及 `tests/transport/fleet.test.cjs`。在既有 `scripts/integration.mjs` 已纳入的测试文件里增加场景；子进程只通过进程间 IPC 调用真实 `FleetService.assign/prepare/commit`，连接专用 PostgreSQL 测试库，不为应用增加测试路由、定时器或依赖。
2. **实测证据**：本日志与 `reports/day-27-acceptance.md`；自动输出的本地 JSON 不提交。没有复现产品缺陷则不改运行时代码。

## 四项可观察验收

1. 固定合成地图和 seed 的五车场景，在认领、取货、卸货前后强制退出并确认子进程关闭；退出不修改已提交 tick、事件水位、车队、货物、归属或资源。
2. 活租约拒绝第二 runner；自然过期后新进程从原 tick 取得新 epoch；旧进程即使仍存活也不能提交早先提案，且拒绝后无写入。
3. 两个运输任务在卸货边界同时活动；恢复后重复认领返回同一 claim，两个任务取放分别仅一次，收尾时无活动归属或载荷遗留。
4. 核对每个提交的 tick：格子唯一、单步相邻或原地、不进入他车起始格（涵盖对向交换）、不穿墙、单容量 permit 与在位车一致；连续事件 seq 和库存对账一致。

## 权威与边界

PostgreSQL 的 `WarehouseRuntime`、`FleetClaim`、物理库存及 `WarehouseEvent` 为权威。逻辑步的取放、载荷、资源所有者和位姿同事务，租约基于数据库墙钟；客户端仅消费确认态，本日不改 React/R3F/Drei、Query 或 Zustand。最易产生假阳性的边界是自然租约过期与旧提案重放、待提交取放与已提交取放的区分、进程退出和 API/DB 故障概念混用。测试在 IPC 边界强停进程，不把模拟暂停、手工改租约或重新执行未提交提案算作已完成过账。

## 复验

```powershell
pnpm check
pnpm test:unit
pnpm test:integration
git diff --check
```

实际结果见 [Day27 验收报告](../../reports/day-27-acceptance.md)。原有录像删除、output/tmp、本地 PDF 均不暂存；无 Day28 录制、标签或部署。

构建检查、128 项单元与 156 项集成通过。五车场景实测六个进程退出边界，活租约拒绝并行 runner，接管后旧提案 409；两项任务共四条唯一取放流水，77 个提交 tick 的安全断言与三库重启对账均通过。没有需要改动的运行时缺陷。
