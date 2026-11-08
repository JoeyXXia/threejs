const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { reconcile, reconcileReservations } = require('../../packages/database/reconcile.cjs');
const { TransportService } = require('../../apps/api/dist/transport/transport.service');
const { OutboundService } = require('../../apps/api/dist/outbound/outbound.service');
const { InventoryController } = require('../../apps/api/dist/inventory.controller');

const url = process.env.INBOUND_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/warehouse_twin_inbound_test') {
  throw new Error('Isolated write test DB required');
}
const db = new PrismaClient({ datasourceUrl: url });
const otherDb = new PrismaClient({ datasourceUrl: url });
const transport = new TransportService(db);
const concurrent = new TransportService(otherDb);
const outbound = new OutboundService(db);
const inventory = new InventoryController(db);
const note = 'Day 10 transport fixture';
let scope, warehouseScope, skuId, batchId, stagingId;

beforeEach(async () => {
  warehouseScope = { spaceId: ids.spaceA, warehouseId: randomUUID() };
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: warehouseScope.warehouseId, spaceId: warehouseScope.spaceId, name: 'Day 10 isolated case' } });
    await seedInventory(tx, warehouseScope.spaceId, warehouseScope.warehouseId);
    const admin = await tx.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
    scope = { ...warehouseScope, actorId: admin.id };
    await tx.warehouseAccess.create({ data: { ...warehouseScope, userId: admin.id, role: 'ADMIN' } });
  });
  skuId = (await db.sku.findFirstOrThrow({ where: { ...warehouseScope, code: 'SKU-A' } })).id;
  batchId = (await db.batch.findFirstOrThrow({ where: { ...warehouseScope, skuId } })).id;
  stagingId = (await db.location.findFirstOrThrow({ where: { ...warehouseScope, code: 'OUT-01' } })).id;
});
after(async () => { await db.$disconnect(); await otherDb.$disconnect(); });

async function order(quantity) {
  const created = await outbound.create(scope, { key: randomUUID(), skuId, batchId, quantity, reason: note });
  return outbound.allocate(scope, created.id, { key: randomUUID(), reason: note });
}
const create = (allocation, service = transport) => service.create(scope, allocation.id, stagingId, note);
const stock = () => inventory.inventory({ identity: { userId: scope.actorId } }, scope.spaceId, scope.warehouseId);
const counts = (snapshot, locationId) => {
  const row = snapshot.locationTotals.find((item) => item.locationId === locationId);
  return [row.onHand, row.reserved];
};
const postings = () => db.inventoryMovement.findMany({ where: { ...warehouseScope, businessKey: { startsWith: 'transport:' } } });
const reservedCapacity = async () => (await db.$queryRaw`SELECT staging_reserved(${stagingId}::uuid) AS quantity`)[0].quantity;
async function assertReconciled() {
  await db.$transaction(async (tx) => {
    assert.deepEqual(await reconcile(tx), []);
    assert.deepEqual(await reconcileReservations(tx), []);
  }, { isolationLevel: 'RepeatableRead' });
}

test('10 pieces move through transit and staging; only dispatch reduces warehouse stock', async () => {
  const outboundOrder = await order(10);
  assert.ok(outboundOrder.allocations.length > 1);
  const tasks = [];
  for (const allocation of outboundOrder.allocations) tasks.push(await create(allocation));
  const initial = await stock();
  assert.deepEqual(initial.summary, { onHand: 62, reserved: 10, available: 45, hold: 7 });
  assert.equal(await reservedCapacity(), 10n);
  assert.deepEqual(counts(initial, stagingId), [0, 0]);
  assert.deepEqual(await postings(), []);
  await assert.rejects(transport.drop(scope, tasks[0].id, note), { status: 409 });

  for (const task of tasks) await transport.take(scope, task.id, note);
  const carrying = await stock();
  assert.deepEqual(carrying.summary, initial.summary);
  assert.equal(carrying.locationTotals.length, initial.locationTotals.length);
  assert.equal(carrying.balances.filter((row) => row.transit).length, tasks.length);
  const { layoutSchema, inventorySchema, validateSnapshot } = await import('../../packages/contracts/dist/index.js');
  const layout = await inventory.layout({ identity: { userId: scope.actorId } }, scope.spaceId, scope.warehouseId);
  validateSnapshot(layoutSchema.parse(layout), inventorySchema.parse(carrying), scope.spaceId, scope.warehouseId);
  for (const allocation of outboundOrder.allocations) {
    const [startingOnHand, startingReserved] = counts(initial, allocation.locationId);
    assert.deepEqual(counts(carrying, allocation.locationId), [startingOnHand - allocation.quantity, startingReserved - allocation.quantity]);
    const task = tasks.find((row) => row.allocationId === allocation.id);
    const { onHand, reserved, available, transit } = carrying.balances.find((row) => row.locationId === task.transitLocationId);
    assert.deepEqual([onHand, reserved, available, transit], [allocation.quantity, allocation.quantity, 0, true]);
  }
  assert.equal(await reservedCapacity(), 10n);
  await assertReconciled();

  await transport.drop(scope, tasks[0].id, note);
  const partial = await stock();
  const partialPostings = await postings();
  await assert.rejects(transport.dispatch(scope, outboundOrder.id, note), { status: 409 });
  assert.deepEqual((await stock()).balances, partial.balances);
  assert.equal((await postings()).length, partialPostings.length);
  for (const task of tasks.slice(1)) await transport.drop(scope, task.id, note);
  const staged = await stock();
  assert.deepEqual(staged.summary, initial.summary);
  assert.deepEqual(counts(staged, stagingId), [10, 10]);
  assert.equal(staged.balances.some((row) => row.transit), false);
  assert.equal(await reservedCapacity(), 0n);
  await assertReconciled();

  const replay = await Promise.all([transport.dispatch(scope, outboundOrder.id, note), concurrent.dispatch(scope, outboundOrder.id, note)]);
  assert.deepEqual(replay, Array(2).fill({ id: outboundOrder.id, status: 'DISPATCHED' }));
  const final = await stock();
  assert.deepEqual(final.summary, { onHand: 52, reserved: 0, available: 45, hold: 7 });
  assert.deepEqual(counts(final, stagingId), [0, 0]);
  const ledger = await postings();
  assert.equal(ledger.length, tasks.length * 3);
  assert.equal(ledger.filter((row) => row.kind === 'DISPATCH').reduce((sum, row) => sum + row.quantity, 0), 10);
  assert.equal(ledger.filter((row) => row.kind === 'DISPATCH').every((row) => row.destinationLocationId === null), true);
  const listed = (await outbound.list(scope)).orders.find((row) => row.id === outboundOrder.id);
  assert.equal(listed.status, 'DISPATCHED');
  assert.deepEqual(listed.allocations, outboundOrder.allocations);
  await assertReconciled();
});

test('concurrent retries of create, take and drop have one effect per phase', async () => {
  const allocated = (await order(1)).allocations[0];
  const [task, replay] = await Promise.all([create(allocated), create(allocated, concurrent)]);
  assert.equal(replay.id, task.id);
  assert.equal(await reservedCapacity(), 1n);
  await Promise.all([transport.take(scope, task.id, note), concurrent.take(scope, task.id, note)]);
  await Promise.all([transport.drop(scope, task.id, note), concurrent.drop(scope, task.id, note)]);
  await transport.take(scope, task.id, note);
  assert.deepEqual((await postings()).map((row) => row.businessKey).sort(), [`transport:${task.id}:drop`, `transport:${task.id}:take`]);
  assert.deepEqual(counts(await stock(), stagingId), [1, 1]);
  assert.equal(await reservedCapacity(), 0n);
  await assertReconciled();
});

test('two independent connections compete for the last unit of staging capacity', async () => {
  await db.$transaction(async (tx) => {
    await tx.inventoryBalance.create({ data: { ...warehouseScope, locationId: stagingId, skuId, batchId, onHand: 99, quality: 'RELEASED' } });
    await tx.inventoryMovement.create({ data: { ...warehouseScope, skuId, batchId, kind: 'OPENING',
      destinationLocationId: stagingId, destinationQuality: 'RELEASED', quantity: 99, businessKey: randomUUID(),
      actorId: 'transport-fixture', actorType: 'TEST', reason: note, reference: 'staging capacity test' } });
  });
  const first = (await order(1)).allocations[0];
  const second = (await order(1)).allocations[0];
  const outcomes = await Promise.allSettled([create(first), create(second, concurrent)]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((result) => result.status === 'rejected').reason.getStatus(), 409);
  assert.equal(await db.location.count({ where: { ...warehouseScope, kind: 'TRANSIT' } }), 1);
  assert.equal(await reservedCapacity(), 1n);
  await assert.rejects(db.inventoryBalance.updateMany({ where: { ...warehouseScope, locationId: stagingId }, data: { onHand: 100 } }), /Location capacity exceeded/);
  const task = outcomes.find((result) => result.status === 'fulfilled').value;
  await transport.take(scope, task.id, note);
  await transport.drop(scope, task.id, note);
  assert.deepEqual(counts(await stock(), stagingId), [100, 1]);
  assert.equal(await reservedCapacity(), 0n);
  await assertReconciled();
});

test('failed drop posting rolls back phase, staging capacity and both balances; retry succeeds', async () => {
  const task = await create((await order(1)).allocations[0]);
  await transport.take(scope, task.id, note);
  const before = await stock();
  const auditBefore = await db.auditLog.count({ where: warehouseScope });
  await db.$executeRawUnsafe(`CREATE FUNCTION test_fail_transport_drop() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."businessKey" LIKE 'transport:%:drop' THEN RAISE EXCEPTION 'test drop posting failure'; END IF;
      RETURN NEW;
    END $$`);
  try {
    await db.$executeRawUnsafe('CREATE TRIGGER test_fail_transport_drop BEFORE INSERT ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION test_fail_transport_drop()');
    try {
      await assert.rejects(transport.drop(scope, task.id, note), /test drop posting failure/);
      assert.equal((await db.transportTask.findUniqueOrThrow({ where: { id: task.id } })).phase, 'IN_TRANSIT');
      assert.deepEqual((await stock()).balances, before.balances);
      assert.equal(await reservedCapacity(), 1n);
      assert.equal(await db.auditLog.count({ where: warehouseScope }), auditBefore);
      assert.equal((await postings()).length, 1);
      await assertReconciled();
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_fail_transport_drop ON "InventoryMovement"');
    }
  } finally {
    await db.$executeRawUnsafe('DROP FUNCTION test_fail_transport_drop()');
  }
  await transport.drop(scope, task.id, note);
  assert.deepEqual(counts(await stock(), stagingId), [1, 1]);
  await assertReconciled();
});

test('a layout switch cannot remove staging with active reservations and preserves transit stock', async () => {
  const task = await create((await order(1)).allocations[0]);
  await transport.take(scope, task.id, note);
  const active = (await db.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId }, include: { activeLayout: true } })).activeLayout;
  async function publish(omitStaging) {
    return db.$transaction(async (tx) => {
      const layoutId = randomUUID();
      await tx.layoutVersion.create({ data: { ...active, id: layoutId, version: 2, status: 'DRAFT' } });
      const zoneIds = new Map(), rackIds = new Map();
      for (const row of await tx.layoutZone.findMany({ where: { layoutId: active.id } })) {
        const id = randomUUID();
        await tx.layoutZone.create({ data: { ...row, id, layoutId } });
        zoneIds.set(row.id, id);
      }
      for (const row of await tx.rack.findMany({ where: { layoutId: active.id } })) {
        const id = randomUUID();
        await tx.rack.create({ data: { ...row, id, layoutId, zoneId: zoneIds.get(row.zoneId) } });
        rackIds.set(row.id, id);
      }
      for (const row of await tx.layoutLocation.findMany({ where: { layoutId: active.id } })) {
        if (omitStaging && row.locationId === stagingId) continue;
        await tx.layoutLocation.create({ data: { ...row, layoutId, zoneId: zoneIds.get(row.zoneId), rackId: rackIds.get(row.rackId) ?? null } });
      }
      await tx.layoutVersion.update({ where: { id: layoutId }, data: { status: 'PUBLISHED' } });
      await tx.warehouse.update({ where: { id: scope.warehouseId }, data: { activeLayoutId: layoutId } });
    });
  }
  await assert.rejects(publish(true), /cannot orphan or overfill stock or reservations/);
  await publish(false);
  const snapshot = await stock();
  assert.equal(snapshot.layoutVersion, 2);
  const { transit, onHand, reserved } = snapshot.balances.find((row) => row.locationId === task.transitLocationId);
  assert.deepEqual([transit, onHand, reserved], [true, 1, 1]);
  assert.deepEqual(snapshot.summary, { onHand: 62, reserved: 1, available: 54, hold: 7 });
  // Leave the load in transit so the integration runner also reconciles it after a real restart.
  await assertReconciled();
});

test('authorization and endpoint checks reject cross-scope tasks and non-staging destinations', async () => {
  const allocation = (await order(1)).allocations[0];
  await assert.rejects(transport.create(scope, allocation.id, allocation.locationId, note), { status: 404 });
  await assert.rejects(transport.create({ ...scope, warehouseId: ids.warehouseA }, allocation.id, stagingId, note), { status: 404 });
  const task = await create(allocation);
  const viewer = await db.user.findUniqueOrThrow({ where: { email: 'viewer@demo.local' } });
  await db.warehouseAccess.create({ data: { ...warehouseScope, userId: viewer.id, role: 'VIEWER' } });
  await assert.rejects(transport.take({ ...scope, actorId: viewer.id }, task.id, note), { status: 403 });
  assert.deepEqual(await postings(), []);
  assert.equal(await reservedCapacity(), 1n);
  await assertReconciled();
});
