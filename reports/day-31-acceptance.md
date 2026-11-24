# Day31 验收 — 运营指标与库存／通道热力

日期：2026-11-24（Asia/Shanghai）。基线 `00ff9bc`。只测本仓软件仿真，不是性能或生产设备报告。

## 口径对照

| 指标 | 权威来源与口径 |
| --- | --- |
| 待处理单 | 入库 CREATED/RECEIVED（待收/待检），出库 CREATED/ALLOCATED（未发运），盘点 OPEN/SUBMITTED（未审批终结）。按单数，不是件数，不重复计算运输任务。 |
| 搬运队列 | Outbound TransportTask 和 PutawayTask 的 READY / IN_TRANSIT；待取含已创建但尚未取货任务，不含尚未创建搬运任务的订单。 |
| 近一小时完成率 | 数据库事务时间往回一小时，范围两端含：完成 = TRANSPORT_DROPPED / PUTAWAY_DROPPED，取消 = TRANSPORT_CANCELLED / PUTAWAY_CANCELLED。完成 ÷（完成 + 取消），排除未终态；无分母显示“—”，不等于发运率。 |
| 车辆 | 场景确认态：运行含活动搬运中的通道等待，排除故障、ERROR 和充电任务；故障含设备故障或 ERROR；充电任务含前往充电位。 |
| 库存热力 | 场景快照中的实地点位现存，按格合并所有层，不含虚拟在途；不受当前区域、批次筛选改变。 |
| 等待热力 | 当前布局最近最多 240 个带布局标签的已提交多车 tick。每车每 tick 在确认占格加 250 ms，只计 OCCUPIED / EDGE_SWAP / TARGET_CONFLICT / RESOURCE_BUSY；秒为车辆时间，不是现场墙钟时间。位置访问频率不等于拥堵；不计设备故障、低电、封路导致无路，或旧布局及无来源标签的历史。 |

## 复验

```powershell
pnpm check
pnpm test:unit
$env:TEST_API_PORT_BASE='13040'
pnpm test:integration
# 单独终端启动隔离 QA
$env:QA_API_PORT='13036'
pnpm qa:browser
git diff --check
```

登录测试管理员后，以 Playwright CLI 执行 `run-code --filename scripts/browser-checks/day31-operations.js`。截图及原始日志仅留在本地 `output/playwright/day-31/`。

## 实测结果

- `pnpm check`、`pnpm lint`、`git diff --check` 通过。Vite 保留超过 500 kB 的分包提示，未测加载性能。单测 **137/137**（核心 55、Web 82）；集成 **162/162**（Node 63、Jest 99）；四个临时 PostgreSQL 库重启后对账一致。
- 固定样本：库存同一地面格两层 5 + 7 = 12 件，虚拟在途不计。事件手算：两个合规则竞争步在 (2,3) 合计 500 ms，另一格 (5,3) 250 ms；重复 tick、旧布局、缺标签、移动、越界、设备故障不计。单车连续 240 个竞争步累计 60,000 ms；窗口外的 10 条不计。
- 真实 PostgreSQL / Nest HTTP：三个出库单产生待取 2、在途 1；一笔完成、一笔取消后待取 1、在途 0，按口径完成率 50%；合成两小时前的终态不计。无终态任务时分母为零，越权仓库返回 404。
- Chrome 实测（09:58:32，Asia/Shanghai）：库存层有 6 个实地点地面格，零分母显示“无终态任务”。切到等待图层后看到真实单容量通道竞争，待处理单为 0 / 2 / 0，两个任务在途；按 seq 10–68 的 54 个带布局标签 tick 复算，(13,4) 共 1,000 ms，载货故障格 (8,3) 未计入。两图例分别显示件／秒，关闭图层后图例移除。
- 最终 WebGL 俯视复核对照关闭、库存、等待三张实际画面：库存格在货架遮挡下仍可辨认，等待格单独着色。仅调整库存层深度测试，没有改变聚合、布局或机器人规则；之后重新通过构建与单测。

## 限制

指标查询与场景快照各有水位；客户端按布局阻止跨图叠加。等待图没有跨布局/全量历史保留、单车热力或真实设备吞吐。等待样本按提交 tick 数而非一分钟墙钟；故障期间车不动不自动算拥堵。旧 tick 不补写，不把未采集解释为零等待。轮询按 5 秒配置，未测投影延迟。
