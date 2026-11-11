# Day 16 A* 验收报告

日期为 2026-11-11（Asia/Shanghai），源码基线为 `2173f9c9729871af53d9ffc1c5b6d6f094f6b5cb`。实现、状态权威与同步边界见 [开发日志](../docs/devlog/day-16.md)。

## 实测结果

| 验收项 | 本轮证据 |
| --- | --- |
| 生产检查 | `pnpm check` 退出 0，lint、类型检查、API 与前端生产构建通过。 |
| 前端与纯函数回归 | `pnpm test:unit` 退出 0，10 个文件、59 项测试通过，新增 A* 测试 8 项。Vitest 本次总时长 1.71 秒，A* 测试文件 1,079ms。 |
| 最短路对照 | 全部 512 张 3×3 障碍图的 11,520 组合法端点组合，以及 100 张 12×10 固定障碍图，A* 与独立 FIFO BFS 的代价/无路结论一致。成功路径逐点可走、逐步四邻接。 |
| 绕行和稳定顺序 | 5×5 障碍样例从 (0,0) 到 (4,0) 绕行 12 步，相同输入重复调用路径相同。 |
| 输入与无路 | 越界、非整数、NaN/Infinity、障碍端点、非法预算均有对应失败状态。3×3 贯穿墙样例展开起点所在的 3 格后返回 unreachable。 |
| 同点 | 合法同点返回单点路径和 cost=0，maxExpanded=0 时也无需展开。 |
| 节点预算 | 开放 10×8 图设置 maxExpanded=2，实际展开 2 格后返回 node-limit，cost=null、path=[]。 |
| 耗时预算 | 使用 Vitest 替换单调时钟，每次读数递增 1ms；timeoutMs=2 时展开 1 格后返回 time-limit，cost=null、path=[]。这是确定性中止逻辑测试。 |
| 业务坐标 | 从通道走向储位 serviceCell 成功，以架内储位坐标为终点返回 invalid-goal。 |

默认检查运行的本地单元测试原始 JSON 位于忽略入 Git 的 `reports/unit.json`。生产构建保留已有场景 chunk 超过 500 kB 的提示。

## Node 运行样例

以 Node 22.14.0 和现有 tsx 执行 `findPath(buildNavigationGrid(fixtureSnapshot().layout), {x:0,z:1}, {x:4,z:1})`，入口在浏览器之外直接运行成功。样例为现有 10×8 测试夹具，架体占据 (2,1)、(2,2)。

```text
status       found
layoutId     00000000-0000-4000-8000-000000000003
layoutVersion 1
path         (0,1) → (1,1) → (1,0) → (2,0) → (3,0) → (4,0) → (4,1)
cost         6
expanded     6
discovered   12
queuePeak    6
elapsedMs    0.37419999999997344
```

耗时为单次本地调用的读数，包含初始化和路径回溯，仅用于确认指标实际输出。样例探针保存在临时文件执行后移除。

## 复验命令与入口

```powershell
pnpm check
pnpm test:unit
# 只执行本轮 A* 用例
pnpm --filter @warehouse-twin/web exec vitest run src/warehouse/astar.test.ts
```

主入口为 `apps/web/src/warehouse/astar.ts` 的 `findPath`，输入为 Day 15 `buildNavigationGrid` 的返回值与合法地面端点。返回状态包括 found、unreachable、invalid-start、invalid-goal、invalid-options、node-limit、time-limit。失败统一返回空路径和 null 代价。

## 限制与后续衔接

本轮范围为静态、四邻接、单位边权的单路线计算。默认 10,000 节点/25ms 预算为实现选择，未开展大地图性能基准。耗时检查在主循环边界执行，实际返回时间受分配、回溯及运行时调度影响。堆采用旧条目惰性丢弃，queuePeak 因而可能高于当前不同 open 格数量。

本轮验证覆盖纯算法与生产编译。浏览器界面和数据库业务沿用 Day 15 实现与历史证据，本报告的 59 项结果来自本轮单元测试。Day 17 计划提取 simulation 包，后续 runner 消费路径时仍须在提交阶段检查布局和运行状态版本。
