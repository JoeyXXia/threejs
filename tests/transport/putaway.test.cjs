const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient, reconcileWarehouse } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { SimulationService } = require('../../apps/api/dist/simulation/simulation.service');
const { TransportService } = require('../../apps/api/dist/transport/transport.service');
const { PutawayService } = require('../../apps/api/dist/transport/putaway.service');
const { OutboundService } = require('../../apps/api/dist/outbound/outbound.service');
const { InboundService } = require('../../apps/api/dist/inbound/inbound.service');
const { CountService } = require('../../apps/api/dist/count/count.service');
const { lockWarehouseState } = require('../../apps/api/dist/warehouse-state');

const url = process.env.INBOUND_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/warehouse_twin_inbound_test') throw new Error('Isolated write test DB required');
const db = new PrismaClient({ datasourceUrl: url });
const other = new PrismaClient({ datasourceUrl: url });
const runner = new SimulationService(db, new TransportService(db));
const inbound = new InboundService(db), outbound = new OutboundService(db), putaway = new PutawayService();
let scope, viewer, receipt, target, skuId, qcId;
const note = 'Day20 measured fixture';
const command = () => ({ key: randomUUID(), reason: note });
const input = () => ({ kind: 'PUTAWAY', inboundOrderId: receipt.id, targetLocationId: target.id, reason: note });
beforeEach(async () => {
  const warehouseId = randomUUID();
  const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
  const readOnly = await db.user.findUniqueOrThrow({ where: { email: 'viewer@demo.local' } });
  scope = { actorId: admin.id, spaceId: ids.spaceA, warehouseId };
  viewer = { ...scope, actorId: readOnly.id };
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: warehouseId, spaceId: scope.spaceId, name: 'Day20 isolated putaway' } });
    await seedInventory(tx, scope.spaceId, warehouseId);
    for (const [userId, role] of [[admin.id, 'ADMIN'], [readOnly.id, 'VIEWER']]) await tx.warehouseAccess.create({ data: { userId, role, spaceId: scope.spaceId, warehouseId } });
  });
  skuId = (await db.sku.findFirstOrThrow({ where: { warehouseId, code: 'SKU-A' } })).id;
  qcId = (await db.location.findFirstOrThrow({ where: { warehouseId, kind: 'QC' } })).id;
  target = await db.location.findFirstOrThrow({ where: { warehouseId, kind: 'STORAGE', balances: { none: { onHand: { gt: 0 } } } }, orderBy: { code: 'asc' } });
  receipt = await makeReceipt(4);
});
after(async () => { await runner.onModuleDestroy(); await db.$disconnect(); await other.$disconnect(); });
async function makeReceipt(quantity, batchCode = randomUUID()) {
  const order = await inbound.create(scope, { ...command(), skuId, qcLocationId: qcId, batchCode, quantity, producedAt: null, expiresAt: null });
  await inbound.phase(scope, order.id, 'receive', command());
  return inbound.phase(scope, order.id, 'inspect', { ...command(), decision: 'PASS' });
}
async function runUntil(phase) {
  for (let i = 0; i < 250; i++) {
    const state = (await runner.read(scope)).runtime;
    if (state?.phase === phase) return state;
    if (state?.phase === 'ERROR') assert.fail(state.error);
    await runner.advance();
  }
  assert.fail(`phase not reached: ${phase}`);
}
async function reconciled() {
  const result = await db.$transaction((tx) => reconcileWarehouse(tx, scope), { isolationLevel: 'RepeatableRead' });
  assert.deepEqual(result, { consistent: true, mismatches: [], reservationMismatches: [] });
}
const stock = () => db.inventoryBalance.aggregate({ where: { warehouseId: scope.warehouseId }, _sum: { onHand: true } });
const boundary = (work, client = db) => client.$transaction(async (tx) => { await lockWarehouseState(tx, scope); return work(tx); });

test('released receipt moves QC -> transit -> storage, becomes allocatable, then explicit dispatch alone reduces stock', async () => {
  const initial = await stock();
  const start = await runner.start(scope, input());
  assert.equal(start.kind, 'PUTAWAY'); assert.equal(start.inboundOrderId, receipt.id); assert.equal(start.allocationId, null);
  assert.equal((await runner.start(scope, input())).taskId, start.taskId);
  await reconciled();
  await assert.rejects(new CountService(db).create(scope, { ...command(), locationId: target.id }), { status: 409 });
  await runUntil('TRANSPORT'); await reconciled();
  await runUntil('COMPLETED'); await reconciled();
  const stored = await db.inventoryBalance.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, locationId: target.id, batchId: receipt.batchId } });
  assert.deepEqual([stored.onHand, stored.reserved], [4, 0]);
  assert.deepEqual(await stock(), initial);
  await boundary((tx) => putaway.moveInTransaction(tx, scope, start.taskId, 'take', note));
  await boundary((tx) => putaway.moveInTransaction(tx, scope, start.taskId, 'drop', note));
  assert.equal(await db.inventoryMovement.count({ where: { businessKey: { startsWith: `putaway:${start.taskId}:` } } }), 2);
  const order = await outbound.create(scope, { ...command(), skuId, batchId: receipt.batchId, quantity: 4 });
  const allocated = await outbound.allocate(scope, order.id, command());
  const dispatchRequest = command();
  await assert.rejects(outbound.dispatch(scope, order.id, dispatchRequest), { status: 409 });
  await assert.rejects(outbound.dispatch(viewer, order.id, command()), { status: 403 });
  await assert.rejects(outbound.dispatch({ ...scope, spaceId: ids.spaceB }, order.id, command()), { status: 404 });
  const staging = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, kind: 'OUTBOUND' } });
  await runner.start(scope, { allocationId: allocated.allocations[0].id, stagingLocationId: staging.id, reason: note });
  await runUntil('COMPLETED');
  assert.deepEqual(await stock(), initial, 'staging is not shipment');
  const result = await outbound.dispatch(scope, order.id, dispatchRequest);
  assert.equal(result.status, 'DISPATCHED');
  assert.deepEqual(await outbound.dispatch(scope, order.id, dispatchRequest), result);
  await assert.rejects(outbound.dispatch(scope, order.id, { ...dispatchRequest, reason: 'changed' }), { status: 409 });
  await outbound.dispatch(scope, order.id, command());
  assert.equal((await stock())._sum.onHand, initial._sum.onHand - 4);
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, kind: 'DISPATCH' } }), 1);
  await reconciled();
});

test('viewer, forged actor, cross-scope, wrong kind/target, incompatible stock and unreleased receipts cannot start putaway', async () => {
  await assert.rejects(runner.start(viewer, input()), { status: 403 });
  await assert.rejects(runner.start({ ...scope, spaceId: ids.spaceB }, input()), { status: 404 });
  await assert.rejects(runner.start(scope, { ...input(), actorId: viewer.actorId }), { status: 400 });
  await assert.rejects(runner.start(scope, { ...input(), kind: 'REAL_ROBOT' }), { status: 400 });
  await assert.rejects(runner.start(scope, { ...input(), targetLocationId: qcId }), { status: 409 });
  const occupied = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, kind: 'STORAGE', balances: { some: { onHand: { gt: 0 } } } } });
  await assert.rejects(runner.start(scope, { ...input(), targetLocationId: occupied.id }), { status: 409 });
  const pending = await inbound.create(scope, { ...command(), skuId, qcLocationId: qcId, batchCode: randomUUID(), quantity: 1, producedAt: null, expiresAt: null });
  await assert.rejects(runner.start(scope, { ...input(), inboundOrderId: pending.id }), { status: 409 });
  assert.equal(await db.putawayTask.count({ where: { warehouseId: scope.warehouseId } }), 0);
  await reconciled();
});

test('target capacity and batch reservation serialize independent writers, and DB guards reject bypass', async () => {
  const first = await makeReceipt(30, 'capacity-shared');
  const second = await makeReceipt(30, 'capacity-shared');
  const create = (r, client) => boundary((tx) => putaway.createInTransaction(tx, scope, r.id, target.id, note), client);
  const outcomes = await Promise.allSettled([create(first, db), create(second, other)]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  await assert.rejects(create(receipt, db), { status: 409 }, 'different incoming batch cannot share empty reserved storage');
  const task = outcomes.find((o) => o.status === 'fulfilled').value;
  const wrongBatch = { spaceId: scope.spaceId, warehouseId: scope.warehouseId, locationId: target.id, skuId, batchId: receipt.batchId, quality: 'RELEASED', onHand: 1 };
  await assert.rejects(db.inventoryBalance.create({ data: wrongBatch }), 'raw write cannot mix into reserved storage');
  const incomingReceipt = task.inboundOrderId === first.id ? first : second;
  await assert.rejects(db.inventoryBalance.create({ data: { ...wrongBatch, batchId: incomingReceipt.batchId, onHand: 11 } }), 'raw write cannot steal reserved capacity');
  await assert.rejects(db.putawayTask.update({ where: { id: task.id }, data: { phase: 'STAGED' } }));
  await assert.rejects(db.putawayTask.delete({ where: { id: task.id } }));
  await assert.rejects(new CountService(db).create(scope, { ...command(), locationId: target.id }), { status: 409 });
  await reconciled();
});

test('expired released receipts and counted destinations reject start without reserving source stock', async () => {
  await db.batch.update({ where: { id: receipt.batchId }, data: { expiresAt: new Date('2000-01-01T00:00:00Z') } });
  await assert.rejects(runner.start(scope, input()), { status: 409 });
  await db.batch.update({ where: { id: receipt.batchId }, data: { expiresAt: null } });
  await new CountService(db).create(scope, { ...command(), locationId: target.id });
  await assert.rejects(runner.start(scope, input()), { status: 409 });
  const released = await db.inventoryBalance.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, batchId: receipt.batchId, quality: 'RELEASED' } });
  assert.equal(released.reserved, 0);
  assert.equal(await db.putawayTask.count({ where: { warehouseId: scope.warehouseId } }), 0);
  await reconciled();
});

test('take and drop event failures roll back every durable effect; committed lost-response replay cannot repost', async () => {
  await runner.start(scope, input());
  for (const effect of ['take', 'drop']) {
    let prepared;
    for (let i = 0; i < 250; i++) {
      prepared = await runner.prepare(scope.warehouseId);
      if (prepared.proposal.effect === effect) break;
      await runner.commit(prepared);
    }
    assert.equal(prepared.proposal.effect, effect);
    const read = async () => ({
      runtime: await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } }),
      balances: await db.inventoryBalance.findMany({ where: { warehouseId: scope.warehouseId }, orderBy: { id: 'asc' } }),
      tasks: await db.putawayTask.findMany({ where: { warehouseId: scope.warehouseId } }),
      movements: await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId } }),
      audits: await db.auditLog.count({ where: { warehouseId: scope.warehouseId } }),
      events: await db.warehouseEvent.count({ where: { warehouseId: scope.warehouseId } }),
    });
    const before = await read();
    await db.$executeRawUnsafe(`CREATE FUNCTION day20_fail_tick() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."warehouseId"='${scope.warehouseId}'::uuid AND NEW.kind='SIM_TICK' THEN RAISE EXCEPTION 'injected before commit'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER day20_fail_tick BEFORE INSERT ON "WarehouseEvent" FOR EACH ROW EXECUTE FUNCTION day20_fail_tick()');
    try { await assert.rejects(runner.commit(prepared)); assert.deepEqual(await read(), before); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER day20_fail_tick ON "WarehouseEvent"'); await db.$executeRawUnsafe('DROP FUNCTION day20_fail_tick()'); }
    await runner.commit(prepared); // caller can lose this response without losing the commit
    const afterCommit = await read();
    await assert.rejects(runner.commit(prepared), { status: 409 });
    assert.deepEqual(await read(), afterCommit);
    await reconciled();
  }
  assert.equal((await runner.read(scope)).runtime.phase, 'COMPLETED');
});
