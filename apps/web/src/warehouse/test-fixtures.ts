import type { WarehouseSnapshot } from '@warehouse-twin/contracts';

export const fixtureId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export function fixtureSnapshot(): WarehouseSnapshot {
  return {
    layout: {
      spaceId: fixtureId(1), warehouseId: fixtureId(2),
      layoutVersion: { id: fixtureId(3), version: 1, width: 10, depth: 8, cellSize: 1, origin: { x: 0, z: 0 } },
      zones: [{ id: fixtureId(4), code: 'ST', kind: 'STORAGE', gridX: 1, gridZ: 0, sizeX: 5, sizeZ: 5 }],
      racks: [{ id: fixtureId(5), zoneId: fixtureId(4), code: 'R', gridX: 2, gridZ: 1, sizeX: 1, sizeZ: 2, levels: 1, levelHeight: 1.5 }],
      locations: [6, 7].map((id, index) => ({ id: fixtureId(id), code: `L${index + 1}`, kind: 'STORAGE', zoneId: fixtureId(4), rackId: fixtureId(5),
        grid: { x: 2, z: 1 + index, level: 0 }, capacity: 40, serviceCell: { x: 1, z: 1 + index } })),
      blockedCells: [{ x: 2, z: 1 }, { x: 2, z: 2 }],
    },
    inventory: {
      spaceId: fixtureId(1), warehouseId: fixtureId(2), layoutId: fixtureId(3), layoutVersion: 1, asOf: '2026-11-02T00:00:00.000Z',
      balances: [{ id: fixtureId(8), locationId: fixtureId(6), quality: 'RELEASED', onHand: 5, reserved: 0, available: 5, version: 0,
        sku: { id: fixtureId(9), code: 'SKU', name: 'fixture', unit: 'piece' }, batch: { id: fixtureId(10), code: 'B', expiresAt: '2030-01-01T00:00:00.000Z' } }],
      locationTotals: [6, 7].map((id, index) => ({ locationId: fixtureId(id), code: `L${index + 1}`, capacity: 40, onHand: index ? 0 : 5, reserved: 0, available: index ? 0 : 5 })),
      summary: { onHand: 5, reserved: 0, available: 5, hold: 0 },
    },
  };
}
