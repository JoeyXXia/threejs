import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SimulationResponse } from '@warehouse-twin/contracts';
import { api, ApiError } from '../api';
import { simulationKey, simulationPath } from './robot-data';

export function RobotPanel({ data, error, paused = false, updatedAt, userId, spaceId, warehouseId, onUnauthorized }: {
  data: SimulationResponse | undefined; error: Error | null; paused?: boolean; updatedAt: number;
  userId: string; spaceId: string; warehouseId: string; onUnauthorized: () => void;
}) {
  const client = useQueryClient();
  const [kind, setKind] = useState<'OUTBOUND' | 'PUTAWAY'>('OUTBOUND');
  const [inboundOrderId, setReceipt] = useState('');
  const [targetLocationId, setTarget] = useState('');
  const [allocationId, setAllocation] = useState('');
  const [stagingLocationId, setStaging] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const start = useMutation({ mutationFn: () => api(`${simulationPath(spaceId, warehouseId)}/start`, 'POST', {
    ...(kind === 'PUTAWAY' ? { kind, inboundOrderId, targetLocationId } : { allocationId, stagingLocationId }), reason: '单车软件模拟搬运',
  }), onSuccess: () => client.invalidateQueries({ queryKey: simulationKey(userId, spaceId, warehouseId), exact: true }) });
  useEffect(() => { if (start.error instanceof ApiError && start.error.status === 401) onUnauthorized(); }, [start.error, onUnauthorized]);
  const runtime = data?.runtime;
  const advancedAt = useRef(Date.now());
  useEffect(() => { advancedAt.current = Date.now(); }, [runtime?.taskId, runtime?.tick, runtime?.phase]);
  const active = runtime && !['COMPLETED', 'ERROR'].includes(runtime.phase);
  const stale = Boolean(error || (active && (now - updatedAt > 1500 || now - advancedAt.current > 1500)));
  const busy = runtime && runtime.phase !== 'COMPLETED';
  return <section aria-label="软件机器人" className="robot-panel">
    <h2>单车软件模拟</h2>
    <p>后端推进任务，浏览器只显示已确认轨迹。检查点已持久化；进程中断后等待租约接管，再从已提交 tick 恢复。</p>
    {data && <p>已提交事件水位 {data.watermark} · epoch {data.epoch} · 状态版本 {data.stateVersion}</p>}
    <p role="status" data-testid="robot-status">{!data ? '正在读取机器人状态…' : !runtime ? '暂无运行任务'
      : `任务 ${runtime.taskId} · ${runtime.phase} · tick ${runtime.tick} · 逻辑 ${runtime.logicalTimeMs}ms · 电量 ${(runtime.battery / 100).toFixed(2)}% · ${runtime.carrying ? '载货' : '空载'}`}</p>
    {stale && <p role="alert">机器人数据陈旧，已停止外推，仅保留最后确认段。</p>}
    {runtime?.error && <p role="alert">{runtime.error}</p>}
    {start.error && <p role="alert">{start.error.message}</p>}
    <form onSubmit={(event) => { event.preventDefault(); start.mutate(); }}>
      <fieldset disabled={paused || !data || data.role === 'VIEWER' || Boolean(busy) || start.isPending || stale}>
        <label>任务类型<select value={kind} onChange={(event) => setKind(event.target.value as 'OUTBOUND' | 'PUTAWAY')}><option value="OUTBOUND">出库搬运</option><option value="PUTAWAY">质检放行上架</option></select></label>
        {kind === 'PUTAWAY' ? <>
          <label>已放行入库单<select value={inboundOrderId} onChange={(event) => setReceipt(event.target.value)} required><option value="">选择整单</option>{data?.putawayReceipts.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
          <label>上架储位<select value={targetLocationId} onChange={(event) => setTarget(event.target.value)} required><option value="">选择 STORAGE</option>{data?.storage.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select></label>
        </> : <><label>运输分配<select value={allocationId} onChange={(event) => setAllocation(event.target.value)} required>
          <option value="">选择已预占分配</option>{data?.allocations.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select></label>
        <label>出库暂存位<select value={stagingLocationId} onChange={(event) => setStaging(event.target.value)} required>
          <option value="">选择暂存位</option>{data?.staging.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select></label></>}<button>启动单车搬运</button>
      </fieldset>
    </form>
    {runtime && <p>最后确认位置 ({runtime.to.x}, {runtime.to.z})；路线 {runtime.route.length} 点。任务到达暂存区后不自动发运。</p>}
    {data?.allocations.length === 100 && <p>仅列出前 100 条分配。</p>}
    {data?.putawayReceipts.length === 100 && <p>仅列出前 100 条待上架入库单；一次整单上架，不拆分或自动选储位。</p>}
  </section>;
}
