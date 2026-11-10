import type { WarehouseSnapshot, ZoneKind } from '@warehouse-twin/contracts';

export const inventoryAppearance = {
  EMPTY: { name: '空位', color: '#a9bcb7' }, AVAILABLE: { name: '可用', color: '#398572' },
  RESERVED: { name: '预占', color: '#3e77b0' }, HOLD: { name: '待检', color: '#bb862b' },
  UNAVAILABLE: { name: '不可分配', color: '#9b718d' },
} as const;
export type InventoryStatus = keyof typeof inventoryAppearance;
export type ZoneFilter = ZoneKind | 'ALL';
export type InventoryWarning = 'HOLD' | 'EXPIRED' | 'EXPIRING';

export function locationViews(snapshot: WarehouseSnapshot, filter: ZoneFilter = 'ALL', batchId = '') {
  const totals = new Map(snapshot.inventory.locationTotals.map((row) => [row.locationId, row]));
  return snapshot.layout.locations.filter((location) => filter === 'ALL' || location.kind === filter).flatMap((location) => {
    const full = totals.get(location.id);
    if (!full) throw new Error('Missing location inventory');
    const balances = snapshot.inventory.balances.filter((balance) => balance.locationId === location.id
      && (!batchId || (balance.batch.id === batchId && balance.onHand > 0)));
    if (batchId && balances.length === 0) return [];
    const total = batchId ? balances.reduce((sum, row) => ({
      ...sum, onHand: sum.onHand + row.onHand, reserved: sum.reserved + row.reserved, available: sum.available + row.available,
    }), { ...full, onHand: 0, reserved: 0, available: 0 }) : full;
    const hold = balances.filter((row) => row.quality === 'HOLD').reduce((sum, row) => sum + row.onHand, 0);
    const status: InventoryStatus = total.onHand === 0 ? 'EMPTY' : hold > 0 ? 'HOLD'
      : total.reserved > 0 ? 'RESERVED' : total.available > 0 ? 'AVAILABLE' : 'UNAVAILABLE';
    return [{ location, total, balances, hold, status }];
  });
}
export type LocationView = ReturnType<typeof locationViews>[number];

export function warningLocation(snapshot: WarehouseSnapshot, batchId: string, warning: InventoryWarning) {
  const now = Date.parse(snapshot.inventory.asOf);
  return locationViews(snapshot, 'ALL', batchId)
    .filter((view) => view.balances.some((row) => {
      if (warning === 'HOLD') return row.quality === 'HOLD';
      if (!row.batch.expiresAt) return false;
      const expiry = Date.parse(row.batch.expiresAt);
      return warning === 'EXPIRED' ? expiry <= now : expiry > now && expiry <= now + 7 * 24 * 60 * 60 * 1000;
    }))
    .sort((a, b) => a.location.code.localeCompare(b.location.code))[0]?.location;
}

export function findLocations(snapshot: WarehouseSnapshot, input: string) {
  const term = input.trim().toLowerCase();
  if (!term) return [];
  const exact = snapshot.layout.locations.filter((location) => location.id.toLowerCase() === term || location.code.toLowerCase() === term);
  return exact.length ? exact : snapshot.layout.locations.filter((location) => location.code.toLowerCase().includes(term));
}
