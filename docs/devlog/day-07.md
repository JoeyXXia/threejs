# Day 07：轻量复盘与 v0.1-scene

实际日期：2026-11-04。应用基线 `b993d9f`，逻辑 Day 编号与自然日分开。

- 范围：录制 API 驱动场景、搜索和点选；复核刷新与 3D/2D 一致性；整理状态归属和坐标 ADR，发布 `v0.1-scene`。
- 实际改动：新增 Playwright CLI 回调、演示视频/截图、验收报告与发布说明；更新现有 ADR、README 和浏览器复现说明。不改业务实现或依赖。
- 当日浏览器验收：真实鼠标选中 R01-1-L1 和空位 R02-3-L2，详情与 2D/API 一致；17 行数量全部一致；整页重载后布局/库存（除 asOf）不变，汇总为 62/55/0/7（现存/可用/预占/HOLD）。QC-01 HOLD 详情正确。
- 同日 Day 6 复测：check、35 项前端和 44 项 DB/API 通过，真实 DB 重启后对账 0 差异；基线远程 Actions success。Day 7 不改应用代码，复用有日期的证据而不捏造新一轮检查。
- 录像：先因缺 ffmpeg 未生成文件，补齐测试工具并重录；最终 WebM 可解码、抽帧已查看。连续 15 秒片段来自 47.12 秒原录屏，未重排动作；录制 25 fps 不代表应用性能。
- 设计复盘：DB→API/契约→Query→locationId 视图→3D/2D；Zustand 不复制库存，ref 不决定库存；两个读取接口并非同一事务；seed 是可追溯合成期初，不在页面刷新时运行。
- AI 协作：AI 完成脚本、录制、证据核对和文档；用户独立画流程、解释 StrictMode/effect 清理与状态归属仍待口述，不宣称已掌握。
- 下一步：只有用户指定 Day 8 后才进入入库/质检事务与业务表单。

交付：[验收报告](../../reports/day-07-acceptance.md)、[录像](../../reports/day-07-demo.webm)、[发布说明](../releases/v0.1-scene.md)、[复盘 ADR](../adr/0004-scene-data-and-interaction.md)。
