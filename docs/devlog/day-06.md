# Day 06：搜索、相机、筛选、2D 与 CI

实际日期：2026-11-02；用户在 Day 4 收尾期间追加 Day 5/6，按顺序完成并分别记录。

- 完成：货位 code/ID 搜索、多结果选择、fly-to、自由透视/俯视正交、resize、相机重置、区域筛选、2D 列表及 CI workflow。
- 边界：相机只保留一个 ref 动画，新请求替换旧请求；无逐帧 React setState；筛选不写数据库或改变障碍。列表不挂载 Canvas。
- 浏览器：快速依次定位 R01-1-L1、R02-2-L2、CH-01，最终 idle/target=[1.5,0.5,16.5]；QC/储存区筛选分别 1/12 行；800×900 正交 resize 通过。
- 降级：真实 context loss 后列表可用；另起 `--disable-webgl` 浏览器，确认 WebGL2=null 后仍能读取 17 行与 QC HOLD 详情。
- 失败与修正：最初用两张 GPU PNG 字节相同判断相机稳定不可靠；关闭轨道惯性、明确收敛端点，改用相机 transition/target 验收。没有据此声称像素级渲染确定性。
- CI：固定工具链、冻结安装、lint/typecheck/build、Vitest、真实 PostgreSQL/Jest 和 artifact 上传；Action 标签已核实存在，本地命令链通过。验收记录时尚未推送，远程 CI 未运行；提交后以 GitHub Actions 为准。
- 最终验证：35 项前端、44 项 DB/API 通过，DB 重启重算 0 差异。报告截图包含真实 QA reserved=2 的显示，不代表生产预占流程已实现。
- AI 协作：AI 辅助实现/验证/报告，独立理解仍需用户口述相机、矩阵、near/far 和状态归属。
- 下次第一步：按用户要求再进入 Day 7 复盘，不提前做机器人或实时系统。

详见 [验收报告](../../reports/day-06-acceptance.md)与 [预览](../../reports/day-06-preview.png)。
