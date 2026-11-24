import { useEffect, useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { realtimeAckSchema, realtimeBatchSchema, realtimeSnapshotSchema, validateSnapshot, warehouseEventsSchema, warehouseSocketPath } from '@warehouse-twin/contracts';
import type { RealtimeSnapshot } from '@warehouse-twin/contracts';
import { api, ApiError } from '../api';
import { EventCursor, acceptsSnapshot } from './realtime-sync';

type Status = 'syncing' | 'connected' | 'offline' | 'stale' | 'denied';
type Scope = { userId: string; spaceId: string; warehouseId: string; onUnauthorized: () => void };
export const realtimeKey = (userId: string, spaceId: string, warehouseId: string) =>
  ['warehouse-realtime-snapshot', userId, spaceId, warehouseId] as const;

export function useRealtimeSnapshot({ userId, spaceId, warehouseId, onUnauthorized }: Scope) {
  const client = useQueryClient();
  const [status, setStatus] = useState<Status>('syncing');
  const [error, setError] = useState<Error | null>(null);
  const retry = useRef(() => {});
  const key = realtimeKey(userId, spaceId, warehouseId);
  const query = useQuery<RealtimeSnapshot>({ queryKey: key, queryFn: skipToken, gcTime: 0 });

  useEffect(() => {
    const key = realtimeKey(userId, spaceId, warehouseId);
    const path = `/spaces/${spaceId}/warehouses/${warehouseId}`;
    const socket = io({ path: warehouseSocketPath, transports: ['websocket'], autoConnect: false, forceNew: true });
    let controller = new AbortController();
    let cursor: EventCursor | undefined;
    let busy = false, force = false, stopped = false, denied = false;
    let reconnect: number | undefined;
    const current = () => client.getQueryData<RealtimeSnapshot>(key);
    function stopGeneration() {
      controller.abort(); controller = new AbortController(); cursor = undefined; busy = false; force = false;
    }
    function refuse(unauthorized: boolean) {
      denied = true; window.clearTimeout(reconnect); stopGeneration(); socket.disconnect();
      client.setQueryData(key, null);
      setStatus('denied'); setError(new Error('当前会话没有仓库读取权限。'));
      if (unauthorized) onUnauthorized();
    }
    function reconnectFresh() {
      stopGeneration(); socket.disconnect();
      // Old and replacement databases can reuse numbers; do not mix their generations.
      client.setQueryData(key, null);
      setStatus('syncing'); setError(null);
      if (!stopped && !denied && navigator.onLine) socket.connect();
    }
    async function pump() {
      if (!cursor || busy || stopped || denied) return;
      if (!force && !cursor.hasGap && (current()?.watermark ?? -1) >= cursor.after) return;
      const queue = cursor, { signal } = controller;
      busy = true;
      let success = false;
      let readingHistory = false;
      try {
        // HTTP history only fills missing notifications. Actual balances and poses are
        // always replaced together by a server-side consistent snapshot.
        for (let pages = 0; queue.hasGap && pages < 3; pages++) {
          const after = queue.after;
          readingHistory = true;
          const page = warehouseEventsSchema.parse(await api(path + '/simulation/events?after=' + after, 'GET', undefined, signal));
          readingHistory = false;
          signal.throwIfAborted();
          if (page.spaceId !== spaceId || page.warehouseId !== warehouseId || page.after !== after) throw new Error('事件补发归属不一致。');
          if (!queue.ingest(page.events)) { reconnectFresh(); return; }
          if (queue.hasGap && queue.after === after) throw new Error('事件缺口未补齐，请重试同步。');
        }
        if (queue.hasGap) { reconnectFresh(); return; }
        const minimum = queue.after;
        force = false;
        const snapshot = realtimeSnapshotSchema.parse(await api(path + '/snapshot', 'GET', undefined, signal));
        signal.throwIfAborted();
        validateSnapshot(snapshot.layout, snapshot.inventory, spaceId, warehouseId);
        if (!acceptsSnapshot(current(), snapshot, minimum)) throw new Error('收到较旧快照，已保留最后确认状态。');
        client.setQueryData(key, snapshot);
        queue.cover(snapshot.watermark);
        setError(null);
        setStatus(queue.hasGap ? 'syncing' : 'connected');
        success = true;
      } catch (reason) {
        if (signal.aborted) return;
        if (reason instanceof ApiError) {
          if (reason.status === 401 || reason.status === 403 || reason.status === 404) { refuse(reason.status === 401); return; }
          if (readingHistory && (reason.status === 409 || reason.status === 410)) { reconnectFresh(); return; }
        }
        setError(reason instanceof ApiError ? reason : new Error('无法同步仓库，已保留最后确认状态。'));
        setStatus(navigator.onLine ? 'stale' : 'offline');
      } finally {
        if (!signal.aborted) {
          busy = false;
          if (success) void pump();
        }
      }
    }
    socket.on('connect', () => {
      stopGeneration();
      const { signal } = controller;
      const after = current()?.watermark;
      setStatus('syncing'); setError(null);
      socket.timeout(5000).emit('warehouse:subscribe', { spaceId, warehouseId, after }, (failure: unknown, value: unknown) => {
        if (signal.aborted || stopped) return;
        const ack = realtimeAckSchema.safeParse(value);
        if (!failure && ack.success && ack.data.ok && (after === undefined || after === ack.data.after)) {
          cursor = new EventCursor(ack.data.after); force = true; void pump(); return;
        }
        if (ack.success && !ack.data.ok) {
          if (ack.data.code === 'UNAUTHORIZED' || ack.data.code === 'NOT_FOUND') { refuse(ack.data.code === 'UNAUTHORIZED'); return; }
          if (ack.data.code === 'CURSOR_AHEAD' || ack.data.code === 'CURSOR_EXPIRED') { reconnectFresh(); return; }
        }
        setStatus('stale'); setError(new Error('无法订阅仓库，可重试同步。'));
      });
    });
    socket.on('warehouse:events', (value: unknown, reply: unknown) => {
      if (typeof reply !== 'function') return;
      const batch = realtimeBatchSchema.safeParse(value);
      if (!cursor || !batch.success || batch.data.spaceId !== spaceId || batch.data.warehouseId !== warehouseId) { reply(false); return; }
      const bounded = cursor.ingest(batch.data.events);
      reply(true);
      if (!bounded) { reconnectFresh(); return; }
      if (cursor.hasGap) setStatus('syncing');
      void pump();
    });
    socket.on('warehouse:reset', reconnectFresh);
    socket.on('warehouse:revoked', (code: number) => refuse(code === 401));
    socket.on('connect_error', (failure) => {
      if (failure.message === 'UNAUTHORIZED') refuse(true);
      else if (!denied) setStatus('offline');
    });
    socket.on('disconnect', (reason) => {
      stopGeneration();
      if (stopped || denied) return;
      setStatus('offline');
      if (reason === 'io server disconnect' && navigator.onLine) reconnect = window.setTimeout(() => socket.connect(), 750);
    });
    const offline = () => { window.clearTimeout(reconnect); socket.disconnect(); if (!denied) setStatus('offline'); };
    const online = () => { if (!denied && !stopped) { setStatus('syncing'); socket.connect(); } };
    retry.current = () => {
      if (denied) return;
      if (cursor && socket.connected) { force = true; setStatus('syncing'); void pump(); }
      else { socket.disconnect(); online(); }
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    if (navigator.onLine) socket.connect(); else offline();
    return () => {
      stopped = true; stopGeneration(); window.clearTimeout(reconnect);
      window.removeEventListener('offline', offline); window.removeEventListener('online', online);
      socket.removeAllListeners(); socket.disconnect(); retry.current = () => {};
    };
  }, [client, onUnauthorized, spaceId, userId, warehouseId]);

  return { data: query.data ?? undefined, updatedAt: query.dataUpdatedAt, status, error, retry: () => retry.current() };
}
