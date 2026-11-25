import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { ApiError } from '../api';
import { loadReplay, type ReplayData } from './replay-data';
import { createReplayStore, replayInterval, type ReplaySpeed } from './replay-store';
import { SceneBoundary } from './SceneBoundary';

const ArchiveScene = lazy(() => import('./WarehouseScene').then((m) => ({ default: m.WarehouseScene })));
const localTime = (time: number) => new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
const initialRange = () => {
  const now = Date.now();
  return { from: new Date(now - 60_000).toISOString(), to: new Date(now).toISOString() };
};

function ReplayPlayer({ data }: { data: ReplayData }) {
  const { timeline, layouts } = data;
  const [store] = useState(() => createReplayStore(timeline));
  const player = useStore(store);
  const { frame, navigation, resources } = player.state;
  const layout = layouts[frame.layoutId]!;
  const summary = frame.state.inventory;
  const tasks = new Map(timeline.frames.flatMap(({ state }) => state.robots
    .filter((r) => r.taskId !== null).map((r) => [r.taskId!, r.ledgerTaskId ?? r.taskId!] as const)));
  useEffect(() => {
    if (!player.playing) return;
    const timer = window.setInterval(player.advance, replayInterval(player.speed));
    return () => window.clearInterval(timer);
  }, [player.advance, player.playing, player.speed]);
  return <>
    <section aria-label="回放时间轴" className="replay-controls">
      <button type="button" disabled={player.index === timeline.frames.length - 1} onClick={player.toggle}>{player.playing ? '暂停' : '播放'}</button>
      <label>速度 <select value={player.speed} onChange={(e) => player.setSpeed(Number(e.target.value) as ReplaySpeed)}>
        <option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option>
      </select></label>
      <label>任务高亮 <select value={player.task} onChange={(e) => player.setTask(e.target.value)}>
        <option value="">不筛选</option>{[...tasks].map(([id, ledger]) => <option key={id} value={id}>任务 {ledger.slice(0, 8)}</option>)}
      </select></label>
      <label>时间轴 <input aria-label="时间轴" type="range" min={timeline.first} max={timeline.frames.length - 1}
        value={player.index} aria-valuetext={`tick ${frame.tick}`} onChange={(e) => player.seek(Number(e.target.value))} /></label>
    </section>
    <p className="view-note" data-testid="replay-position" data-index={player.index} data-tick={frame.tick} data-seq={frame.seq}>
      tick {frame.tick} · 事件 seq {frame.seq} / {timeline.through} · 归档布局 v{frame.layoutVersion} · <time dateTime={frame.capturedAt}>{new Date(frame.capturedAt).toLocaleString()}</time>
    </p>
    <p data-testid="replay-stock">现存 {summary.onHand} · 预占 {summary.reserved} · 可用 {summary.available} · 待检 {summary.hold}</p>
    <p className="view-note" data-testid="replay-navigation">封路修订 {navigation.revision} · 封闭格 {navigation.closed.length} · 单容量资源 {resources.length}</p>
    <div className="scene-canvas" aria-label="历史三维仓库"><SceneBoundary key={frame.layoutId}>
      <Suspense fallback={<p>正在载入归档布局…</p>}><ArchiveScene snapshot={{ layout }}
        views={[]} showZones showServiceCells={false} selectedLocationId={null} zoneFilter="ALL"
        cameraMode="perspective" cameraRequest={overview} onSelect={ignore} heat={null}
        replay={{ robots: frame.state.robots, closed: navigation.closed, task: player.task }} /></Suspense>
    </SceneBoundary></div>
    <table aria-label="全车历史状态" className="replay-table">
      <thead><tr><th>车辆</th><th>任务</th><th>确认格</th><th>阶段与状态</th></tr></thead>
      <tbody>{frame.state.robots.map((r) => <tr key={r.id} data-highlighted={Boolean(player.task && r.taskId === player.task)}>
        <td>{r.id}</td><td>{r.ledgerTaskId ?? r.taskId ?? '—'}</td><td>({r.cell.x},{r.cell.z})</td>
        <td>{r.phase} · {r.carrying ? '载货' : '空载'}{r.fault && ' · 故障'}{r.charging && ' · 充电任务'}{r.waitReason && ` · ${r.waitReason}`}</td>
      </tr>)}</tbody>
    </table>
    {resources.length > 0 && <p className="view-note">资源占位：{resources.map((r) => `${r.id}: ${r.ownerId ?? '空闲'}`).join(' · ')}</p>}
  </>;
}
const overview = { locationId: null, sequence: 0 };
const ignore = () => {};

export function ReplayView({ userId, spaceId, warehouseId, name, onUnauthorized }: {
  userId: string; spaceId: string; warehouseId: string; name: string; onUnauthorized: () => void;
}) {
  const [range, setRange] = useState(initialRange);
  const [from, setFrom] = useState(() => localTime(Date.parse(range.from)));
  const [to, setTo] = useState(() => localTime(Date.parse(range.to)));
  const [formError, setFormError] = useState('');
  const history = useQuery({
    queryKey: ['warehouse-replay', userId, spaceId, warehouseId, range.from, range.to],
    queryFn: ({ signal }) => loadReplay(spaceId, warehouseId, range.from, range.to, signal),
    gcTime: 0, staleTime: Infinity, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  useEffect(() => {
    if (history.error instanceof ApiError && history.error.status === 401) onUnauthorized();
  }, [history.error, onUnauthorized]);
  return <section className="workspace" aria-label="仓库历史回放">
    <h1>{name} · 历史回放</h1>
    <p><strong>回放 · 只读</strong>。画面只来自归档，不接收实时更新，不执行仓库操作。</p>
    <Link to={`/warehouses/${spaceId}/${warehouseId}`}>返回实时仓库</Link>
    <form className="replay-controls" aria-label="历史范围" onSubmit={(e) => {
      e.preventDefault();
      const start = Date.parse(from), end = Date.parse(to);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 86400000) {
        setFormError('请选择有效时间，范围最多 24 小时。'); return;
      }
      setFormError('');
      const next = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
      if (next.from === range.from && next.to === range.to) void history.refetch();
      else setRange(next);
    }}>
      <label>开始（本机时间） <input type="datetime-local" step="1" required value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>结束（本机时间） <input type="datetime-local" step="1" required value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <button>读取历史</button>
    </form>
    {formError && <p role="alert">{formError}</p>}
    {history.isFetching ? <p role="status">正在读取并校验历史…</p>
      : history.isError ? <div role="alert"><p>历史数据不完整或不可读；未恢复库存与位置。</p><p>{history.error.message}</p>
        <button type="button" onClick={() => { void history.refetch(); }}>重试历史</button></div>
      : history.data ? <ReplayPlayer key={history.dataUpdatedAt + range.from} data={history.data} />
      : <p role="status">所选范围没有可回放的已归档轨迹。</p>}
  </section>;
}
