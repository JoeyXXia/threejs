# ADR 0003：版本布局、稳定货位与库存基础

日期：2026-11-01。状态：采用。范围对应 Day 3；不引入新服务、框架或依赖版本。

## 三个审查单元

1. 数据库：`schema.prisma`、`202611010002_layout_inventory`、`202611010003_inventory_constraints`；实体、复合外键、CHECK、发布/容量/流水触发器。
2. 数据与接口：`data/layouts`、`seed-inventory.cjs`、`inventory.controller.ts`；可重复期初入账和两个只读 API。
3. 证据与维护：`reconcile.cjs`、集成测试、测试 runner、README、devlog、验收报告；失败注入、真实 DB 并发、重启与全量对账。

## 稳定身份与布局快照

`Location` 只保存稳定业务 ID、code、kind、space/warehouse 归属。`LayoutLocation` 保存版本内坐标、层级、容量、zone/rack、serviceCell；库存关联 Location，不把布局版本当成库存身份。这样新布局可以继续引用原货位 ID，旧几何和容量快照不被覆盖。

`LayoutVersion` 属于仓库，版本号在空间/仓库内唯一，状态 DRAFT → PUBLISHED。`Warehouse.activeLayoutId` 通过复合外键绑定同仓布局。今天只有固定 v1、没有编辑或发布 HTTP 命令；draft/published 是 seed 和数据库验证使用的最小生命周期，不是地图编辑平台。

发布前数据库验证区域范围、货架位于储存区、货架不重叠、货位的 zone/kind/货架/层级一致，以及地面服务点合法、邻接货架且不落入任何货架。已发布布局及其 zone/rack/placement、已有发布位置的货位身份禁止更新或删除。切换 active layout 不能指向 draft/别仓，也不能遗漏或装不下正库存。通道连通性以当前样本的 BFS 测试验证，数据库发布检查不保证任意地图连通。

地图网格、世界坐标和整数件单位沿用 ADR 0001。API 返回网格和版本，今天不实现坐标转换函数、场景或相机。`blockedCells` 由 DB 中货架矩形投影生成，不把货位中心当作机器人目的格。

## 库存与归属

SKU、Batch、Location 均有空间/仓库归属。Batch 复合键带 skuId，余额和流水通过它引用，防止批次与 SKU 拼接。余额键为 `(space, warehouse, location, sku, batch, quality)`，quality 只支持 HOLD / RELEASED，数量为整数件。

数据库 CHECK 强制 `onHand >= 0`、`0 <= reserved <= onHand`、version 非负；库存流水数量必须为正。写余额时先锁 Warehouse，再锁 Location，按当前发布布局容量检查该位置全部质量行的现存总量；储存位有正库存时不得混放不同 SKU/批次。该粗粒度仓库锁符合小规模串行提交起点，不宣称高吞吐。

目标容量预留、分配、盘点冻结、虚拟 transit、真实收货/发运业务尚未实现；不能把今天的容量 CHECK 当作未来容量预留或任务并发问题已解决。

## 流水与期初 seed

`InventoryMovement` 保存一条完整转移记录：SKU/批次、来源/目标货位和质量、数量、业务唯一键、actor/type、原因、reference 和时间。今天允许 OPENING（外部到目标）和 TRANSFER（完整两端）的基础数据形状；没有运输/过账 HTTP 命令，也未实现发运到外部的流水形状，后续业务日再扩展。

流水提交后不可更新或删除。seed 给每个期初动作稳定业务键，在同一事务内创建余额与 OPENING 流水；并发 seed 先锁仓库，已存在业务键则跳过。报错会回滚布局/余额/流水，重复执行不凭固定数字覆盖当前余额。

`pnpm reconcile` 在 Repeatable Read 事务中，将目标端加数量、来源端减数量，按完整余额维度聚合，再 FULL OUTER JOIN 实际余额。它能发现少余额、多余额、数量不符；净额为 0 的历史键允许没有余额行。今天重算的是 onHand；reserved 为 seed 的 0，只有 CHECK，尚无预占账本可重算。

DB 约束不强制每次合法正数余额变更都必须同时写流水；目前无库存写 API，维护脚本必须遵循事务约定并执行对账。测试故意修改/删除余额，证明对账确实发现差异，随后回滚。

## HTTP 读取边界

- `GET /spaces/:spaceId/warehouses/:warehouseId/layout`：布局元数据、区域、货架、货位位置/容量/服务点和 blockedCells。
- `GET /spaces/:spaceId/warehouses/:warehouseId/inventory`：批次余额、每货位合计（包含空位）、现存/预占/可用/待检汇总、layoutId/version 和 asOf。

两个接口复用会话守卫，并在各自的 Repeatable Read 事务中检查仓库访问关系与 active layout，显式映射返回字段，不暴露 Prisma 对象内部信息。无会话 401，无仓库访问 404，无活动布局 404；不生成假默认库存。viewer 可以读，库存写 HTTP 入口不存在。

可用量仅指已放行、未到期、未预占的数量；HOLD 或到期批次仍计入现存，但 available=0。它不是完整分配承诺，尚未考虑未来盘点锁、区域策略和任务约束。

两次独立 HTTP 请求不是同一个数据库快照。Day 4 组合布局和库存时必须比较 layoutId/version；若不一致应重新同步。这里只保证每个响应内部的一致读取。
