# Day25 验收：设备故障与原任务载货恢复

日期：2026-11-19（Asia/Shanghai）。基线 `bf8d5f7c3076badf3c3b14e365ce8d5b2e4c3a60`（Day24 已验收并推送）。范围/涉及文件/三个审查组/五项验收与命令见 [devlog](../docs/devlog/day-25.md)，权威/事务/取消语义见 [ADR0016](../docs/adr/0016-phase-preserving-device-recovery.md)。本轮只推进 Day25。

## 实现与安全边界

设备故障独立保存，不替换原运输phase和phaseTicks。空载PAUSED、载货NEEDS_RECOVERY从故障+持久claim.loaded推导，不能客户端填写。步边界停住，故障tick命令不移动、耗电、取放，不释放TRANSIT、目标容量或通道；维修继续原claim，仅清设备故障，导航暂停仍有效。反之地图解封也不能清设备故障。

仅取货前可取消运输：READY→CANCELLED，来源reserved减量、目标容量释放、claim关闭和检查点/审计/历史同事务；无物理搬运流水，不删历史，不挪车/释放物理许可，故障车仍须维修。载货取消409，数据库也拒绝IN_TRANSIT→CANCELLED。不是出库整单取消/重新分配流程：出库ALLOCATION历史保留，不能发运含取消运输的单据，已取消来源不可重领，继续业务需新单据。上架receipt同样保留终态任务。

沿用现有技术栈，无新依赖/框架/消息服务。两个新增迁移先增加枚举，再最小放宽原触发器的取货前取消边，不改写旧迁移、不移除端点/容量/唯一归属等保护。

## 实际发现与修正

首轮新增真实库测试中两个上架夹具传入了入库接口不允许的 `batchId`，产品严格返回400 Unknown field。按实际契约改用 batchCode/producedAt/expiresAt，并选兼容的空储位；不放宽产品输入，不删除失败用例。首轮 Node 51/53、整体退出1，未运行到后续Jest/数据库重启，不计通过。修正后重新完整执行。

另在代码复核时明确未知来源paused不得先注入故障再维修以清除，加入拒绝与纯反例；通用ERROR/撤权/耗尽不当成可维修模拟故障。

浏览器启动时未固定版本的npx请求未缓存CLI 0.1.25，`--no-install`正确中止，没有启动产品测试。复用已缓存0.1.24离线运行，未升级项目依赖，复现命令已固定该版本。完整功能首轮通过后人工检查发现长资源表横向溢出，且完成截图因Query滞后仍显示UNLOADING；增加局部换行与故障提示独占行、截图前等待UI确实COMPLETED，新增页面无横向溢出断言，再用新库完整复验。不把API完成读数当成截图同一水位，也不归档旧截图冒充最终展示。

## 静态与纯测试

最终 `pnpm check`（lint/typecheck/build）通过，`pnpm test:unit` **122/122**：simulation **50**、web **72**，0失败/跳过。新增6项纯故障反例与1项web恢复契约测试。构建保留既有场景chunk >500kB警告，不声称优化包体、FPS或吞吐。

逐APPROACH/LOADING/TRANSPORT/UNLOADING验证停12tick后原位置/电量/phase进度不变，维修完成且全程take/drop各一次；取货前取消保留assignment历史与所在资源/设备故障，载货取消拒绝；故障与导航暂停交叠互不误清，错误状态不能维修。

## 真实 PostgreSQL / 重启

最终 `pnpm test:integration` **152/152**（Node **53**、Jest **99**），0失败/跳过，整体退出0。新9项真实库用例覆盖：四阶段故障各停12tick后维修原claim完成且take/drop仅一次；APPROACH/LOADING故障后取消各释放来源/目标并保留历史、物理占格/故障，修好再接新单；控制授权/伪造/旧claim拒绝与故障/取消事件失败全快照回滚；上架取货前取消与载货维修。载货阶段API409且数据库拒绝CANCELLED，完成后故障不改变快照。

上架载货恢复后仅两条putaway取放流水；同测试再给该车分配真实出库，取货后故障，独立第二连接过期租约接管并提交，仍保留NEEDS_RECOVERY和原位置/货物，作为本轮实际PG重启前持久故障样本。不是只新建浏览器状态模拟接管。

环境 Node v22.14.0、真实 PostgreSQL 18.6 / Windows x86_64；隔离测试库不读取/重置开发库。**2026-11-19T01:55:22.945Z**（上海09:55:22），实际关闭/启动PG后，三个库库存/预占与订单/事件/检查点差异均 **0**；写测试库 **41** 个检查点，其中 **23** 个车队、**10** 个含资源，其余两个库检查点0。重启后逐fleet验证资源、导航与设备故障的暂停/时间合法性。旧单车API kill回归继续通过，不将其冒充新增fleet故障进程SIGKILL证据。

迁移升级回归实际保留旧业务和凭证：两仓库、22条余额、22条物理流水未改写，最终迁移 `202611190002_recovery_guards`；该升级夹具本身没有历史PutawayTask，不宣称覆盖其所有生产数据组合。新测试另创建真实任务执行新增状态边。

## 浏览器

使用全新普通seed QA库，最终回调 `scripts/browser-checks/day25-recovery.js` 于 **2026-11-19T02:00:42.185Z**（上海10:00:42）完整返回 **passed=true**，没有手工SQL修改位置/库存或额外夹具命令。API仅用于当前授权用户准备真实出库单，初始化、资源配置、分配、故障/取消/维修均走真实UI。

| 验收项 | 实测 |
| --- | --- |
| 取货前取消 | robot-2 第一单先注入故障，再取消，当前task清空、来源预占归0、设备故障保留；显式维修后接第二张新单 |
| 实际载货故障 | 第二单TRANSPORT，tick20，在(5,4)已取货；NEEDS_RECOVERY，`loaded-lane` AISLE/1的物理owner为robot-2 |
| 暂停与刷新 | 至少再8tick不移位/耗电、不丢载荷/通道许可；暂停对账consistent=true；页面刷新仍为原claim与载货故障 |
| 维修与一次完成 | 维修后同一claim继续，最终tick57、COMPLETED，停在(27,3)，仍持通道许可（完成车不透明） |
| 有界持久历史 | 固定水位75之前75条连续事件，57批FLEET_TICK，逐批无同格，故障批次原地；五次控制依次FAULT/CANCEL/REPAIR/FAULT/REPAIR，均有actorId和reason |
| 业务次数与台账 | TRANSPORT_CANCELLED、TRANSPORT_TAKEN、TRANSPORT_DROPPED各1；现存62、预占1、可用54、待检7，最终WMS consistent=true，未自动人工发运 |
| 权限与边界 | 载货取消409；viewer原生按钮disabled且控制API403；额外验证页面无横向溢出 |

已人工检查最终两图中的中文告警、禁用/维修按钮、载货/完成状态、资源owner与三台场景模型：[载货故障](day-25-loaded-fault.png)、[维修完成](day-25-repaired.png)。暂停图显示页面轮询tick27/水位43，与注入响应tick20不同；API已观测至少8tick但截图可滞后一个轮询，不把它说成整仓原子快照。完成图确认UI已到tick57/水位75并显示COMPLETED。

SHA-256：
- `day-25-loaded-fault.png`：`257bbe7b4ee75819b2d4a188c67a4d50a7f34916c502cfc1d14f757b98f5311e`
- `day-25-repaired.png`：`eae80c3772ae273944228cfa37e6b3984b9766e0a5b1c2db1c0f7bad8e7e37bd`

最终页面0 console errors，保留既有THREE.Clock弃用警告；初始未登录`/auth/me`401为会话检查，不算业务失败。原始CLI/首轮截图留output，不上传日志或PDF。最终样式/截图等待修正后再次check与122项单元通过；后台核心/数据库源码未改变，沿用上述最终152项集成结果。关闭专用Chrome并向QA输入stop，确认退出0，不遗留本轮API/Vite/PG。

## 限制与保留

故障在网格步提交边界生效，不声称连续物理中途停车或工业安全。维修只针对本功能注入的设备故障，不自动修复账本ERROR、撤权、布局变化、电量耗尽或死锁；无跨车接驳、充电或整单重开。故障车可以导致其他车真实等待；不挪走其他车、不清库存制造完成。控制重复/过期返回409，重读后显式决定，不伪造幂等成功。

原day07录像删除、output/tmp/本地PDF保留，不纳入提交。没有发布/部署、标签或PDF归档；仅验证通过后正常推main，远端核对在交付回复记录。
