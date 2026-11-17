# Day 21：轻量单车演示与 v0.3

日期：2026-11-17（Asia/Shanghai）。基线：已推送的 Day 20 `0ad322a3e6ce1446792f13be856848cdfde901b5`。先核对本地/远端 main、标签、计划、Day 20 日志/报告、runner/WMS 代码及测试，确认 Day 20 已交付且无冲突项目进程，才进入 Day 21。原有 `reports/day-07-demo.webm` 删除、`output/`、`tmp/` 和本地 PDF 保留，不暂存。

## 当前实现、最小方案与涉及文件

Day 20 的 QC 放行整单上架、单车出库和人工发运已跑通。Day 21 是第 3 周阶段归档，不再改库存事务或增加框架，也不进入 Day 22 多车。

分三组可独立审查：

1. **复现脚本与阶段查货**：`scripts/browser-checks/day21-single-robot-demo.js`、`day21-video-check.js`、`tests/transport/putaway.test.cjs`；UI 执行业务，使用一致水位快照验证两种运输各五个阶段，新增手动逐 tick 停步查货测试；`apps/web/src/App.tsx` 只更新里程碑标题。
2. **实测媒体**：`reports/day-21-demo.webm`、上架/出库在途截图、场景预览和对账截图。沿用 Playwright CLI 与已安装的 ffmpeg，不引入录像框架或服务。
3. **阶段文档与版本**：本日志、`reports/day-21-acceptance.md`、`docs/releases/v0.3-single-robot.md`、README 和浏览器复现说明；验收后正常提交/推送并建立 `v0.3-single-robot` 注释标签。版本发布指 Git 标签与仓库发布说明，不是部署或额外 GitHub Release 对象。

## 五个可观察验收条件

1. 新普通 QA seed 上经真实 UI 完成收货 → 质检 → 单车上架 → 出库预占/搬运 → 操作员发运，不手改数据库或调用 reserve 夹具。
2. 上架与出库各捕获 APPROACH、LOADING、TRANSPORT、UNLOADING、COMPLETED，货物数量/位置/预占正确，快照水位能对应持久 tick 事件。
3. 在途库存可在台账查看；到暂存区全仓现存仍为 66，发运后才从 66 变 62；同批次只有一条 DISPATCH，最终对账无差异。
4. 浏览器刷新不改变完成状态/水位，三隔离库真重启后物理、预占、事件和检查点均无差异。
5. 录像保存成功、全文件解码无错误，Chrome 可跳转并继续播放；版本标签和 main 必须指向本轮已验收提交才算交付完成。

## 状态权威、事务与同步边界

沿用 Day 20：PostgreSQL 是库存、预占、任务 phase、机器人载荷/tick 和事件的权威；runner 在事务外计算路径/提案，提交时以 ACL、Warehouse/runtime 锁、lease/epoch、expectedTick/version 保护。取/放、流水、检查点、审计和事件仍同事务，人工发运独立确认。React/R3F/Drei 仅呈现确认段，Query 缓存，Zustand 只管 UI，不由录像或动画推进库存。

录像读 API 时使用 simulation → inventory → simulation 三次读取、要求水位相同再接受，防止跨 tick 混合快照。实时 runner 录像期间照常推进；测试停步时检查持久库存及同水位事件。**视频可暂停、测试可在 tick 边界停止步进，不等于产品已有暂停按钮或历史回放。** 未添加这些接口，不宣称多车避碰。

## 实际结果与最可能失败边界

- `pnpm check` 通过；85 个单测（simulation 19 + web 66）、128 个真实库/API 测试（Node 29 + Jest 99）通过，无失败/跳过；三库重启后四类差异全部为 0，写测试库持久检查点 17 个。
- 浏览器一轮完整流程通过，捕获 10 个阶段快照，核对 75 个连续事件、7 条新批次流水；全仓现存 62 → 66 → 66 → 66 → 62，暂存预占 4，最后清零。
- 原始连续录像 40.64 秒、1440×1100、VP9、无音轨；25fps 是录像设置，不是应用 FPS 实测。ffmpeg 全文件处理 1016 帧成功；Chrome 逐点 seek/play 与原图检查通过，见报告。
- 风险重点：阶段短暂可能错过；不同请求跨 tick 会产生假差异；TRANSIT 不属于物理布局；录像未关闭就不能视为完整产物。脚本遇到这些情况直接失败，不伪造阶段或补写库存。
- 保留既有大 chunk 和 THREE.Clock 提示；无生产性能/多车能力结论。无需服务升级、数据库迁移、真实机器人或部署。PDF 周期任务独立，本轮不修改 PDF。

验收命令、媒体 SHA-256 和逐阶段证据见 [Day 21 报告](../../reports/day-21-acceptance.md)，讲解及版本边界见 [v0.3 发布说明](../releases/v0.3-single-robot.md)。远端 main/标签的实际提交核对在本轮最终回复记录；若推送未完成，不推进 Day 22。

审查提交：`4ccf825`（复现脚本、阶段查货及播放检查）、`c1f5553`（验收媒体）；阶段文档随第三组提交，标签应指向包含三组的最终提交。
