import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SimulationResponse } from '@warehouse-twin/contracts';
import { api, ApiError } from '../api';
import { simulationKey, simulationPath } from './robot-data';

export function RobotPanel({ data, error, updatedAt, userId, spaceId, warehouseId, onUnauthorized }: {
  data: SimulationResponse | undefined; error: Error | null; updatedAt: number;
  userId: string; spaceId: string; warehouseId: string; onUnauthorized: () => void;
}) {
  const client = useQueryClient();
  const [allocationId, setAllocation] = useState('');
  const [stagingLocationId, setStaging] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const start = useMutation({ mutationFn: () => api(`${simulationPath(spaceId, warehouseId)}/start`, 'POST', {
    allocationId, stagingLocationId, reason: '单车软件模拟搬运',
  }), onSuccess: () => client.invalidateQueries({ queryKey: simulationKey(userId, spaceId, warehouseId), exact: true }) });
  useEffect(() => { if (start.error instanceof ApiError && start.error.status === 401) onUnauthorized(); }, [start.error, onUnauthorized]);
  const runtime = data?.runtime;
  const advancedAt = useRef(Date.now());
  useEffect(() => { advancedAt.current = Date.now(); }, [runtime?.taskId, runtime?.tick, runtime?.phase]);
  const active = runtime && !['COMPLETED', 'ERROR'].includes(runtime.phase);
  const stale = Boolean(error || (runtime && now - updatedAt > 1500) || (active && now - advancedAt.current > 1500));
  const busy = runtime && runtime.phase !== 'COMPLETED';
  return <section aria-label="软件机器人" className="robot-panel">
    <h2>单车软件模拟</h2>
    <p>后端推进任务，浏览器只显示已确认轨迹。当前仅单进程内存运行，不支持进程重启恢复。</p>
    <p role="status" data-testid="robot-status">{!data ? '正在读取机器人状态…' : !runtime ? '暂无运行任务'
      : `任务 ${runtime.taskId} · ${runtime.phase} · tick ${runtime.tick} · 逻辑 ${runtime.logicalTimeMs}ms · 电量 ${(runtime.battery / 100).toFixed(2)}% · ${runtime.carrying ? '载货' : '空载'}`}</p>
    {stale && <p role="alert">机器人数据陈旧，已停止外推，仅保留最后确认段。</p>}
    {runtime?.error && <p role="alert">{runtime.error}</p>}
    {start.error && <p role="alert">{start.error.message}</p>}
    <form onSubmit={(event) => { event.preventDefault(); start.mutate(); }}>
      <fieldset disabled={!data || data.role === 'VIEWER' || Boolean(busy) || start.isPending || stale}>
        <label>运输分配<select value={allocationId} onChange={(event) => setAllocation(event.target.value)} required>
          <option value="">选择已预占分配</option>{data?.allocations.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select></label>
        <label>出库暂存位<select value={stagingLocationId} onChange={(event) => setStaging(event.target.value)} required>
          <option value="">选择暂存位</option>{data?.staging.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select></label><button>启动单车搬运</button>
      </fieldset>
    </form>
    {runtime && <p>最后确认位置 ({runtime.to.x}, {runtime.to.z})；路线 {runtime.route.length} 点。任务到达暂存区后不自动发运。</p>}
    {data?.allocations.length === 100 && <p>仅列出前 100 条分配。</p>}
  </section>;
}
