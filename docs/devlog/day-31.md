# Day31 — 运营指标与两种热力图

日期：2026-11-24（Asia/Shanghai）。开工确认本地与远端 main 均为 `00ff9bca123e678c534fd132f35e99c3747a8c25`，Day30 快照/断线恢复已经交付。已有事件包含车队格子与等待原因；无运营聚合或独立热力层。

## 三组可独立审查的改动

1. **授权聚合**：`apps/api/src/operations.ts`、`inventory.controller.ts`、`simulation/fleet.service.ts` 和共享契约。新只读接口复用 NestJS 请求和仓库 ACL；新提交的 `FLEET_TICK` 带布局 ID 与步长。无新增依赖或迁移，旧事件不回写。
2. **指标和热力层**：`apps/web/src/warehouse/OperationsDashboard.tsx`、`operations.ts`、`WarehouseView.tsx`、`WarehouseScene.tsx` 和 CSS。复用 Query、R3F/Drei 和既有场景；热力层关闭、库存、通道等待互斥，图例与单位各自独立。仍使用既有 Zustand 场景 UI，不引入图表框架。
3. **证明口径**：`operations.test.ts`、`error-state.test.tsx`、`tests/transport/realtime.test.cjs`、`scripts/browser-checks/day31-operations.js` 及[验收](../../reports/day-31-acceptance.md)。

## 权威与边界

PostgreSQL 单据、搬运任务行与提交事件是权威。聚合查询在同一 Repeatable Read 事务重新验证会话与仓库授权、读取当前布局/水位，只计算提交数据。车队运行/故障/充电和库存热力读取 Day30 已确认的场景快照；运营指标独立刷新，标注自己的水位和时间窗，不把两次响应冒充同一快照。不叠加布局 ID 不同的通道点。

容易失败的边界是将连续增长的 `waitTicks` 反复累加，把移动或故障计为通道拥堵，或用旧布局解释历史坐标。本日仅以明确标注当前布局的持久 tick 和竞争等待原因计入秒数。不做路线回放、全局吞吐承诺或实体机器人接入。

## 可观察验收

1. 待处理单、待取/在途队列均可从真实单据和搬运行回推。
2. 近一小时终态完成率有明确定义；取消计入分母，零分母显示“无终态任务”；过窗不计。
3. 两种热力可切换，库存是件数，通道等待是车辆秒；关闭可清除图例，库存多层按地面格合并。
4. 手算排除移动、设备故障、重复 tick 和未知/旧布局；真实浏览器场景的等待与 API 水位内事件可逐条复算。

实测构建通过，137 项单测、162 项集成测试通过，四库重启后对账一致；Chrome 上完成两种图层验证，真实等待格 (13,4) 的 1,000 ms 与提交事件复算一致。
