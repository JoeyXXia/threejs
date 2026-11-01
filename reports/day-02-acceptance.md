# Day 2 验收报告：数据库、身份与仓库访问

日期：2026-11-01（Asia/Shanghai）。基线 Git：`2c2eaa2`；本报告对应其后本地 Day 2 改动，不将基线 SHA 当作本次代码版本。没有地图版本或 seed 数字：今天没有模拟器，数据为固定身份/空间种子。

## 环境与方法

- Windows x64；应用/测试 Node `v22.14.0`，pnpm `11.25.0`；包管理器启动器使用 Node `24.22.1`。
- Prisma / Client `6.19.3`，Nest `12.2.0`，Jest `30.5.2`，Supertest `7.3.1`。
- 数据库实际查询：`PostgreSQL 18.6 on x86_64-windows, compiled by msvc-19.44.35228, 64-bit`。来自 `SELECT version()`，并非由 npm 包名推测。
- 测试使用全新临时集群，随机凭据，库名 `warehouse_twin_test`，端口 15432；HTTP API 13001，每个测试单独启动实际 API。未使用 ORM mock。
- 开发库 `warehouse_twin` 另在 5432 运行并验证迁移/seed。测试不加载开发 `.env`，也不重置开发库。

## 5 项验收结果

| 条件 | 实际证据 | 结果 |
| --- | --- | --- |
| 空库可迁移，seed 可重复且不重复建数据 | 迁移 `202611010001_identity`；连续 seed，再比较 4 用户、2 空间、2 仓库、4 访问关系及密码哈希 | 通过 |
| 登录凭据与会话安全边界 | 错误密码/未知邮箱同样 401；HttpOnly/SameSite Cookie；DB 仅存令牌 SHA256；JSON 无密码哈希/令牌 | 通过 |
| 未登录、到期和退出不能继续授权 | 匿名读写 401；修改 DB 会话为过期后 401；退出删除当前会话，旧 Cookie 再请求 401 | 通过 |
| viewer 只读；允许写角色有审计和冲突边界 | viewer PATCH 403 且无副作用；admin/operator 写入成功；同版本两个并发请求一成功一 409，审计仅增加一条；审计故障触发整体回滚 | 通过 |
| 空间/仓库归属不能伪造 | 替换空间/仓库或拼接错误均 404；body actor/role/scope 被拒；复合外键拒绝跨空间访问记录；已有会话权限撤销后立即重新校验 | 通过 |

## 命令与实际结果

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，4 个 workspace projects，Already up to date |
| `pnpm db:generate` | Prisma Client 6.19.3 生成成功 |
| `pnpm check` | lint、strict typecheck、web/API build 通过 |
| `pnpm test:integration` | 1 个 suite，18 项测试通过，0 失败；覆盖范围见下方原始输出与测试文件 |
| `pnpm db:migrate` / `pnpm seed` | 独立开发库成功部署迁移并 seed |
| `pnpm smoke` | 构建后 API /health、404、HTML、React 模块转换、匿名 401、Vite 代理通过 |
| `pnpm smoke --dev-api` | tsx 源码启动与同样 HTTP 检查通过 |
| `pnpm smoke --dev-api --with-auth` | 通过 Vite 代理执行登录、读取授权身份、退出及旧 Cookie 拒绝，全部通过 |

原始结果由测试命令生成于本地 `reports/day-02-jest.json` 和 `reports/day-02-environment.json`，为可重跑产物，不入 Git；可审查测试源码为 `tests/integration/auth.test.cjs`。测试时长不是性能指标，本报告不据此宣称吞吐或响应时间。

## 额外覆盖与失败注入

- 未知字段、非法 ID、不可信 Origin 与缺少自定义写请求 header 被拒绝。
- 角色降级和访问关系删除不需要重新登录才生效，数据库中的角色是权威。
- 真实 PostgreSQL 两个并发写请求使用版本条件更新，最终只产生一次业务修改及一次审计。
- 测试库临时增加审计表拒绝插入触发器，HTTP 返回通用 500，仓库记录保持原值；测试 finally 移除触发器。没有在开发库注入故障。
- 幂等基础表相同作用域/操作者/操作/key 重复插入被唯一约束拒绝；其他操作可用同名 key。这不代表库存命令的幂等已实现。
- 每分钟单进程/IP 的第 11 次登录尝试返回 429；未测分布式限流。

## 实际失败及修正

Windows 中文路径导致 initdb UTF8 错误，只搬数据目录未能解决；改为 ASCII TEMP 二进制和数据路径后成功。最初密码临时文件置于数据目录使 initdb 拒绝，移到目录外并用后删除。Nest 12 ESM 被 Jest CJS loader 拒绝，改为对真实 API 子进程发 HTTP 请求后测试通过。pnpm 运行时版本与构建脚本配置问题见 [开发日志](../docs/devlog/day-02.md)。

## 未验证与保证范围

- **Compose 未执行**：本机未安装 Docker。配置采用官方 `postgres:18.6` 和 18 的目录挂载规则，但不能记为容器启动通过。
- **浏览器 UI 未端到端测试**：已构建页面并验证 Vite HTTP/认证代理，未完成浏览器点击、Cookie 自动存取、到期定时器与视觉布局验收。API 过期与退出拒绝已实测。
- **未验证 DB 中断恢复/进程崩溃恢复、负载性能、Linux/macOS 便携 runner、生产 HTTPS 部署**。TEMP 可能被系统清理，不能用作正式仓储数据存储。
- **过期会话拒绝访问，但记录暂未定期清理**；限流只在单进程有效。无注册、找回密码、角色编辑后台。
- **今天没有库存、设备或回放业务**；T01–T16 的完整业务验收仍未完成。审计不是不可篡改存储，幂等尚无 WMS 命令处理流程。

Day 2 的数据库与 HTTP 身份/授权目标已由上述证据覆盖；明确留下 Compose 和浏览器验收缺口。
