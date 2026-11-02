# Day 4 验收：数据驱动场景

实际日期：2026-11-02。基线 `f246d5c`；本报告在本地 Day 4–6 验收完成、提交前记录，此处不把基线当作本次代码 SHA。

## 范围和结果

共享契约/Zod、Router、TanStack Query、Zustand、R3F/Drei 参数化仓库已实现。没有引入新后端服务或数据库迁移。

| 可观察条件 | 实际证据 | 结果 |
| --- | --- | --- |
| 场景来自后端布局 | 临时 DB 发布 v2，R01 gridX 从 6 改为 8；刷新后 API 和页面均为 v2，实际画面移位 | 通过 |
| API 失败有提示 | 浏览器注入 inventory HTTP 503；旧 Canvas 与汇总消失；解除故障后重试恢复 | 通过 |
| 空数据不冒充库存 | 真正无余额的 QA 仓显示 4 个 0；缺少 inventory 的响应在单测中报错而非补 0 | 通过 |
| 状态边界与版本可验证 | key 区分用户/空间/仓库；取消两请求、迟到旧 scope、版本不一致有界重取和错误态测试通过 | 通过 |
| 坐标遵守约定 | 格心/矩形中心、原点/比例、边界、回转验证；浏览器实际 WebGL 场景已查看 | 通过 |

核心前端测试 20 项（coordinates 7、data 12、error-state 1）通过；合并后前端共 35 项通过。`pnpm check` 通过；原 44 项 PostgreSQL/API 回归通过，数据库重启后重算一致。

另在 QA 数据库使真实会话过期，浏览器点击刷新后返回登录表单，旧 Canvas 与库存汇总均清除；未继续显示上个身份的数据。

## 实际环境与失败

Windows x64、应用 Node 22.14.0、pnpm 11.25.0；React 19.3.1、R3F 9.8.2、Three 0.186.1。新增 Query 5.104.5、Zustand 5.0.16、Router 7.18.5、Zod 4.6.7、Vitest 5.0.5，均精确锁定。

真实 Chrome WebGL renderer：`ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002560) Direct3D11 vs_5_0 ps_5_0, D3D11)`。这只是本机渲染环境，不是 FPS/性能成绩。

浏览器发现 CJS workspace 包无法原生导入导致白屏，改 ESM 后通过；初次 QA 非交互 stdin 结束导致连接拒绝，改交互终端后通过。最新 Query 版本未满足已有 24 小时成熟期，保留规则选择已成熟版本。审批服务额度曾中断检查，后续正常重试通过。

3D 代码按需加载；仍有大 chunk 警告，未调整警告阈值掩盖。当前依赖产生 Three.Clock 弃用警告；移除的 soft shadow 路径已改为 PCF percentage。没有宣称零警告、长时间无资源增长或跨设备兼容已测完。

## 证据与未覆盖

`pnpm test:unit` → `reports/unit.json`；`pnpm test:integration` → `reports/integration-*.json`，本地原始产物忽略入 Git。浏览器脚本在 `scripts/browser-checks`，使用独立 QA 数据库；公开夹具密码不是开发凭据。

最终画面见 [预览](day-06-preview.png)，该图包含后续 Day 5/6 的交互，不冒充 Day 4 的初始 UI。无机器人、Socket、回放或库存写命令；未测 FPS、吞吐、长期资源、其他 GPU/浏览器及 Compose。
