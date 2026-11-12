const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient, reconcileWarehouse } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { SimulationService } = require('../../apps/api/dist/simulation/simulation.service');
const { TransportService } = require('../../apps/api/dist/transport/transport.service');
const { OutboundService } = require('../../apps/api/dist/outbound/outbound.service');

const url = process.env.INBOUND_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/warehouse_twin_inbound_test') throw new Error('Isolated write test DB required');
const db = new PrismaClient({ datasourceUrl: url });
const transport = new TransportService(db);
const service = new SimulationService(db, transport);
const outbound = new OutboundService(db);
let scope, viewer, stagingId, allocationId;
beforeEach(async () => {
  const warehouseId = randomUUID();
  const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
  const readOnly = await db.user.findUniqueOrThrow({ where: { email: 'viewer@demo.local' } });
  scope = { actorId: admin.id, spaceId: ids.spaceA, warehouseId };
  viewer = { ...scope, actorId: readOnly.id };
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: warehouseId, spaceId: ids.spaceA, name: 'Day18 isolated robot' } });
    await seedInventory(tx, ids.spaceA, warehouseId);
    for (const [userId, role] of [[admin.id, 'ADMIN'], [readOnly.id, 'VIEWER']]) {
      await tx.warehouseAccess.create({ data: { userId, role, spaceId: ids.spaceA, warehouseId } });
    }
  });
  const batch = await db.batch.findFirstOrThrow({ where: { warehouseId, sku: { code: 'SKU-A' } } });
  const created = await outbound.create(scope, { key: randomUUID(), skuId: batch.skuId, batchId: batch.id, quantity: 1, reason: 'Day18 robot fixture' });
  const allocated = await outbound.allocate(scope, created.id, { key: randomUUID(), reason: 'Day18 allocation' });
  allocationId = allocated.allocations[0].id;
  stagingId = (await db.location.findFirstOrThrow({ where: { warehouseId, code: 'OUT-01' } })).id;
});
after(async () => { service.onModuleDestroy(); await db.$disconnect(); });
const input = () => ({ allocationId, stagingLocationId: stagingId, reason: 'Day18 simulation' });
async function current() { return (await service.read(scope)).runtime; }
async function runUntil(phase) {
  for (let i = 0; i < 200; i++) { if ((await current())?.phase === phase) return; await service.advance(); }
  assert.fail(`phase not reached: ${phase}`);
}
async function reconciled() {
  const result = await db.$transaction((tx) => reconcileWarehouse(tx, scope), { isolationLevel: 'RepeatableRead' });
  assert.equal(result.consistent, true);
}

test('server phases move stock once, repeated reads/starts never reset tick, completion preserves onHand', async () => {
  const first = await service.start(scope, input());
  assert.equal(first.phase, 'APPROACH');
  await service.advance();
  const next = await current();
  assert.equal(next.tick, 1);
  assert.equal((await service.start(scope, input())).tick, 1);
  assert.equal((await service.read(viewer)).runtime.taskId, first.taskId);
  await runUntil('TRANSPORT');
  assert.equal((await current()).carrying, true);
  assert.equal((await db.transportTask.findUniqueOrThrow({ where: { id: first.taskId } })).phase, 'IN_TRANSIT');
  await reconciled();
  await runUntil('COMPLETED');
  const done = await current();
  assert.equal(done.carrying, false);
  const total = await db.inventoryBalance.aggregate({ where: { warehouseId: scope.warehouseId }, _sum: { onHand: true, reserved: true } });
  assert.deepEqual(total._sum, { onHand: 62, reserved: 1 });
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 2);
  await service.advance();
  assert.deepEqual(await current(), done);
  await reconciled();
});

test('viewer/cross-scope/forged actor are rejected and concurrent starts create only one runtime', async () => {
  await assert.rejects(service.start(viewer, input()), { status: 403 });
  await assert.rejects(service.read({ ...scope, spaceId: ids.spaceB }), { status: 404 });
  await assert.rejects(service.start(scope, { ...input(), actorId: viewer.actorId }), { status: 400 });
  const results = await Promise.allSettled([service.start(scope, input()), service.start(scope, input())]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await db.transportTask.count({ where: { warehouseId: scope.warehouseId } }), 1);
  await runUntil('COMPLETED');
});

test('ledger failure stops at last confirmed pose and never publishes a take effect', async () => {
  const failing = new SimulationService(db, { create: transport.create.bind(transport), take: async () => { throw new Error('injected take failure'); }, drop: transport.drop.bind(transport) });
  const started = await failing.start(scope, input());
  for (let i = 0; i < 200; i++) {
    await failing.advance();
    if ((await failing.read(scope)).runtime.phase === 'ERROR') break;
  }
  const failed = (await failing.read(scope)).runtime;
  assert.equal(failed.phase, 'ERROR');
  assert.equal(failed.carrying, false);
  assert.deepEqual(failed.from, failed.to);
  assert.equal((await db.transportTask.findUniqueOrThrow({ where: { id: started.taskId } })).phase, 'READY');
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 0);
  await reconciled();
});

test('overlapping callbacks never double advance a tick and revoked permission stops movement', async () => {
  await service.start(scope, input());
  await Promise.all([service.advance(), service.advance(), service.advance()]);
  assert.equal((await current()).tick, 1);
  await db.warehouseAccess.update({ where: { userId_spaceId_warehouseId: { userId: scope.actorId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } }, data: { role: 'VIEWER' } });
  await service.advance();
  assert.equal((await current()).phase, 'ERROR');
  assert.equal((await current()).tick, 1);
  await reconciled();
});

test('in-transit ledger tasks cannot be reinitialized after a process-level loss of runtime', async () => {
  await service.start(scope, input());
  await runUntil('TRANSPORT');
  const restarted = new SimulationService(db, transport);
  assert.equal((await restarted.read(scope)).runtime, null);
  await assert.rejects(restarted.start(scope, input()), { status: 409 });
  await runUntil('COMPLETED');
  await reconciled();
});

test('failed unload retains confirmed carrying state and reconciled transit cargo', async () => {
  const failing = new SimulationService(db, { create: transport.create.bind(transport), take: transport.take.bind(transport),
    drop: async () => { throw new Error('injected unload failure'); } });
  const started = await failing.start(scope, input());
  for (let i = 0; i < 200; i++) {
    await failing.advance();
    if ((await failing.read(scope)).runtime.phase === 'ERROR') break;
  }
  const failed = (await failing.read(scope)).runtime;
  assert.equal(failed.phase, 'ERROR');
  assert.equal(failed.carrying, true);
  assert.equal((await db.transportTask.findUniqueOrThrow({ where: { id: started.taskId } })).phase, 'IN_TRANSIT');
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 1);
  await reconciled();
});

test('transport transaction rejects an obsolete expected layout before writing stock', async () => {
  const started = await service.start(scope, input());
  await assert.rejects(transport.take(scope, started.taskId, 'stale pose', randomUUID()), { status: 409 });
  assert.equal((await db.transportTask.findUniqueOrThrow({ where: { id: started.taskId } })).phase, 'READY');
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 0);
  await runUntil('COMPLETED');
  await reconciled();
});
