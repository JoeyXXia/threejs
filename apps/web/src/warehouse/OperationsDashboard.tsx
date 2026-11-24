import type { FleetResponse, OperationsResponse, RobotSnapshot } from '@warehouse-twin/contracts';
import { completionRate, heatLegend, type HeatCell, type HeatMode } from './operations';

type Props = {
  operations: OperationsResponse | undefined; unavailable: boolean; inventoryWatermark: number;
  fleet: FleetResponse; robot: RobotSnapshot | null;
  mode: HeatMode; cells: HeatCell[]; onMode: (mode: HeatMode) => void;
};

export function OperationsDashboard({ operations, unavailable, inventoryWatermark, fleet, robot, mode, cells, onMode }: Props) {
  const fleetRobots = fleet.enabled ? fleet.robots : [];
  const active = (phase: string) => !['IDLE', 'COMPLETED', 'ERROR'].includes(phase);
  const running = fleet.enabled ? fleetRobots.filter((r) => active(r.phase) && !r.charge && !r.deviceFault).length : Number(!!robot && active(robot.phase));
  const faulted = fleet.enabled ? fleetRobots.filter((r) => !!r.deviceFault || r.phase === 'ERROR').length : Number(robot?.phase === 'ERROR');
  const charging = fleetRobots.filter((r) => r.charge != null).length;
  const rate = operations && completionRate(operations.terminal.completed, operations.terminal.cancelled);
  return <section aria-label="运营指标">
    <h2>运营指标</h2>
    {operations ? <>
      <dl className="operations-metrics">
        <div><dt>待处理单（入库 / 出库 / 盘点）</dt><dd data-testid="ops-pending">{operations.pending.inbound} / {operations.pending.outbound} / {operations.pending.count}</dd></div>
        <div><dt>搬运队列（待取 / 在途）</dt><dd data-testid="ops-queue">{operations.queue.ready} / {operations.queue.inTransit}</dd></div>
        <div><dt>近 1 小时搬运完成率</dt><dd data-testid="ops-completion">{rate == null ? '—（无终态任务）' : `${(rate * 100).toFixed(1)}%（完成 ${operations.terminal.completed}，取消 ${operations.terminal.cancelled}）`}</dd></div>
      </dl>
      <p className="view-note">完成 ÷（完成 + 取消）；不含未结束任务，不等于发运率。指标水位 {operations.watermark}，时间窗截至 <time dateTime={operations.terminal.through}>{new Date(operations.terminal.through).toLocaleTimeString()}</time>。</p>
    </> : <p>{unavailable ? '运营指标暂不可用。' : '正在读取运营指标…'}</p>}
    <p data-testid="ops-fleet">车队：运行 {running} · 故障 {faulted} · 充电任务 {charging}（含去充电位） · 快照水位 {inventoryWatermark}</p>
    <div className="view-switch" role="group" aria-label="热力图层">
      {([['off', '关闭热力'], ['inventory', '库存热力'], ['wait', '通道等待热力']] as const).map(([value, label]) =>
        <button key={value} aria-pressed={mode === value} onClick={() => onMode(value)}>{label}</button>)}
    </div>
    {mode !== 'off' && <div data-testid="operations-heat-legend" data-mode={mode} data-cells={cells.length}>
      <p>{mode === 'inventory' ? '库存：全仓实地点位现存件数，按地面格合并各层；不含虚拟在途。'
        : `等待：当前布局最近 ${operations?.wait.limit ?? 240} 个已提交 tick 的累计车辆秒。位置访问频率不等于拥堵。`}</p>
      <ul className="zone-legend" aria-label="热力图例">
        {heatLegend[mode].map((entry) => <li key={entry.label}><i style={{ background: entry.color }} />{entry.label}</li>)}
      </ul>
      {mode === 'wait' && (operations ? <p className="view-note">有效样本 {operations.wait.sampledTicks} tick
        {operations.wait.firstSeq !== null && ` · 事件序号范围 ${operations.wait.firstSeq}–${operations.wait.lastSeq}`}</p>
        : <p>当前布局的等待数据暂不可用。</p>)}
      {cells.length === 0 && <p>{mode === 'inventory' ? '没有实地点位现存。' : '暂无该布局的通道拥堵记录。'}</p>}
      {cells.length > 0 && <p className="view-note">最高格（最多 3 个）：{[...cells].sort((a, b) => b.value - a.value).slice(0, 3).map((c) =>
        `(${c.x},${c.z}) ${mode === 'wait' ? c.value / 1000 + ' 秒' : c.value + ' 件'}`).join(' · ')}</p>}
    </div>}
  </section>;
}
