# Day 17 固定步长模拟器验收报告

日期：2026-11-12（Asia/Shanghai）。源码起点：`88ea5ea34c85ebc1b48fa45a182b36f99808a7b0`。设计与状态边界见 [ADR 0009](../docs/adr/0009-deterministic-simulation.md)，工作范围见 [开发日志](../docs/devlog/day-17.md)。

## 实际执行结果

| 检查 | 本轮实测 |
| --- | --- |
| 冻结安装 | `pnpm install --frozen-lockfile` 退出 0；6 个 workspace，已有依赖复用，没有升级版本。 |
| 全工程检查 | `pnpm check` 退出 0，lint、strict 类型检查、共享包/API/前端生产构建通过；保留既有 3D chunk 超过 500kB 提示。 |
| 新增模拟器单测 | 1 个文件 16 项通过；本次 Vitest 时长 460ms，测试文件 37ms。是一次本地测试读数，不是仿真性能基准。 |
| 既有前端和算法 | 10 个文件 59 项通过；本次时长 1.84s。A* 提取后，11,520 组 3×3 端点组合加 100 张较大样例与独立 BFS 一致。 |
| seed/命令重放 | 相同 seed、初态和命令序列，对比完整状态和逐次摘要一致。含 seed 0 和 uint32 最大值。 |
| 帧率分片 | 30、60、144 FPS 对应的整数时间分片，各输入 10 秒，均为 40 tick，相同最终摘要，无 lag。是纯测试输入，不是实际浏览器测量。 |
| 暂停 | 100 次 step 保持同一状态；适配器暂停输入 100,000ms 后仍无步进。恢复不补跑，重复 resume 不清当前余数。 |
| lag 边界 | 10,025ms 输入最多执行 8 步，逻辑 2,000ms，丢弃 8,000ms，余数 25ms；下一次 advance(0) 不补跑。 |
| 运动与电量 | 四步路径逐步比较坐标、S/E/E/N 朝向及 99/98/97/96 电量；初始仅 2 基点时停在第二步，不变负数或瞬移。 |
| 非法输入 | 非法 seed/电量/tick/时间差/地图、斜走、穿墙、越界、错起点、过期布局和忙碌替换路径均拒绝；旧状态不变。 |
| 不受环境污染 | 测试将 Date.now、Math.random、performance.now、setTimeout、setInterval 替换为抛错函数，核心和步长适配器仍完成移动。A* 耗时诊断不在该断言范围内。 |
| 快照与摘要 | 输入坐标/地图/路径修改不影响已创建状态，内部对象冻结，可 JSON 序列化；坐标属性顺序、阻塞格顺序不影响规范摘要。 |
| Node 样例 | `pnpm demo:simulation` 退出 0，Node v22.14.0 直接导入构建的 ESM，输出如下。 |

单测合计 **75 项通过**。原始结果在本地忽略的 `reports/simulation-unit.json`、`reports/unit.json`，不纳入 Git。

## 可复现 Node 输出

```text
阶段       tick  logicalTimeMs  position  direction  status  battery  summary
到达          2            500  (1,1)     S          IDLE         98  sim1-9d388eb8
暂停10秒      2            500  (1,1)     S          IDLE         98  sim1-b012a495
恢复250ms     3            750  (1,1)     S          IDLE         98  sim1-4f59f054
```

暂停标记参与摘要，所以暂停前后即使库存无关的位置和逻辑时间相同，摘要也不同。该样例显式电量为 100 基点、seed 为 42，路径为 (0,0)→(1,0)→(1,1)，地图为 3×3 开放格，layoutId=day17-node、version=1。

## 复验命令

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test:unit
pnpm demo:simulation
# 仅模拟器
pnpm --filter @warehouse-twin/simulation test:unit
```

源码入口：[simulation.ts](../packages/simulation/src/simulation.ts)、[测试](../packages/simulation/src/simulation.test.ts)、[共享 A*](../packages/simulation/src/astar.ts)、[Node 样例](../scripts/day17-simulation-demo.mjs)。

## 限制及未测项

- 仅单车纯模拟核心，无服务端权威 runner、数据库检查点、租约、Socket、真实设备、任务取放或前端插值。不能用此报告宣称运输账本已由机器人自动触发。
- 地图固定，路径输入在接受时校验；动态封路、多车冲突、通道资源、低电量准入与充电尚未做。
- 默认 8 步补跑上限及 1 基点/格耗电是演示规则，未做吞吐或速度基准。严重卡顿会有意丢弃墙钟时间，不能要求其与未卡顿运行 tick 相同。
- 外部 elapsedMs 为非负整数，单次最多 1 小时，需由唯一调用方提供单调时间差；本轮不启动任何时钟。适配器余数不在核心快照里，尚不支持 runner 恢复。
- 摘要为非安全 32 位哈希，可能碰撞，不能替代业务校验或完整状态比较。A* 的时间预算仍可能受机器负载影响，核心不自行调用它来决定每 tick 的状态。
- 本轮未重跑数据库或实际浏览器验收。107 项数据库集成测试为 Day 15 等既有报告证据，未计入本轮结果。远程 CI 是否成功需在推送后单独查询，不提前填写。
- 保留用户本地 PDF 和 `output/`、`tmp/`。本轮不发布新标签或部署。
