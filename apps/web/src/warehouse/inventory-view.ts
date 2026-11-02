import type { WarehouseSnapshot, ZoneKind } from '@warehouse-twin/contracts';

export const inventoryAppearance = {
  EMPTY: { name: '空位', color: '#a9bcb7' }, AVAILABLE: { name: '可用', color: '#398572' },
  RESERVED: { name: '预占', color: '#3e77b0' }, HOLD: { name: '待检', color: '#bb862b' },
  UNAVAILABLE: { name: '不可分配', color: '#9b718d' },
} as const;
export type InventoryStatus = keyof typeof inventoryAppearance;
export type ZoneFilter = ZoneKind | 'ALL';

export function locationViews(snapshot: WarehouseSnapshot, filter: ZoneFilter = 'ALL') {
  const totals = new Map(snapshot.inventory.locationTotals.map((row) => [row.locationId, row]));
  return snapshot.layout.locations.filter((location) => filter === 'ALL' || location.kind === filter).map((location) => {
    const total = totals.get(location.id);
    if (!total) throw new Error('Missing location inventory');
    const balances = snapshot.inventory.balances.filter((balance) => balance.locationId === location.id);
    const hold = balances.filter((row) => row.quality === 'HOLD').reduce((sum, row) => sum + row.onHand, 0);
    const status: InventoryStatus = total.onHand === 0 ? 'EMPTY' : hold > 0 ? 'HOLD'
      : total.reserved > 0 ? 'RESERVED' : total.available > 0 ? 'AVAILABLE' : 'UNAVAILABLE';
    return { location, total, balances, hold, status };
  });
}
export type LocationView = ReturnType<typeof locationViews>[number];

export function findLocations(snapshot: WarehouseSnapshot, input: string) {
  const term = input.trim().toLowerCase();
  if (!term) return [];
  const exact = snapshot.layout.locations.filter((location) => location.id.toLowerCase() === term || location.code.toLowerCase() === term);
  return exact.length ? exact : snapshot.layout.locations.filter((location) => location.code.toLowerCase().includes(term));
}
