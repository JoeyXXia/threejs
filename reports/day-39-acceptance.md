# Day39 验收 — 固定种子的路径和多车性质测试

日期：2026-11-28（Asia/Shanghai），基线 `59f9523`。

## 可观察验收

1. **T07**：A* 与独立 BFS 比较可达性和最少步数；每条找到的路径逐格验合法性。无路或非法端点返回空路径，不返回伪直线。
2. **T08**：比较每个 tick 的前后状态，禁止同格、对向交换和进入他车旧占格；按实际占格独立复算通道/充电位所有者，并检查取放提案不重复。
3. **T09**：两车闭环保持等待，输出阻挡车和 `NO_PROGRESS`，不制造完成；载货车遇全切封路加设备故障，保留货物阶段、位置、电量和通道许可，只有同时解封并维修后才续跑原任务。
4. **T10**：拒绝没有足够电量移动到相邻充电位的充电计划。在双车争抢一个充电位时，满电车辆继续占位，未充电车辆记录等待原因。服务端低电量任务准入另用既有集成用例验证。

## 复验命令

```powershell
pnpm --filter @warehouse-twin/simulation exec vitest run src/seeded-invariants.test.ts --disableConsoleIntercept
$env:DAY39_SEED='4294967295'
pnpm --filter @warehouse-twin/simulation exec vitest run src/seeded-invariants.test.ts --disableConsoleIntercept
Remove-Item Env:DAY39_SEED
pnpm check
pnpm test:unit
$env:TEST_API_PORT_BASE='13040' # 可选：避开 Windows 保留端口
pnpm test:integration
git diff --check
```

## 重点实测（12:12，上海时间）

| 范围 | 实际样本 | 实测结果 |
| --- | --- | --- |
| T07 A* 对照 BFS | 32 个基础种子，每个 5 个查询 | 160 次查询：64 找到、32 无路、32 非法起点、32 非法终点；找到的路径均合法且步数与 BFS 一致。 |
| T08 生成任务 | 32 个场景，2,021 个 tick，最多 80 步/场景 | 124 个任务，61 在限步内完成，9 个场景全部完成。剩余 63 个任务的最后等待：对向交换 44、目标已占 17、资源忙 2。 |
| T08/T09 明确闭环 | 8 个场景，192 个 tick | 16 个任务均未完成、未提议过账，双方保留原格和 `EDGE_SWAP`，有 `NO_PROGRESS` 告警。 |
| T09/T10 组合 | 8 个场景，296 个 tick | 8 个载货任务均在解封且维修后继续，取放各一次；8 个充电争抢场景各有一辆充满、另一辆继续等待。 |

T08 的等待事件按**车 × tick**计数（非任务数）：`OCCUPIED` 1,250、`EDGE_SWAP` 3,274、`RESOURCE_BUSY` 142、`TARGET_CONFLICT` 12。三个车队矩阵合计检查 2,509 个步进转换，所有安全断言通过。未发现需要缩减或修正生产代码的反例。

最终定向复验得到相同计数。单独重跑种子 `4294967295` 时，T08 场景跑到 80 步，3 个任务完成 1 个、另 2 个保留 `EDGE_SWAP`，4 项性质用例均通过。新增测试文件亦单独按严格 TypeScript 检查通过。

`pnpm check`、最终 lint 和 `git diff --check` 通过；150 项单测（模拟 59、Web 91），172 项默认集成（Node 73、Jest 99），4 个隔离 PostgreSQL 库重启对账均通过。默认集成实际通过 Day26 的低电量与充电位不可达准入用例，未生成运输预占或认领；两条不涉及本轮的可选 Redis 故障回归未启用，不计为通过。

## 范围

等权四邻接小地图，生成地图为 5–8 格宽深；受控场景使用 8×6 或转置，不是生产负载。固定种子复验不是穷举证明，限步内未完成不代表无法在其它策略下完成。此处的取放是提案，不表示已改库存或部署设备，也不声明无死锁、吞吐或实时性。
