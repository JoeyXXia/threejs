import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { outboundKey } from '../outbound/data';
import { warehouseKey } from './data';

export const wmsKey = (userId: string, spaceId: string, warehouseId: string) =>
  ['wms', userId, spaceId, warehouseId] as const;
export const reconciliationKey = (userId: string, spaceId: string, warehouseId: string) =>
  ['wms-reconciliation', userId, spaceId, warehouseId] as const;

export async function refreshWarehouseViews(client: QueryClient, userId: string, spaceId: string, warehouseId: string,
  orderList: QueryKey, changesEligibility = false) {
  const keys = [orderList, warehouseKey(userId, spaceId, warehouseId), reconciliationKey(userId, spaceId, warehouseId)];
  if (changesEligibility) keys.push(outboundKey(userId, spaceId, warehouseId));
  await Promise.all([
    ...keys.map((queryKey) => client.invalidateQueries({ queryKey, exact: true })),
    client.invalidateQueries({ queryKey: wmsKey(userId, spaceId, warehouseId) }),
  ]);
}
