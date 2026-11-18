# Day24 验收：受控封锁与有界重规划

日期：2026-11-18（Asia/Shanghai）。基线 Day23 `2d4bb5f0570f0febba4f3460d98962ef8d1793ca`。范围/涉及文件/三个审查组/五项验收见 [devlog](../docs/devlog/day-24.md)，权威状态和事务边界见 [ADR0015](../docs/adr/0015-controlled-closures-and-bounded-replanning.md)。只记录实际结果。

## 实现

沿用 React/R3F/Drei、Zustand/Query、NestJS/PostgreSQL，未增加依赖/服务/迁移。动态 `navigation.revision` 独立于静态布局版本，操作员封锁或解封空闲地面格（单命令≤128，总封锁≤256），拒绝当前占格及本步已确认段。旧 JSON 缺字段默认 0/[]。

最多五车、每车两次 A*，每次上限 2000 扩展节点与 10ms 搜索预算；不是实际 HTTP 延迟或实时硬期限测量。有路替换受影响未来路线，无路/预算耗尽持久 NO_PATH/BUDGET 暂停，保留位置、phaseTicks、货物、claim、预占、资源；不逐 tick 重算、不回退直线，只在新的实际地图变化后重试。几何有路不保证动态协调无死锁。

计算在写事务外，事务内重新授权、按原锁顺序核对 tick/stateVersion/锁后布局，保存地图/路径/告警并追加历史；失败整体回滚。旧 runner 提案还须通过地图 revision fence。封锁本身没有库存过账。

## 检查与实际发现

- 首次类型检查发现 unknown 命令字段在异步事务闭包中未保留 TypeScript narrowing；校验 boolean 后捕获局部常量，未用类型强转绕过校验。
- 浏览器脚本执行前复核实际 layout 契约，将数据库内部 serviceX/serviceZ 改为公开 `serviceCell`；不修改产品 API 迁就夹具。
- 浏览器首轮使用 robot-1，在解封后 45 秒完成等待超时；只读快照证实停在 (1,15)，下一格 (1,14) 被 IDLE robot-2 占用，waitReason=OCCUPIED、blockerId=robot-2。地图 revision=3、NO_PATH 已解除，非“穿墙直线”或解除封锁失败。几何重规划不预订整条路线，产品保守等待符合边界；此轮不算完整浏览器通过。保留本地首轮截图，随后用新 seed 库选择 robot-2 做可完成正例，不挪走停车车、不改业务数据、不放宽原断言。
- 最终源码 `pnpm check` **通过**（lint/typecheck/build）。保留既有场景 chunk >500kB 警告，未声称本日优化包体/FPS。
- `pnpm test:unit` **115/115**，simulation **44**、web **71**，0 失败/跳过。新增导航纯测试 6 项、web 导航契约 1 项。
- 最终 `pnpm test:integration` **143/143**，Node **44**、Jest **99**，0 失败/跳过，退出 0。对账 SQL 加入导航检查后重新完整运行，不用之前构建代替最终验收。

纯测试覆盖合法绕行且不移位/耗电/改阶段、占格/批准段/旧 revision/新任务穿封锁拒绝、整幅切断后载货保留、预算耗尽20tick不重试、LOADING 进度保留且 take 一次、十次变图无瞬移及损坏旧路 fail closed。

新增三个真实库测试覆盖 viewer403/跨空间404/伪造字段400、同版本重复设置无新水位、已批准 from 段409；注入事件失败全快照回滚；已取货后目标封锁 NO_PATH，20tick 不移位不耗电、loaded active claim 保留；旧 proposal409、第二客户端租约接管仍暂停；解封后原任务完成且仅两条 transport 流水（take/drop）。完整横向断路还验证取货前暂停、零运输流水，再开放保持原 claim。

## 真实 PostgreSQL 重启

环境：Node v22.14.0，PostgreSQL 18.6 / Windows x86_64；使用隔离测试库，不读取或重置开发库。最终 **2026-11-18T14:03:48.728Z**（上海22:03:48）实际关闭/启动 PostgreSQL 后，三个库的库存、预占/订单、事件与检查点差异全部为 **0**。写测试库保留 **32** 个检查点，其中 **14** 个车队、**4** 个含资源；其余两个库检查点为0。重启后逐 fleet 验证导航未来路径/暂停版本与资源合法性，而非只刷新浏览器。

本日不是新的独立 fleet 进程 SIGKILL 试验；原单车 API kill 回归、双客户端接管与实际数据库重启分别记录，不混为相同证据。

## 真实浏览器

独立新 seed QA 环境，完整执行 `scripts/browser-checks/day24-navigation.js` 于 **2026-11-18T14:09:23.621Z**（上海22:09:23）返回 **passed=true**。首轮失败不计通过，以下只取第二轮从新库开始的完整结果：

| 验收项 | 实测 |
| --- | --- |
| 初始化/正例 | UI 初始化3台持久车，给 robot-2 分配1件真实出库任务；UI 关闭未来 (1,8)，revision1 路线合法避开该格 |
| 断路/告警 | UI 关闭未占用目标 (27,3)，revision2、NO_PATH；命令响应 tick1、位置 (1,13)、尚未取货 |
| 持久暂停 | 至少再8tick位置/载荷/claim不变，页面 NO_PATH/ROUTE_BLOCKED；刷新保留 revision2、暂停与原 claim |
| 恢复 | UI 重开目标 revision3，原任务 tick55 COMPLETED；解封第一格 revision4，最终 tick55、水位66 |
| 历史 | 核验固定水位前66条连续事件，其中55批 FLEET_TICK；4条 FLEET_NAVIGATION_CHANGED revision依次1–4；每批无车进入当时 closed |
| 台账 | 现存62、预占1、可用54、待检7；WMS consistent=true，保留出库预占，未自动人工发运 |
| 权限/冲突 | viewer原生按钮disabled、API写403；占格409、旧 revision409 |

本轮浏览器暂停在取货前，**不冒充载货暂停证据**；确定性载货断路/保留TRANSIT/解封一次落货由上述真实库测试覆盖。截图/轮询不当作吞吐或HTTP性能数据。

已人工检查中文、表单、告警、三台场景模型、封锁红框和完成状态，归档 [暂停截图](day-24-paused.png) 与 [完成截图](day-24-completed.png)。暂停图是页面轮询后的 tick9/水位16，不冒充命令响应 tick1；完成图显示 tick55/水位66。SHA-256：

- `day-24-paused.png`：`6e143d41eea8b984f863581d2f661af06a836a365ccf6ae948e90e6c6f5545bc`
- `day-24-completed.png`：`79205679cf045aa163c910085551732498b9de66605e84b5c565fdeffd764aec`

最终页面0 console errors、保留既有 THREE.Clock 弃用警告；初始未登录 `/auth/me` 的401是会话检查。原始CLI/首轮诊断与截图保留在本地忽略目录，不提交原始日志或临时产物。完整流程后关闭专用 Chrome，QA 输入 stop，等待退出码0。

## 限制与保留

仅合成布局与软件车；10ms/2000节点是算法配置，不填未经测量的性能结果。重规划不更换目标/任务；地图可达但完成车或资源循环仍可能挡路，不能自动挪车/释放许可。不会把设备 ERROR 当成修复，Day25 故障恢复未开始。无新消息服务、框架、Socket、真实机器人控制、发布/部署或标签。

原有 day07 录像删除与 output/tmp/本地 PDF 不提交。最终提交和远端核对在交付回复记录。
