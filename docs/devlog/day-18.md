# Day 18：单车任务与显示插值

日期：2026-11-12（Asia/Shanghai）。本轮起点为本地和 GitHub main `4588a10d85e874d66a6b6f3b1516bd7c546fe523`。核对 `doc/planning`、Day 17 日志/验收报告、纯模拟核心、运输服务、场景和现有测试，确认 Day 17 已验收及推送。本地原有 `output/`、`tmp/` 保留，不纳入提交。

## 当前实现与三组最小改动

Day 17 仅有纯核心，无运行中的后端车状态和浏览器模型。Day 10 已有真实取货/卸货事务，本轮复用而不重新写库存业务。

1. **阶段与后端**：`packages/simulation/src/task.ts`、契约机器人响应、`apps/api/src/simulation/`，单进程定时驱动和授权 GET/POST；运输事务加入可选布局期望检查；workspace/构建命令更新。无数据库迁移。
2. **显示与交互**：`RobotPanel`、`RobotModel`、`robot-data`、`robot-pose`，接入 WarehouseView/WarehouseScene；Query 轮询，ref 插值，路线/载货显示和陈旧提示。保留 2D 入口，不用前端通知任务完成。
3. **验证与文档**：新增纯阶段/插值测试及 7 项真实 PostgreSQL 测试；新增两份浏览器回调、三张截图、ADR 0010 和本轮报告。

## 五项可观察验收条件

1. 服务器按接近、装载、运输、卸载推进，只在装卸效果成功后发布新阶段。
2. 单次运输取货和卸货各写一次流水，onHand 和 reserved 全仓守恒；失败保留最后确认位置和载货事实。
3. 重复读、重试启动、整页刷新不重置任务；同时回调不双推进。
4. 低帧率输入不写模拟状态，浏览器阻塞不阻止服务器推进，断流不越过最后确认端点。
5. viewer、跨仓和伪造操作者被拒，撤权停止运行；会话过期清除旧场景和操作控件。

## 权威与同步边界

WMS 事实继续在 PostgreSQL。位置/tick 暂在 Nest 单进程内存，尚无持久 runner 和租约。唯一 interval 以 250ms 推进纯阶段；take/drop 调用既有事务，并在仓库锁内检查 expectedLayoutId。Query 缓存读取，Zustand 仅 UI，useFrame 只改 mesh/material ref。阶段变化精确刷新库存相关查询。最危险的 DB 提交后内存发布窗口及后端重启限制见 [ADR 0010](../adr/0010-single-robot-and-confirmed-poses.md)，本轮没有声称解决它。

## 实际验证

- 冻结安装和 `pnpm check` 通过。
- `pnpm test:unit`：19 项纯模拟/阶段 + 62 项前端/算法，共 **81 项**通过。
- `pnpm test:integration`：Node 15 项（新增机器人 7 项）+ Jest 99 项，共 **114 项**通过；两个隔离数据库重启后现存、预占/订单、在途和暂存容量对账均零差异。
- 独立 Chrome/QA DB 最终完整回调通过，任务 `57059e6d-1a74-40b3-ba14-29852b3bac85` 在 tick 47、逻辑 11750ms 到达暂存位 (27,3)。1 件货运输后现存 62、预占 1、可用 54、HOLD 7，在线对账一致。
- 浏览器主线程约 1100ms 的有界阻塞期间，服务器从 tick 2 到 tick 7。断流后实际 Canvas 诊断位置不再外推，恢复读取最终状态。viewer 服务端启动返回 403。会话过期移除机器人面板和 Canvas。

## 失败、修正与未测

首次类型检查发现纯阶段被 TypeScript 收窄为非终态，以及 Allocation 没有直接 location 关系；已显式声明阶段类型并通过 balance.location 读取。沙箱离线安装缺元数据、Playwright CLI 访问本机代理被拒，获准正常运行后成功。首次截图检查发现完成图早于 3D 懒加载，已改为等待 Canvas 的任务与相机就绪，重新拍摄同一完成任务并检查。首轮 112 项集成通过，追加卸货失败/旧布局两项后最终 114 项。

收尾时 QA 包装器因临时缓存的 pg_ctl.exe 缺失而退出 1，前后端已退出但端口 15434 仍在监听。核对 PID 34292、命令行、端口及本轮数据目录 `warehouse-twin-browser-YcMHHB` 后，用原 npm 安装中的 pg_ctl 对该集群执行正常 fast stop，输出 server stopped。未强杀、未触及开发库；缓存缺失原因尚未确定，本轮未扩大修改便携工具。最终只读清理检查因自动审批超时延迟到 2026-11-13，重试确认 15432/15434/13004/15174 均无监听且 QA PID 文件移除。代码未改变，验收日期仍为 11 月 12 日，13 日仅续做提交收尾，不推进 Day 19。

本轮不是 FPS、tick 吞吐或大地图性能基准；浏览器报告的 GPU 标识不代表测过性能。保留既有大 chunk 提示和 Three.Clock 弃用警告。无后端重启恢复、多实例 owner、Socket、真实机器人、自动发运或多车冲突。详见 [验收报告](../../reports/day-18-acceptance.md)。
