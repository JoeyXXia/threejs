import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { realtimeAckSchema, realtimeBatchSchema, warehouseSocketPath } from '@warehouse-twin/contracts';
import { outboundKey } from '../outbound/data';
import { refreshWarehouseViews } from './sync';

type Scope = { userId: string; spaceId: string; warehouseId: string; onUnauthorized: () => void };
type State = { status: 'connecting' | 'connected' | 'fallback'; after?: number };

export function RealtimeStatus({ userId, spaceId, warehouseId, onUnauthorized }: Scope) {
  const client = useQueryClient();
  const [state, setState] = useState<State>({ status: 'connecting' });
  useEffect(() => {
    const socket = io({ path: warehouseSocketPath, transports: ['websocket'], autoConnect: false, forceNew: true });
    let after: number | undefined;
    let subscribed = false;
    let stopped = false;
    let refresh: number | undefined;
    const invalidate = () => {
      if (refresh !== undefined) return;
      refresh = window.setTimeout(() => {
        refresh = undefined;
        void refreshWarehouseViews(client, userId, spaceId, warehouseId, outboundKey(userId, spaceId, warehouseId));
      }, 80);
    };
    const fallback = () => { subscribed = false; if (!stopped) setState({ status: 'fallback' }); };
    socket.on('connect', () => {
      const id = socket.id;
      const requestedAfter = after;
      socket.timeout(5000).emit('warehouse:subscribe', { spaceId, warehouseId, after: requestedAfter }, (error: unknown, value: unknown) => {
        if (stopped || !socket.connected || socket.id !== id) return;
        const result = realtimeAckSchema.safeParse(value);
        if (error || !result.success || !result.data.ok || (requestedAfter !== undefined && result.data.after !== requestedAfter)) {
          if (result.success && !result.data.ok && result.data.code === 'UNAUTHORIZED') onUnauthorized();
          fallback(); socket.disconnect(); return;
        }
        after = result.data.after;
        subscribed = true;
        setState({ status: 'connected', after });
        invalidate(); // Refresh around the initial subscription boundary; HTTP remains authoritative.
      });
    });
    socket.on('connect_error', (error) => { if (error.message === 'UNAUTHORIZED') onUnauthorized(); fallback(); });
    socket.on('disconnect', fallback);
    socket.on('warehouse:events', (value: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      if (stopped || !subscribed || after === undefined) { ack(false); return; }
      const batch = realtimeBatchSchema.safeParse(value);
      const previous = after;
      if (!batch.success || batch.data.spaceId !== spaceId || batch.data.warehouseId !== warehouseId
        || batch.data.events.some((event, index) => event.seq !== previous + index + 1)) {
        fallback(); ack(false); return;
      }
      after = batch.data.events.at(-1)!.seq;
      setState({ status: 'connected', after });
      ack(true);
      // Position is still rendered from the existing HTTP queries. Refresh warehouse
      // views for committed business changes, not every animation tick.
      if (batch.data.events.some((e) => e.kind !== 'FLEET_TICK' && e.kind !== 'SIM_TICK')) invalidate();
    });
    socket.connect();
    return () => { stopped = true; window.clearTimeout(refresh); socket.removeAllListeners(); socket.disconnect(); };
  }, [client, onUnauthorized, spaceId, userId, warehouseId]);

  return <p className="view-note" data-testid="warehouse-realtime" data-status={state.status} data-after={state.after}>
    {state.status === 'connected' ? `实时事件已连接 · seq ${state.after}`
      : state.status === 'connecting' ? '正在订阅仓库事件…' : '实时事件未连接 · 仍可通过 HTTP 读取或刷新'}
  </p>;
}
