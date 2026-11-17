import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FleetResponse, SimulationResponse } from '@warehouse-twin/contracts';
import { api, ApiError } from '../api';
import { fleetKey, fleetPath } from './fleet-data';
import { simulationKey } from './robot-data';

export function FleetPanel({ data, options, error, userId, spaceId, warehouseId, onUnauthorized }: {
  data: FleetResponse | undefined; options: SimulationResponse | undefined; error: Error | null;
  userId: string; spaceId: string; warehouseId: string; onUnauthorized: () => void;
}) {
  const client = useQueryClient(), [kind, setKind] = useState('OUTBOUND'), [now, setNow] = useState(Date.now);
  const advanced = useRef(Date.now());
  useEffect(() => { advanced.current = Date.now(); }, [data?.tick]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const command = useMutation({ mutationFn: ({ path, body }: { path: string; body: object }) => api(`${fleetPath(spaceId, warehouseId)}/${path}`, 'POST', body),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: fleetKey(userId, spaceId, warehouseId), exact: true }), client.invalidateQueries({ queryKey: simulationKey(userId, spaceId, warehouseId), exact: true })]) });
  useEffect(() => { if (command.error instanceof ApiError && command.error.status === 401) onUnauthorized(); }, [command.error, onUnauthorized]);
  const active = data?.robots.some((r) => !['IDLE', 'COMPLETED', 'ERROR'].includes(r.phase));
  const stale = !!error || (active && now - advanced.current > 1500);
  const disabled = !data || data.role === 'VIEWER' || command.isPending;
  return <section className="robot-panel" aria-label="多车协调">
    <h2>多车分配与集中下一步协调</h2>
    <p>3–5 台软件车；保守禁止进入其他车本 tick 起始占格。可能真实等待或死锁，不宣称无死锁或工业避碰。</p>
    {error && <p role="alert">{error.message}</p>}{command.error && <p role="alert">{command.error.message}。状态变化时刷新后重试，不会绕过任务归属。</p>}
    {stale && <p role="alert">等待 runner 新提交，保留最后确认位置，不外推。</p>}
    {!data?.enabled ? <form aria-label="初始化多车" onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      command.mutate({ path: 'initialize', body: { count: Number(form.get('count')), reason: form.get('reason') } });
    }}><fieldset disabled={disabled}>
      <label>车队规模<select name="count" defaultValue="3"><option value="3">3 台</option><option value="4">4 台</option><option value="5">5 台</option></select></label>
      <label>初始化原因<input name="reason" required maxLength={200} /></label><button>初始化多车模式</button>
      <p>仅无活动/异常单车任务时允许切换，保留旧车位置/电量与统一 tick；初始化后不能重置车队。</p>
    </fieldset></form> : <>
      <p data-testid="fleet-status">车数 {data.robots.length} · tick {data.tick} · 水位 {data.watermark} · epoch {data.epoch}</p>
      <table aria-label="车队状态"><thead><tr><th>车辆</th><th>阶段/货物</th><th>位置</th><th>等待</th><th>任务归属</th></tr></thead><tbody>
        {data.robots.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.phase} · {r.carrying ? '载货' : '空载'} · {(r.battery / 100).toFixed(2)}%</td>
          <td>({r.to.x}, {r.to.z})</td><td>{r.waitReason ?? '无'} {r.blockerId ?? ''} · 连续 {r.waitTicks} / 累计 {r.totalWaitTicks} tick</td>
          <td>{r.taskId ?? '未分配'}<br />{r.ledgerTaskId ?? ''}{r.error && <strong role="alert">{r.error}</strong>}</td></tr>)}</tbody></table>
      <form aria-label="分配多车任务" onSubmit={(event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        command.mutate({ path: 'assign', body: { robotId: form.get('robotId'), kind, reason: form.get('reason'),
          ...(kind === 'OUTBOUND' ? { allocationId: form.get('source'), stagingLocationId: form.get('target') } : { inboundOrderId: form.get('source'), targetLocationId: form.get('target') }) } });
      }}><fieldset disabled={disabled || !!error}>
        <label>分配车辆<select name="robotId" required>{data.robots.filter((r) => ['IDLE', 'COMPLETED'].includes(r.phase)).map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}</select></label>
        <label>多车任务类型<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="OUTBOUND">出库搬运</option><option value="PUTAWAY">质检放行上架</option></select></label>
        <label>多车任务来源<select key={`source:${kind}`} name="source" required><option value="">选择来源</option>{(kind === 'OUTBOUND' ? options?.allocations : options?.putawayReceipts)?.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
        <label>多车任务目标<select key={`target:${kind}`} name="target" required><option value="">选择目标</option>{(kind === 'OUTBOUND' ? options?.staging : options?.storage)?.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}</select></label>
        <label>分配原因<input name="reason" required maxLength={200} /></label><button disabled={!data.robots.some((r) => ['IDLE', 'COMPLETED'].includes(r.phase))}>确认分配到车辆</button>
      </fieldset></form>
    </>}
  </section>;
}
