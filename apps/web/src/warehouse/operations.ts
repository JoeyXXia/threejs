import { useQuery } from '@tanstack/react-query';
import { operationsSchema, type WarehouseSnapshot } from '@warehouse-twin/contracts';
import { api } from '../api';

export type HeatMode = 'off' | 'inventory' | 'wait';
export type HeatCell = { x: number; z: number; value: number };
export const heatLegend = {
  inventory: [
    { max: 9, label: '1–9 件', color: '#99dbce' },
    { max: 29, label: '10–29 件', color: '#298d83' },
    { max: Infinity, label: '≥30 件', color: '#084d49' },
  ],
  wait: [
    { max: 1000, label: '>0–1 秒', color: '#ffdf75' },
    { max: 5000, label: '>1–5 秒', color: '#e97e26' },
    { max: Infinity, label: '>5 秒', color: '#a22e20' },
  ],
} as const;

export function heatColor(mode: Exclude<HeatMode, 'off'>, value: number) {
  return heatLegend[mode].find((entry) => value <= entry.max)!.color;
}

export function inventoryHeat({ layout, inventory }: WarehouseSnapshot): HeatCell[] {
  const counts = new Map(inventory.locationTotals.map((total) => [total.locationId, total.onHand]));
  const cells = new Map<string, HeatCell>();
  for (const { id, grid: { x, z } } of layout.locations) {
    const quantity = counts.get(id) ?? 0;
    if (quantity === 0) continue;
    const key = `${x}:${z}`;
    cells.set(key, { x, z, value: quantity + (cells.get(key)?.value ?? 0) });
  }
  return [...cells.values()];
}

export function completionRate(completed: number, cancelled: number): number | null {
  return completed + cancelled > 0 ? completed / (completed + cancelled) : null;
}

export function useOperations(userId: string, spaceId: string, warehouseId: string, enabled: boolean) {
  return useQuery({ queryKey: ['warehouse-operations', userId, spaceId, warehouseId], enabled, gcTime: 0, retry: false,
    refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const data = operationsSchema.parse(await api(`/spaces/${spaceId}/warehouses/${warehouseId}/operations`, 'GET', undefined, signal));
      if (data.spaceId !== spaceId || data.warehouseId !== warehouseId) throw new Error('运营指标仓库归属不一致');
      return data;
    },
  });
}
