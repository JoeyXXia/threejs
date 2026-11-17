import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fleetResponseSchema } from '@warehouse-twin/contracts';
import { api, ApiError } from '../api';
import { outboundKey } from '../outbound/data';
import { refreshWarehouseViews } from './sync';

export const fleetKey = (userId: string, spaceId: string, warehouseId: string) => ['fleet', userId, spaceId, warehouseId] as const;
export const fleetPath = (spaceId: string, warehouseId: string) => `/spaces/${spaceId}/warehouses/${warehouseId}/fleet`;
export function useFleet(userId: string, spaceId: string, warehouseId: string, onUnauthorized: () => void) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: fleetKey(userId, spaceId, warehouseId), gcTime: 0, retry: false, refetchInterval: 250,
    queryFn: async ({ signal }) => {
      const data = fleetResponseSchema.parse(await api(fleetPath(spaceId, warehouseId), 'GET', undefined, signal));
      if (data.spaceId !== spaceId || data.warehouseId !== warehouseId) throw new Error('车队快照归属错误');
      return data;
    } });
  const phases = query.data?.robots.map((r) => `${r.taskId}:${r.phase}:${r.carrying}`).join('|');
  useEffect(() => { if (query.error instanceof ApiError && query.error.status === 401) onUnauthorized(); }, [query.error, onUnauthorized]);
  useEffect(() => { if (phases) void refreshWarehouseViews(client, userId, spaceId, warehouseId, outboundKey(userId, spaceId, warehouseId)); }, [phases, client, userId, spaceId, warehouseId]);
  return query;
}
