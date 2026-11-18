# Day23：狭窄通道与工作站单容量资源

日期：2026-11-18（Asia/Shanghai）。本地与远端 main 核对均为 Day22 `7810cce2e3664ea7c7a70d8fc73a367fed320fe2`；读取 doc/planning、Day22 devlog/报告、核心/API/契约/数据库与测试后，确认下一未交付项是 Day23。没有发现本项目并行 runner/测试/提交进程；原有 `reports/day-07-demo.webm` 删除、output/tmp 和本地 PDF 保留。不是按触发次数跳天。

## 当前实现、最小方案与三个审查组

Day22 已有 3–5 车持久唯一分配、集中下一步协调、同格/edge-swap/保守占格保护和原子库存批次，但同一多格通道的不同入口尚可同时被不同车辆进入。本日增加单容量逻辑资源，复用现有检查点/事务/授权，不引入服务、框架或数据库表。

1. **纯许可核心与反例**：`packages/simulation/src/resources.ts`、`resources.test.ts`、`fleet.ts`、`index.ts`。配置 AISLE/PARKING/CHARGING/WORKSTATION，进入前申请、出清后释放，固定优先级/等待排序，空闲/完成/ERROR 车持续占用。
2. **权威、接口与真实库**：`packages/contracts/src/index.ts`；API `fleet.service.ts`/`fleet.controller.ts`；`packages/database/reconcile.cjs`、`tests/transport/fleet.test.cjs`、`scripts/integration.mjs`。旧 JSON 向后兼容，新资源与车位、取放、claim、tick/事件在同一事务中持久化；增加配置授权与只读对账。
3. **页面与验收证据**：web `FleetPanel.tsx`、`fleet-contracts.test.ts`、App 标题；`scripts/browser-checks/day23-resources.js` 和 README；本日志、ADR0014、验收报告与最终截图。资源表及等待 id 可见，保留 Query/R3F 确认段展示，不让动画决定许可。

## 五个可观察验收条件

1. 配置只接受连通、可走、互不重叠的单容量格组；viewer/跨空间拒绝，重复配置幂等，不能换配置重置已有许可。
2. 对向不同空入口同时申请时只有一车进入；已持有资源的车不会被无许可外车的顶点竞争阻止出清。
3. 组内移动持续持有；确认出清后才释放，外车下一 tick 才可取得；空闲、完成和故障车持续占格/持有，不因 runner 租约超时自动释放。
4. 批次事件失败时资源/车位/库存/事件全部回滚；独立客户端租约接管保留许可、拒绝旧提案；数据库真实重启后资源与占格/库存对账一致。
5. 授权页面配置四类资源，五车真实业务运行中可见 RESOURCE_BUSY、阻挡车、等待资源及累计 tick；刷新后归属一致、viewer 不能写；无法完成时保留真实等待。

## 权威与边界

PostgreSQL 的 `WarehouseRuntime.fleet.state.resources` 为资源权威，只有既有后端 runner/命令在仓库锁下提交。配置按 ACL SHARE→Warehouse→WarehouseRuntime，计算后重新验证当前布局/检查点。runner 沿用 lease/epoch/expectedTick/version fencing，事务外纯提案，事务内一并提交许可、位置、库存领域效果、claim、tick、连续事件。配置也追加有序事件。旧 Day22 JSON 无 resources 则维持旧策略，不偷偷修改历史。

物理许可不是进程写权租约：5 秒租约到期可以换 runner，不能清掉停在通道的车。资源中最多一车，owner 必须等于真实占格车；损坏则停并报错。读取等待原因是上一步决定，阻挡车可能在本批次末尾刚出清，不要求它在当前快照仍持有。详见 [ADR0014](../adr/0014-physical-resource-permits.md)。

## 验收命令

```powershell
pnpm check
pnpm test:unit
pnpm test:integration
# 等集成测试 PostgreSQL 完全退出后，用新隔离库：
pnpm qa:browser
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day23 open http://127.0.0.1:15174 --browser chrome
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day23 run-code --filename scripts/browser-checks/day23-resources.js
npx --no-install --package @playwright/cli playwright-cli -s=warehouse-day23 close
# QA 终端输入 stop，确认退出。
```

实际数量、故障修正、截图与发布边界见 [Day23 验收报告](../../reports/day-23-acceptance.md)。仅全量适用验收通过后提交/正常推送 main 并核对远端，未完成时不跳 Day24。

本轮最终 `pnpm check` 通过，单元 **108/108**（38+70）、真实数据库集成 **140/140**（41+99），三库真实重启对账四类差异均为 0。浏览器全流程通过：四类资源、五车、三台顺序上架；捕获 tick184/水位232，184 批持久 tick 的许可/占格逐批相符，RESOURCE_BUSY 实际可见，viewer 写入403/跨空间404。完成驻站仍占用，未将其余等待车辆伪造为完成。交付只正常推送本 Day 文件，最终 SHA 与远端核对结果在回复中记录。

## 最可能失败的边界

入口停车或跨资源循环可能无限等待；无动态重规划、自动挪车/回充、产品级故障恢复或无死锁保证。资源配置首次无活动任务，保存后不可修改，避免借配置释放物理占用；不做地图编辑器。CHARGING 仅资源种类，不代表已实现充电算法。数据库损坏 fail closed，不靠自动“修复”抹掉许可。没有真实机器人/Socket/新增框架，没有测量应用吞吐或 FPS。
