# ADR 0002：Day 2 会话与仓库授权

日期：2026-11-01。状态：采用。范围仅含身份、空间、仓库访问、审计及幂等基础。

## 三个审查单元

1. 数据库与运行环境：`infra/compose.yaml`、`packages/database`、环境模板、数据库脚本和依赖锁定。PostgreSQL 是唯一持久存储。没有 Docker 的 Windows 本机用便携 PostgreSQL 做开发/测试，不注册系统服务。
2. HTTP 身份与最小 UI：`apps/api/src/auth`、数据库接入、仓库 controller、`configure.ts`、React 页面。输入有运行时验证；接口只返回明确的业务字段，不直接暴露 Prisma 用户/会话模型。
3. 验证和证据：隔离测试库、Jest/Supertest、启动检查、README、devlog 和验收报告。每个单元按文件组审查；不为凑数量制造空提交。

## 身份与授权

- `User` 保存规范化邮箱和带随机盐的 scrypt 密码哈希。seed 密码从环境读取，不提供固定默认密码，重复 seed 不覆盖现有密码和仓库名称。
- 不透明会话令牌为 32 个随机字节；仅向浏览器发送 HttpOnly、SameSite=Strict Cookie，数据库仅保存 SHA256 摘要及绝对过期时间。生产环境自动添加 Secure；本地 HTTP 关闭 Secure。
- `/auth/login` 创建会话；`/auth/me` 仅返回用户 ID/邮箱、过期时间及已授权仓库；`/auth/logout` 删除当前令牌记录并清 Cookie。过期令牌服务端立即拒绝，前端定时清理显示状态；收到 401 同样退出显示。
- 角色属于 `(userId, spaceId, warehouseId)` 的访问关系，而非全局 JWT 声明。ADMIN、OPERATOR 可改仓库名称；VIEWER 只读。今天没有账号管理、权限编辑界面或完整 SaaS 平台。
- 无会话返回 401；已授权 viewer 写操作返回 403；无仓库访问关系统一返回 404，避免区分不存在和不可访问资源。
- 仓库采用 `(spaceId, id)` 唯一键，访问、审计、幂等记录均通过复合外键引用，防止空间和仓库拼接错误。

## 写操作与事务

`PATCH /spaces/:spaceId/warehouses/:warehouseId` 只接受 `name`、`version`、`reason`。actor 从服务端会话取得；body 中的 actor、role、scope 字段全部拒绝。名称和原因有长度检查，ID 校验 UUID。

事务内共享锁定访问关系，再查询当前角色；随后条件更新 `version` 并递增。两个相同版本的写操作只能成功一个，失败返回 409。仓库资料和审计在同一事务；审计失败时全部回滚。审计包含 actor/type、scope、action、reason、requestId、before/after、创建时间以及预留的 correlationId。

幂等表只提供作用域、操作者、operation/key 唯一约束、requestHash、status、response、时间字段。今天不宣称已经实现收货/取放/发运的幂等，也不提供假的通用过账接口。

## 请求与错误边界

带副作用的请求须携带 `X-Requested-With: WarehouseTwin`；浏览器 Origin 必须命中配置允许列表，不开启跨域凭据 CORS。无 Origin 的 CLI 也须带该 header。Cookie 不在 URL、localStorage 或返回 JSON 中。所有响应 no-store；未处理错误只返回通用 500，避免暴露连接串与查询。登录尝试按单进程/IP 限制为每分钟 10 次，内存表有上限；不宣称分布式限流。

HTTP `/health` 仍只是存活检查，不依赖 DB 查询。DB 中断时受保护的数据请求失败，不回退到虚构身份或库存。过期 Session 记录暂不自动清理，但不能继续授权。

## 工具链与本地数据库

使用 Prisma / Client 6.19.3，兼容现有 Node 22.14 和 TS 5.9，不为 Day 2 升级工具链。[Prisma 6 官方要求](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v6)列出 Node 22 最低 22.11。Compose 使用 [官方 postgres:18.6](https://hub.docker.com/_/postgres)，只映射 127.0.0.1，挂载 PostgreSQL 18 对应父数据目录。

便携 runner 的 npm 包版本为 `embedded-postgres@18.6.0-beta.19`，包装包带 beta 标签；数据库实际版本由 `SELECT version()` 记录，不能由包名推断。Windows 中文安装路径会导致 initdb UTF8 错误，因此将 npm native 二进制树复制到 ASCII TEMP 缓存并用 pg_ctl 管理，不修改依赖源码。数据和密码不提交；初始密码文件用后删除。仅在本机开发/测试使用，正式部署使用 Compose。

测试 runner 不读取开发 `.env`，独立生成随机口令、临时目录和 `warehouse_twin_test` 数据库。测试套件拒绝非 loopback 或非该库名的连接；不清空开发库。每个测试启动真实 API 进程，绕过 Nest 12 ESM 与 Jest CJS loader 的差异，并覆盖实际生产构建入口。

## 今天不覆盖

无库存/布局模型、机器人、Socket/回放、Query/Zustand、Redis、BullMQ、CI、密码重置、公开注册或复杂管理后台。数据库/角色验证不能等同于未来 Socket 与回放已授权；后续入口仍须接入相同权限边界。
