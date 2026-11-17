# Day 22 阶段性进度存档（早间纯核心阶段）

> 本文件保留早间未交付现场，不代表当前完整实现状态。后续已补持久化、真实数据库约束、批次过账、API 与五车页面；最终交付以 [Day 22 验收报告](day-22-acceptance.md)、Git 实际提交与远端 main 为准。下文的未完成清单/测试数量是早间历史记录，不作为下一 Day 判定。


2026-11-17（Asia/Shanghai）。源码基线/远端 main：`53d42c5bb65ffa4ac48be0add64625a38ad23dcc`。

**不是 Day 22 完成报告。无 Day 22 提交/推送，未改发布标签。** 第 2/3 组持久化/API/UI 工作仍缺失，下一次必须继续 Day 22。

## 本轮成果

| 文件 | 实际用途 |
| --- | --- |
| `packages/simulation/src/fleet.ts` | 3–5 车纯状态、唯一分配历史、集中下一步协调、等待原因/阻挡车/累计等待 |
| `packages/simulation/src/index.ts` | 导出纯核心，不切换现有单车 API |
| `packages/simulation/src/fleet.test.ts` | 13 个新增用例，含 648 组三车小网格提案穷举及五个活动任务 |
| `scripts/day22-fleet-demo.mjs` | 固定 seed=42、6×6 合成地图的纯函数场景断言，输出本地 JSON |
| `docs/devlog/day-22.md` / 本报告 | 记录范围、计划、证据及未交付项，避免自动跳天 |

没有数据库迁移、真实多车 runner、多个实例的持久任务领取、HTTP/UI 多车入口或多车库存事务。因此不可宣称完成“同任务不被两车领取”的数据库并发验收。没有真实机器人、额外框架、Socket、多车恢复或 Day 23 通道资源。

## 已实际执行

`pnpm check` 已通过 lint、typecheck 和 build；保留既有大 chunk 提示。最新 `pnpm test:unit`：simulation 32、web 66，共 98 通过，无失败/跳过。初轮 3 个失败暴露 approach route 未同步保存的缺陷，已修正并完整复测；不是通过降低断言解决。

```powershell
pnpm check
pnpm test:unit
pnpm --filter @warehouse-twin/simulation build
node scripts/day22-fleet-demo.mjs
pnpm test:integration
```

纯脚本于 `2026-11-17T01:58:15.784Z`（上海 09:58）运行成功，结果 `scope=PURE_CORE_ONLY`、`persisted=false`、`browserVerified=false`：

| 场景 | 车数 | 活动车数 | 已推进 tick | 状态 | 取/放提案 | 等待观测 |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| T08-CROSS-3 | 3 | 2 | 13 | COMPLETED | 4 | 2 |
| T08-CROSS-5 | 5 | 2 | 13 | COMPLETED | 4 | 2 |
| T08-HEADON-5 | 5 | 2 | 100 | WAITING_NOT_COMPLETED | 0 | 200 |

这些是逻辑 tick，不是应用耗时、FPS 或生产吞吐。脚本对每 tick 的最终格唯一、不得进入其他车起始占格和效果提案键唯一进行断言。对向状态没有被改为完成。单测另跑五台车同时执行五个独立任务，在 tick 10 生成 10 个取/放提案。

同样场景在最终 check 通过后于 `2026-11-17T02:03:56.237Z`（上海 10:03）再次执行通过，结果与上表一致。

原始证据为本地 `reports/simulation-unit.json`、`reports/unit.json`、`reports/day22-core.json`。JSON 不纳入 Git，后续运行可能覆盖，以上表格固定本轮结果。

## 旧集成回归与限制

既有 `pnpm test:integration` 完整通过：Node 29 + Jest 99，共 128 个单车/业务回归用例，无失败/跳过。`2026-11-17T02:02:44.480Z`（上海 10:02）的真实数据库重启证据显示三隔离库的物理、预占、事件、检查点差异均为 0，写测试库持久检查点 17 个。测试库隔离，不使用开发库或根 `.env`。原有单车回归不代表多车持久化、跨进程分配或页面已验收。

核心输入/输出都是提案：重复调用同一纯快照会得到相同取/放提案，数据库必须通过共享 fence/phase 唯一动作键只提交一次。`proposalKey` 不应被直接用于绕过现有业务唯一键。纯历史当前上限 10000 项，不能替代数据库唯一索引或永久幂等。当前没有后端接收这些新状态，不把纯状态检查当成生产 JSON 安全边界。

最可能失败的接入边界：旧单车 checkpoint 与多车统一 tick 不兼容；错误/空闲车漏进占格集；多个授权 actor 的锁顺序；计算后状态版本变化；一批效果中途失败只提交部分库存；任务完成后再分配原 task；三次单车事务冒充一次全仓批次。第 2 组必须用真实库多连接与失败注入验证这些情况。

## 未完成清单（完成前不得推送交付或推进 Day 23）

- [ ] 数据库多车检查点/任务归属的权威、兼容迁移与唯一约束。
- [ ] Nest 集中批次提交，复用现有 ACL/lease/epoch/tick/version fence 和 WMS 事务；取/放同批回滚。
- [ ] 实际 3–5 台车授权 API、契约、Query/R3F 展示与等待原因。
- [ ] 双客户端竞争同 task、每车单活动任务、失效 owner/提案、重启占格与库存对账。
- [ ] 多车浏览器端到端验收及最终报告，然后仅暂存本轮文件正常推送 main 并核对远端。

保留现场：本轮新源文件/日志报告未暂存。原有 `reports/day-07-demo.webm` 删除、output/tmp 和 PDF 不属于本轮改动。没有用户需要介入的权限问题；这是未完成实现/验收的进度，不是已完成或外部阻塞结论。
