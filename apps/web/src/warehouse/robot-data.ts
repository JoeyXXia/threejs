import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { simulationResponseSchema } from '@warehouse-twin/contracts';
import { api, ApiError } from '../api';
import { outboundKey } from '../outbound/data';
import { refreshWarehouseViews } from './sync';

export const simulationKey = (userId: string, spaceId: string, warehouseId: string) => ['simulation', userId, spaceId, warehouseId] as const;
export const simulationPath = (spaceId: string, warehouseId: string) => `/spaces/${encodeURIComponent(spaceId)}/warehouses/${encodeURIComponent(warehouseId)}/simulation`;

export function useSimulation(userId: string, spaceId: string, warehouseId: string, onUnauthorized: () => void) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: simulationKey(userId, spaceId, warehouseId),
    queryFn: async ({ signal }) => {
      const data = simulationResponseSchema.parse(await api(simulationPath(spaceId, warehouseId), 'GET', undefined, signal));
      if (data.spaceId !== spaceId || data.warehouseId !== warehouseId) throw new Error('机器人状态仓库归属错误');
      return data;
    }, refetchInterval: 250, refetchIntervalInBackground: false, retry: false, gcTime: 0,
  });
  const phase = query.data?.runtime?.phase;
  const taskId = query.data?.runtime?.taskId;
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) onUnauthorized();
  }, [query.error, onUnauthorized]);
  useEffect(() => {
    if (phase) void refreshWarehouseViews(client, userId, spaceId, warehouseId, outboundKey(userId, spaceId, warehouseId));
  }, [phase, taskId, client, userId, spaceId, warehouseId]);
  return query;
}
