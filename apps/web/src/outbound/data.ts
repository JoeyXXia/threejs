import { outboundListSchema, outboundOrderSchema } from '@warehouse-twin/contracts';
import { api } from '../api';
export { commandAttempts } from '../inbound/data';

export const outboundKey = (userId: string, spaceId: string, warehouseId: string) => ['outbound-orders', userId, spaceId, warehouseId] as const;
export const outboundPath = (spaceId: string, warehouseId: string) => `/spaces/${encodeURIComponent(spaceId)}/warehouses/${encodeURIComponent(warehouseId)}/outbound-orders`;
export async function loadOutbound(spaceId: string, warehouseId: string, signal: AbortSignal) {
  const result = outboundListSchema.parse(await api(outboundPath(spaceId, warehouseId), 'GET', undefined, signal));
  if (result.spaceId !== spaceId || result.warehouseId !== warehouseId) throw new Error('出库单响应归属不一致');
  return result;
}
export async function sendOutbound(path: string, payload: object, spaceId: string, warehouseId: string, signal: AbortSignal) {
  const result = outboundOrderSchema.parse(await api(path, 'POST', payload, signal));
  if (result.spaceId !== spaceId || result.warehouseId !== warehouseId) throw new Error('出库操作响应归属不一致');
  return result;
}
