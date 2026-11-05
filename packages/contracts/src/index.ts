import { z } from 'zod';

const id = z.string().uuid();
const quantity = z.number().int().nonnegative();
const point = z.object({ x: quantity, z: quantity });
const kind = z.enum(['INBOUND', 'QC', 'STORAGE', 'PICKING', 'OUTBOUND', 'CHARGING']);
const rect = { gridX: quantity, gridZ: quantity, sizeX: z.number().int().positive(), sizeZ: z.number().int().positive() };
const totals = { onHand: quantity, reserved: quantity, available: quantity };

export const layoutSchema = z.object({
  spaceId: id, warehouseId: id,
  layoutVersion: z.object({ id, version: z.number().int().positive(), width: z.number().int().positive(), depth: z.number().int().positive(),
    cellSize: z.number().positive().finite(), origin: z.object({ x: z.number().finite(), z: z.number().finite() }) }),
  zones: z.array(z.object({ id, code: z.string(), kind, ...rect })),
  racks: z.array(z.object({ id, code: z.string(), zoneId: id, ...rect, levels: z.number().int().positive(), levelHeight: z.number().positive().finite() })),
  locations: z.array(z.object({ id, code: z.string(), kind, zoneId: id, rackId: id.nullable(),
    grid: point.extend({ level: quantity }), capacity: z.number().int().positive(), serviceCell: point })),
  blockedCells: z.array(point),
}).superRefine((data, ctx) => {
  const { width, depth } = data.layoutVersion;
  const inside = (p: { x: number; z: number }) => p.x < width && p.z < depth;
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Invalid layout relationships or bounds' });
  const zones = new Set(data.zones.map((zone) => zone.id));
  const racks = new Set(data.racks.map((rack) => rack.id));
  if (zones.size !== data.zones.length || racks.size !== data.racks.length
    || new Set(data.locations.map((location) => location.id)).size !== data.locations.length) fail();
  if ([...data.zones, ...data.racks].some((r) => r.gridX + r.sizeX > width || r.gridZ + r.sizeZ > depth)) fail();
  if (data.racks.some((rack) => !zones.has(rack.zoneId)) || data.blockedCells.some((p) => !inside(p))) fail();
  if (data.locations.some((location) => !inside(location.grid) || !inside(location.serviceCell) || !zones.has(location.zoneId)
    || (location.rackId !== null && !racks.has(location.rackId)))) fail();
});

export const inventorySchema = z.object({
  spaceId: id, warehouseId: id, layoutId: id, layoutVersion: z.number().int().positive(), asOf: z.string().datetime(),
  balances: z.array(z.object({ id, locationId: id, quality: z.enum(['HOLD', 'RELEASED']), ...totals, version: quantity,
    sku: z.object({ id, code: z.string(), name: z.string(), unit: z.literal('piece') }),
    batch: z.object({ id, code: z.string(), expiresAt: z.string().datetime().nullable() }) })),
  locationTotals: z.array(z.object({ locationId: id, code: z.string(), capacity: z.number().int().positive(), ...totals })),
  summary: z.object({ ...totals, hold: quantity }),
}).superRefine((data, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Inventory quantities do not reconcile' });
  if (new Set(data.balances.map((balance) => balance.id)).size !== data.balances.length
    || new Set(data.locationTotals.map((location) => location.locationId)).size !== data.locationTotals.length) fail();
  for (const balance of data.balances) {
    const expected = balance.quality === 'RELEASED' && (!balance.batch.expiresAt || Date.parse(balance.batch.expiresAt) > Date.parse(data.asOf))
      ? balance.onHand - balance.reserved : 0;
    if (balance.reserved > balance.onHand || balance.available !== expected) fail();
  }
  for (const key of ['onHand', 'reserved', 'available'] as const) {
    if (data.summary[key] !== data.balances.reduce((sum, row) => sum + row[key], 0)) fail();
    for (const location of data.locationTotals) {
      if (location[key] !== data.balances.filter((row) => row.locationId === location.locationId).reduce((sum, row) => sum + row[key], 0)) fail();
    }
  }
  if (data.summary.hold !== data.balances.filter((row) => row.quality === 'HOLD').reduce((sum, row) => sum + row.onHand, 0)
    || data.locationTotals.some((row) => row.onHand > row.capacity)) fail();
});

export type LayoutResponse = z.infer<typeof layoutSchema>;
export type InventoryResponse = z.infer<typeof inventorySchema>;
export type WarehouseSnapshot = { layout: LayoutResponse; inventory: InventoryResponse };
export type ZoneKind = z.infer<typeof kind>;

const timestamp = z.string().datetime();
export const createInboundSchema = z.object({
  key: z.string().trim().min(8).max(100), skuId: id, batchCode: z.string().trim().min(1).max(80),
  qcLocationId: id, quantity: z.number().int().positive().max(1000000),
  producedAt: timestamp.nullable(), expiresAt: timestamp.nullable(), reason: z.string().trim().min(1).max(200),
}).strict().refine((value) => !value.producedAt || !value.expiresAt || Date.parse(value.producedAt) < Date.parse(value.expiresAt), { message: '生产日期必须早于到期时间' });
export type CreateInboundInput = z.infer<typeof createInboundSchema>;
export const inboundOrderSchema = z.object({
  id, spaceId: id, warehouseId: id, skuId: id, skuCode: z.string(), batchId: id, batchCode: z.string(),
  qcLocationId: id, qcCode: z.string(), quantity: z.number().int().positive(),
  status: z.enum(['CREATED', 'RECEIVED', 'PASSED', 'REJECTED']), version: quantity,
  producedAt: timestamp.nullable(), expiresAt: timestamp.nullable(),
  createdById: id, receivedById: id.nullable(), inspectedById: id.nullable(),
  reason: z.string(), receiptReason: z.string().nullable(), inspectionReason: z.string().nullable(),
  createdAt: timestamp, receivedAt: timestamp.nullable(), inspectedAt: timestamp.nullable(),
});
export type InboundOrderResponse = z.infer<typeof inboundOrderSchema>;
export const inboundListSchema = z.object({
  spaceId: id, warehouseId: id, role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']),
  skus: z.array(z.object({ id, code: z.string() })), qcLocations: z.array(z.object({ id, code: z.string() })),
  orders: z.array(inboundOrderSchema), hasMore: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.orders.some((row) => row.spaceId !== value.spaceId || row.warehouseId !== value.warehouseId)) ctx.addIssue({ code: 'custom', message: 'Order scope mismatch' });
});
export type InboundListResponse = z.infer<typeof inboundListSchema>;

export function validateSnapshot(layout: LayoutResponse, inventory: InventoryResponse, spaceId: string, warehouseId: string): WarehouseSnapshot {
  if (layout.spaceId !== spaceId || inventory.spaceId !== spaceId || layout.warehouseId !== warehouseId || inventory.warehouseId !== warehouseId) {
    throw new Error('Warehouse scope mismatch');
  }
  if (layout.layoutVersion.id !== inventory.layoutId || layout.layoutVersion.version !== inventory.layoutVersion) throw new Error('Layout version mismatch');
  const locations = new Map(layout.locations.map((location) => [location.id, location]));
  if (inventory.locationTotals.length !== locations.size || inventory.locationTotals.some((row) => locations.get(row.locationId)?.capacity !== row.capacity)
    || inventory.balances.some((row) => !locations.has(row.locationId))) throw new Error('Inventory location mismatch');
  return { layout, inventory };
}
