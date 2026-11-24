import { z } from 'zod';

const id = z.string().uuid();
const quantity = z.number().int().nonnegative();
const point = z.object({ x: quantity, z: quantity });
const kind = z.enum(['INBOUND', 'QC', 'STORAGE', 'PICKING', 'OUTBOUND', 'CHARGING']);
const rect = { gridX: quantity, gridZ: quantity, sizeX: z.number().int().positive(), sizeZ: z.number().int().positive() };
const totals = { onHand: quantity, reserved: quantity, available: quantity };

export const warehouseSocketPath = '/socket.io';
const eventCursor = quantity.max(2147483647);
const realtimeScope = { spaceId: id, warehouseId: id };
export const realtimeSubscribeSchema = z.strictObject({ ...realtimeScope, after: eventCursor.optional() });
export const realtimeAckSchema = z.union([
  z.object({ ok: z.literal(true), after: eventCursor }),
  z.object({ ok: z.literal(false), code: z.enum(['BAD_REQUEST', 'UNAUTHORIZED', 'NOT_FOUND', 'CURSOR_AHEAD', 'CURSOR_EXPIRED', 'BUSY', 'UNAVAILABLE']) }),
]);
const warehouseEvent = z.object({
  seq: eventCursor.positive(), version: eventCursor.nullable(), epoch: eventCursor.nullable(), tick: eventCursor,
  kind: z.string(), payload: z.unknown(), createdAt: z.string().datetime(),
});
export const realtimeBatchSchema = z.object({
  ...realtimeScope,
  events: z.array(warehouseEvent).min(1).max(100),
});
export type RealtimeAck = z.infer<typeof realtimeAckSchema>;

export const movementKindSchema = z.enum(['OPENING', 'RECEIPT', 'TRANSFER', 'DISPATCH', 'COUNT_ADJUSTMENT']);
const wmsScope = { spaceId: id, warehouseId: id, asOf: z.string().datetime() };
const wmsBatch = z.object({ id, code: z.string(), skuCode: z.string(), expiresAt: z.string().datetime().nullable() });
const wmsEndpoint = z.object({ code: z.string(), quality: z.enum(['HOLD', 'RELEASED']) }).nullable();
export const wmsSchema = z.object({
  ...wmsScope,
  batches: z.array(wmsBatch),
  batch: wmsBatch.extend({
    producedAt: z.string().datetime().nullable(),
    balances: z.array(z.object({
      id, locationCode: z.string(), quality: z.enum(['HOLD', 'RELEASED']), onHand: quantity, reserved: quantity,
    })),
  }).nullable(),
  warnings: z.array(z.object({
    batch: wmsBatch, type: z.enum(['EXPIRED', 'EXPIRING', 'HOLD']), quantity,
  })),
  movements: z.array(z.object({
    id, kind: movementKindSchema, batch: wmsBatch, source: wmsEndpoint, destination: wmsEndpoint,
    quantity, reason: z.string(), reference: z.string(), createdAt: z.string().datetime(),
  })),
  audits: z.array(z.object({
    id, action: z.string(), actor: z.string(), reason: z.string(), correlationId: z.string().nullable(), createdAt: z.string().datetime(),
  })),
  movementBefore: id.nullable(),
  auditBefore: id.nullable(),
});
const difference = { actual: z.string(), expected: z.string() };
export const wmsReconciliationSchema = z.object({
  ...wmsScope,
  consistent: z.boolean(),
  mismatches: z.array(z.object({ locationId: id, skuId: id, batchId: id, quality: z.string(), ...difference })),
  reservationMismatches: z.array(z.object({ kind: z.string(), id, ...difference })),
});
export type WmsResponse = z.infer<typeof wmsSchema>;
export type WmsReconciliation = z.infer<typeof wmsReconciliationSchema>;

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
  watermark: quantity,
  spaceId: id, warehouseId: id, layoutId: id, layoutVersion: z.number().int().positive(), asOf: z.string().datetime(),
  balances: z.array(z.object({ id, locationId: id, quality: z.enum(['HOLD', 'RELEASED']), ...totals, version: quantity, transit: z.literal(true).optional(),
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
    if (balance.reserved > balance.onHand || balance.available !== expected
      || (balance.transit && (balance.quality !== 'RELEASED' || balance.onHand <= 0 || balance.reserved !== balance.onHand))) fail();
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
export const countOrderSchema = z.object({
  id, spaceId: id, warehouseId: id, locationId: id, locationCode: z.string(), createdAt: z.string().datetime(),
  status: z.enum(['OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED']), submissionNote: z.string().nullable(),
  lines: z.array(z.object({
    balanceId: id, skuCode: z.string(), batchCode: z.string(), quality: z.enum(['HOLD', 'RELEASED']),
    expected: quantity, balanceVersion: quantity, actual: quantity.nullable(),
  })),
});
export const countListSchema = z.object({
  spaceId: id, warehouseId: id, role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']),
  locations: z.array(z.object({ id, code: z.string(), frozen: z.boolean() })),
  orders: z.array(countOrderSchema),
});
export type CountOrderResponse = z.infer<typeof countOrderSchema>;
export type CountListResponse = z.infer<typeof countListSchema>;
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

export const createOutboundSchema = z.object({
  key: z.string().trim().min(8).max(100), skuId: id, batchId: id,
  quantity: z.number().int().positive().max(1000000), reason: z.string().trim().min(1).max(200),
}).strict();
export type CreateOutboundInput = z.infer<typeof createOutboundSchema>;
export const outboundOrderSchema = z.object({
  id, spaceId: id, warehouseId: id, skuId: id, skuCode: z.string(), batchId: id, batchCode: z.string(),
  expiresAt: timestamp.nullable(), quantity: z.number().int().positive(), status: z.enum(['CREATED', 'ALLOCATED', 'DISPATCHED']), version: quantity,
  reason: z.string(), allocationReason: z.string().nullable(), createdById: id, allocatedById: id.nullable(),
  createdAt: timestamp, allocatedAt: timestamp.nullable(),
  allocations: z.array(z.object({ id, balanceId: id, locationId: id, locationCode: z.string(), quantity: z.number().int().positive() })),
}).superRefine((value, ctx) => {
  if (new Set(value.allocations.map((row) => row.balanceId)).size !== value.allocations.length
    || (value.status === 'CREATED' && (value.allocations.length > 0 || value.allocatedAt !== null || value.allocatedById !== null))
    || (value.status !== 'CREATED' && (value.allocations.reduce((sum, row) => sum + row.quantity, 0) !== value.quantity || value.allocatedAt === null || value.allocatedById === null))) {
    ctx.addIssue({ code: 'custom', message: 'Allocation quantities or phase mismatch' });
  }
});
export type OutboundOrderResponse = z.infer<typeof outboundOrderSchema>;
export const outboundListSchema = z.object({
  spaceId: id, warehouseId: id, role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']), asOf: timestamp,
  skus: z.array(z.object({ id, code: z.string() })),
  recommendations: z.array(z.object({ skuId: id, batchId: id, batchCode: z.string(), expiresAt: timestamp.nullable(), available: z.number().int().positive() })),
  orders: z.array(outboundOrderSchema), hasMore: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.orders.some((row) => row.spaceId !== value.spaceId || row.warehouseId !== value.warehouseId)
    || value.recommendations.some((row) => !value.skus.some((sku) => sku.id === row.skuId) || (row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(value.asOf)))) {
    ctx.addIssue({ code: 'custom', message: 'Outbound scope or recommendation mismatch' });
  }
});
export type OutboundListResponse = z.infer<typeof outboundListSchema>;

export function validateSnapshot(layout: LayoutResponse, inventory: InventoryResponse, spaceId: string, warehouseId: string): WarehouseSnapshot {
  if (layout.spaceId !== spaceId || inventory.spaceId !== spaceId || layout.warehouseId !== warehouseId || inventory.warehouseId !== warehouseId) {
    throw new Error('Warehouse scope mismatch');
  }
  if (layout.layoutVersion.id !== inventory.layoutId || layout.layoutVersion.version !== inventory.layoutVersion) throw new Error('Layout version mismatch');
  const locations = new Map(layout.locations.map((location) => [location.id, location]));
  if (inventory.locationTotals.length !== locations.size || inventory.locationTotals.some((row) => locations.get(row.locationId)?.capacity !== row.capacity)
    || inventory.balances.some((row) => row.transit ? locations.has(row.locationId) : !locations.has(row.locationId))) throw new Error('Inventory location mismatch');
  return { layout, inventory };
}

const robotCell = z.object({ x: z.number().int().min(0).max(511), z: z.number().int().min(0).max(511) });
export const robotSnapshotSchema = z.object({
  taskId: id, kind: z.enum(['OUTBOUND', 'PUTAWAY']).default('OUTBOUND'), inboundOrderId: id.nullable().default(null), allocationId: id.nullable(), layoutId: id, layoutVersion: z.number().int().positive(),
  phase: z.enum(['APPROACH', 'LOADING', 'TRANSPORT', 'UNLOADING', 'COMPLETED', 'ERROR']),
  tick: quantity, logicalTimeMs: quantity, tickMs: z.literal(250),
  from: robotCell, to: robotCell, direction: z.enum(['N', 'E', 'S', 'W']),
  battery: z.number().int().min(0).max(10000), route: z.array(robotCell).min(1).max(65536),
  carrying: z.boolean(), error: z.string().max(200).nullable(),
}).superRefine((value, ctx) => {
  if (value.kind === 'PUTAWAY' ? !value.inboundOrderId || value.allocationId !== null : !value.allocationId || value.inboundOrderId !== null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid robot task identity' });
  }
  if (Math.abs(value.from.x - value.to.x) + Math.abs(value.from.z - value.to.z) > 1
    || value.logicalTimeMs !== value.tick * value.tickMs) ctx.addIssue({ code: 'custom', message: 'Invalid confirmed segment' });
});
export type RobotSnapshot = z.infer<typeof robotSnapshotSchema>;
export const simulationResponseSchema = z.object({
  watermark: quantity, epoch: quantity, stateVersion: quantity,
  spaceId: id, warehouseId: id, role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']), runtime: robotSnapshotSchema.nullable(),
  allocations: z.array(z.object({ id, label: z.string(), quantity: z.number().int().positive() })),
  staging: z.array(z.object({ id, code: z.string() })),
  putawayReceipts: z.array(z.object({ id, label: z.string(), quantity: z.number().int().positive() })).default([]),
  storage: z.array(z.object({ id, code: z.string() })).default([]),
});
export type SimulationResponse = z.infer<typeof simulationResponseSchema>;

const simulationStateSchema = z.object({
  schemaVersion: z.literal(1), seed: quantity.max(0xffffffff), randomState: quantity.max(0xffffffff),
  map: z.object({ layoutId: id, version: z.number().int().positive(), width: z.number().int().min(1).max(512),
    depth: z.number().int().min(1).max(512), blocked: z.array(robotCell).max(65536) }),
  tickMs: z.literal(250), tick: quantity, logicalTimeMs: quantity, paused: z.boolean(),
  robot: z.object({ id: z.string().min(1), position: robotCell, direction: z.enum(['N', 'E', 'S', 'W']),
    status: z.enum(['IDLE', 'MOVING', 'DEPLETED']), battery: quantity.max(10000), path: z.array(robotCell).max(65536), next: quantity }),
});
const fleetWorkSchema = z.object({ taskId: id, phase: z.enum(['APPROACH', 'LOADING', 'TRANSPORT', 'UNLOADING', 'COMPLETED', 'ERROR']),
  phaseTicks: quantity, transportPath: z.array(robotCell).min(1).max(65536), error: z.string().nullable() });
export const resourceDefinitionSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  kind: z.enum(['AISLE', 'PARKING', 'CHARGING', 'WORKSTATION']), cells: z.array(robotCell).min(1).max(128) }).strict();
const fleetResourceSchema = resourceDefinitionSchema.extend({ ownerId: z.string().nullable() });
const navigationSchema = z.object({ revision: quantity, closed: z.array(robotCell).max(256) });
const deviceFaultSchema = z.object({ reason: z.string().trim().min(1).max(200), sinceTick: quantity });
const navigationIssueSchema = z.object({ revision: quantity, reason: z.enum(['NO_PATH', 'BUDGET']) });
export const fleetEnvelopeSchema = z.object({ format: z.literal(1), from: z.array(robotCell).min(3).max(5), state: z.object({
  schemaVersion: z.literal(1), tick: quantity,
  robots: z.array(z.object({ id: z.string().regex(/^robot-[1-5]$/), simulation: simulationStateSchema, work: fleetWorkSchema.nullable(),
    charge: z.object({ dock: robotCell }).nullable().optional(), priority: quantity.max(1000), waitTicks: quantity, totalWaitTicks: quantity,
    waitReason: z.enum(['OCCUPIED', 'EDGE_SWAP', 'TARGET_CONFLICT', 'RESOURCE_BUSY', 'ROUTE_BLOCKED', 'DEVICE_FAULT', 'ENERGY_LOW']).nullable(), blockerId: z.string().nullable(), resourceWaitId: z.string().nullable().optional(), navigationIssue: navigationIssueSchema.nullable().optional(), deviceFault: deviceFaultSchema.nullable().optional() })).min(3).max(5),
  assignments: z.array(z.object({ taskId: id, robotId: z.string(), approach: z.array(robotCell).min(1).max(65536), transport: z.array(robotCell).min(1).max(65536) })).max(10000),
  resources: z.array(fleetResourceSchema).max(32).optional(),
  navigation: navigationSchema.optional(),
}) });
export const fleetResponseSchema = z.object({ spaceId: id, warehouseId: id, role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']),
  enabled: z.boolean(), tick: quantity, watermark: quantity, epoch: quantity, stateVersion: quantity,
  layoutId: id.nullable(), layoutVersion: quantity.nullable(), resources: z.array(fleetResourceSchema).max(32).default([]), navigation: navigationSchema.default({ revision: 0, closed: [] }),
  alerts: z.array(z.object({ key: z.string().min(1).max(180), robotId: z.string(), kind: z.enum(['DEVICE_FAULT', 'ENERGY_LOW', 'NO_PROGRESS']) })).max(5).default([]),
  robots: z.array(z.object({ id: z.string(), taskId: id.nullable(), ledgerTaskId: id.nullable(),
    charge: z.object({ dock: robotCell }).nullable().default(null), phase: z.enum(['IDLE', 'APPROACH', 'LOADING', 'TRANSPORT', 'UNLOADING', 'COMPLETED', 'ERROR']),
    from: robotCell, to: robotCell, battery: quantity.max(10000), carrying: z.boolean(), route: z.array(robotCell).max(65536),
    waitTicks: quantity, totalWaitTicks: quantity, waitReason: z.enum(['OCCUPIED', 'EDGE_SWAP', 'TARGET_CONFLICT', 'RESOURCE_BUSY', 'ROUTE_BLOCKED', 'DEVICE_FAULT', 'ENERGY_LOW']).nullable(),
    blockerId: z.string().nullable(), resourceWaitId: z.string().nullable().default(null), deviceFault: deviceFaultSchema.nullable().default(null), recoveryStatus: z.enum(['PAUSED', 'NEEDS_RECOVERY']).nullable().default(null), navigationIssue: navigationIssueSchema.nullable().default(null), error: z.string().nullable() })).max(5),
}).superRefine((value, ctx) => {
  for (const r of value.robots) if (r.deviceFault ? (r.deviceFault.sinceTick > value.tick || r.recoveryStatus !== (r.carrying ? 'NEEDS_RECOVERY' : 'PAUSED') || !['DEVICE_FAULT', 'ROUTE_BLOCKED'].includes(r.waitReason ?? '')) : r.recoveryStatus !== null) ctx.addIssue({ code: 'custom', message: 'Invalid device recovery snapshot' });
  if (new Set(value.alerts.map((a) => a.robotId)).size !== value.alerts.length || value.alerts.some((a) => !value.robots.some((r) => r.id === a.robotId))) ctx.addIssue({ code: 'custom', message: 'Invalid fleet alerts' });
  for (const r of value.robots) if (r.charge && (r.deviceFault || r.carrying || !['IDLE', 'COMPLETED'].includes(r.phase) || r.battery >= 10000)) ctx.addIssue({ code: 'custom', message: 'Invalid charge state' });
  const resourceIds = new Set<string>(), resourceCells = new Set<string>();
  if (new Set(value.navigation.closed.map((p) => `${p.x}:${p.z}`)).size !== value.navigation.closed.length
    || value.navigation.closed.some((p) => value.robots.some((r) => [r.from, r.to].some((c) => c.x === p.x && c.z === p.z)))) ctx.addIssue({ code: 'custom', message: 'Occupied closure' });
  for (const r of value.robots) if (r.navigationIssue && (r.navigationIssue.revision !== value.navigation.revision
    || ['IDLE', 'COMPLETED', 'ERROR'].includes(r.phase) || !['ROUTE_BLOCKED', 'DEVICE_FAULT'].includes(r.waitReason ?? ''))) ctx.addIssue({ code: 'custom', message: 'Invalid navigation alert' });
  for (const resource of value.resources) {
    if (resourceIds.has(resource.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate resource' });
    resourceIds.add(resource.id);
    for (const p of resource.cells) { const key = `${p.x}:${p.z}`; if (resourceCells.has(key)) ctx.addIssue({ code: 'custom', message: 'Overlapping resources' }); resourceCells.add(key); }
    const occupants = value.robots.filter((r) => resource.cells.some((p) => p.x === r.to.x && p.z === r.to.z));
    if (occupants.length > 1 || (occupants[0]?.id ?? null) !== resource.ownerId) ctx.addIssue({ code: 'custom', message: 'Permit/occupancy mismatch' });
  }
  for (const r of value.robots) if (r.waitReason === 'RESOURCE_BUSY'
    ? !value.resources.some((p) => p.id === r.resourceWaitId) || !value.robots.some((b) => b.id === r.blockerId && b.id !== r.id)
    : r.resourceWaitId !== null) ctx.addIssue({ code: 'custom', message: 'Invalid resource wait' });
  if (value.enabled ? value.robots.length < 3 || !value.layoutId || !value.layoutVersion : value.robots.length !== 0 || value.layoutId !== null) ctx.addIssue({ code: 'custom', message: 'Fleet mode/layout mismatch' });
  if (new Set(value.robots.map((r) => r.id)).size !== value.robots.length
    || new Set(value.robots.map((r) => `${r.to.x}:${r.to.z}`)).size !== value.robots.length
    || new Set(value.robots.filter((r) => r.taskId).map((r) => r.taskId)).size !== value.robots.filter((r) => r.taskId).length) ctx.addIssue({ code: 'custom', message: 'Duplicate fleet identity, cargo or occupancy' });
  for (const r of value.robots) if (Math.abs(r.from.x - r.to.x) + Math.abs(r.from.z - r.to.z) > 1 || r.totalWaitTicks < r.waitTicks
    || (r.phase === 'IDLE' ? r.taskId !== null : !r.taskId) || Boolean(r.taskId) !== Boolean(r.ledgerTaskId)
    || (['IDLE', 'APPROACH', 'LOADING', 'COMPLETED'].includes(r.phase) && r.carrying)
    || (['TRANSPORT', 'UNLOADING'].includes(r.phase) && !r.carrying)) ctx.addIssue({ code: 'custom', message: 'Invalid confirmed fleet pose/cargo' });
});
export type FleetResponse = z.infer<typeof fleetResponseSchema>;
export const robotCheckpointSchema = z.object({
  format: z.literal(1), actorId: id, taskId: id, kind: z.enum(['OUTBOUND', 'PUTAWAY']).default('OUTBOUND'), inboundOrderId: id.nullable().default(null), allocationId: id.nullable(), stagingId: id, from: robotCell,
  loaded: z.boolean(), error: z.string().max(200).nullable(),
  task: z.object({ simulation: simulationStateSchema, phase: z.enum(['APPROACH', 'LOADING', 'TRANSPORT', 'UNLOADING', 'COMPLETED', 'ERROR']),
    phaseTicks: quantity, transportPath: z.array(robotCell).min(1).max(65536), error: z.string().nullable() }),
}).superRefine((value, ctx) => {
  if (value.kind === 'PUTAWAY' ? !value.inboundOrderId || value.allocationId !== null : !value.allocationId || value.inboundOrderId !== null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid checkpoint task identity' });
  }
  const s = value.task.simulation, r = s.robot;
  if (s.logicalTimeMs !== s.tick * s.tickMs || s.map.width * s.map.depth > 65536
    || r.next > r.path.length || (r.status === 'MOVING' && (r.next < 1 || r.next >= r.path.length))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid checkpoint clock/path' });
  }
});
export const warehouseEventsSchema = z.object({
  spaceId: id, warehouseId: id, after: quantity, watermark: quantity,
  events: z.array(warehouseEvent).max(100),
  hasMore: z.boolean(),
}).superRefine((value, ctx) => {
  const last = value.events.at(-1)?.seq ?? value.after;
  if (value.after > value.watermark || last > value.watermark || value.hasMore !== (last < value.watermark)
    || value.events.some((e, i) => e.seq !== value.after + i + 1)) {
    ctx.addIssue({ code: 'custom', message: 'Event cursor/order/watermark mismatch' });
  }
});

export const realtimeSnapshotSchema = z.object({
  layout: layoutSchema, inventory: inventorySchema, simulation: simulationResponseSchema,
  fleet: fleetResponseSchema, watermark: eventCursor,
}).superRefine(({ layout, inventory, simulation, fleet, watermark }, ctx) => {
  if ([inventory, simulation, fleet].some((part) => part.warehouseId !== layout.warehouseId
      || part.spaceId !== layout.spaceId || part.watermark !== watermark)
    || fleet.epoch !== simulation.epoch || fleet.stateVersion !== simulation.stateVersion
    || (fleet.enabled && (fleet.layoutId !== layout.layoutVersion.id || fleet.layoutVersion !== layout.layoutVersion.version))
    || (simulation.runtime && (simulation.runtime.layoutId !== layout.layoutVersion.id
      || simulation.runtime.layoutVersion !== layout.layoutVersion.version))) {
    ctx.addIssue({ code: 'custom', message: 'Snapshot parts disagree on scope, watermark, layout or runtime' });
  }
});
export type RealtimeSnapshot = z.infer<typeof realtimeSnapshotSchema>;

export const operationsSchema = z.object({
  spaceId: id, warehouseId: id, layoutId: id, watermark: eventCursor,
  pending: z.object({ inbound: quantity, outbound: quantity, count: quantity }),
  queue: z.object({ ready: quantity, inTransit: quantity }),
  terminal: z.object({ from: z.string().datetime(), through: z.string().datetime(), completed: quantity, cancelled: quantity }),
  wait: z.object({
    limit: z.literal(240), sampledTicks: quantity.max(240),
    firstSeq: eventCursor.nullable(), lastSeq: eventCursor.nullable(),
    cells: z.array(point.extend({ ms: quantity.positive() })),
  }),
});
export type OperationsResponse = z.infer<typeof operationsSchema>;

export const replayFrameSchema = z.object({
  seq: eventCursor.positive(), tick: eventCursor.positive(), layoutId: id, layoutVersion: quantity.positive(),
  mode: z.enum(['SINGLE', 'FLEET']), anchor: z.boolean(), capturedAt: z.string().datetime(),
  state: z.object({
    format: z.literal(1),
    inventory: z.object({ ...totals, hold: quantity }),
    robots: z.array(z.object({
      id: z.string(), cell: point, from: point, phase: z.string(), battery: quantity.max(10000),
      taskId: id.nullable(), ledgerTaskId: id.nullable(), carrying: z.boolean(), fault: z.boolean(), charging: z.boolean(),
      waitReason: z.string().nullable(),
    })).min(1).max(5),
    owners: z.array(z.object({ id: z.string(), ownerId: z.string().nullable() })).max(32),
    definition: z.object({ navigation: navigationSchema, resources: z.array(fleetResourceSchema).max(32) }).optional(),
  }),
}).refine((frame) => frame.anchor === (frame.state.definition !== undefined), 'Replay anchor definition missing or unexpected');
export type ReplayFrame = z.infer<typeof replayFrameSchema>;

export const historyPageSchema = z.object({
  ...realtimeScope, first: eventCursor.nullable(), through: eventCursor.nullable(),
  baseline: replayFrameSchema.nullable(), events: z.array(warehouseEvent).max(100),
  frames: z.array(replayFrameSchema).max(100), nextAfter: eventCursor.nullable(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
