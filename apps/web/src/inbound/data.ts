import { inboundListSchema, inboundOrderSchema } from '@warehouse-twin/contracts';
import { api } from '../api';

export const inboundKey = (userId: string, spaceId: string, warehouseId: string) => ['inbound-orders', userId, spaceId, warehouseId] as const;
export const inboundPath = (spaceId: string, warehouseId: string) => `/spaces/${encodeURIComponent(spaceId)}/warehouses/${encodeURIComponent(warehouseId)}/inbound-orders`;
export async function loadInbound(spaceId: string, warehouseId: string, signal: AbortSignal) {
  const value = inboundListSchema.parse(await api(inboundPath(spaceId, warehouseId), 'GET', undefined, signal));
  if (value.spaceId !== spaceId || value.warehouseId !== warehouseId) throw new Error('入库单响应归属不一致');
  return value;
}
// Keep the same key for an unchanged command after a timeout/lost response.
export function commandAttempts(newKey: () => string = () => crypto.randomUUID()) {
  let pending: { fingerprint: string; key: string } | null = null;
  return {
    forRequest: (path: string, payload: object) => {
      const fingerprint = JSON.stringify({ path, payload });
      if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, key: newKey() };
      return pending.key;
    },
    completed: () => { pending = null; },
  };
}
export async function sendInbound(path: string, body: object, spaceId: string, warehouseId: string, signal: AbortSignal) {
  const value = inboundOrderSchema.parse(await api(path, 'POST', body, signal));
  if (value.spaceId !== spaceId || value.warehouseId !== warehouseId) throw new Error('入库操作响应归属不一致');
  return value;
}
