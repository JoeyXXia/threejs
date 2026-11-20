const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { fork } = require('node:child_process');
const { resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { PrismaClient, reconcileWarehouse } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { FleetService } = require('../../apps/api/dist/simulation/fleet.service');
const { SimulationService } = require('../../apps/api/dist/simulation/simulation.service');
const { TransportService } = require('../../apps/api/dist/transport/transport.service');
const { OutboundService } = require('../../apps/api/dist/outbound/outbound.service');
const { InboundService } = require('../../apps/api/dist/inbound/inbound.service');
const url = process.env.INBOUND_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/warehouse_twin_inbound_test') throw new Error('Isolated DB required');
const db = new PrismaClient({ datasourceUrl: url }), secondDb = new PrismaClient({ datasourceUrl: url });
const service = new FleetService(db), other = new FleetService(secondDb), outbound = new OutboundService(db), inbound = new InboundService(db);
let scope, viewer, batch, staging;
const cmd = () => ({ key: randomUUID(), reason: 'Day22 isolated fleet' });
beforeEach(async () => {
  const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
  const readOnly = await db.user.findUniqueOrThrow({ where: { email: 'viewer@demo.local' } });
  scope = { spaceId: ids.spaceA, warehouseId: randomUUID(), actorId: admin.id }; viewer = { ...scope, actorId: readOnly.id };
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: scope.warehouseId, spaceId: scope.spaceId, name: 'Day22 fleet fixture' } });
    await seedInventory(tx, scope.spaceId, scope.warehouseId);
    for (const [userId, role] of [[admin.id, 'ADMIN'], [readOnly.id, 'VIEWER']]) await tx.warehouseAccess.create({ data: { userId, role, spaceId: scope.spaceId, warehouseId: scope.warehouseId } });
  });
  batch = await db.batch.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, sku: { code: 'SKU-A' } } });
  staging = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, kind: 'OUTBOUND' } });
});
after(async () => { await service.onModuleDestroy(); await other.onModuleDestroy(); await db.$disconnect(); await secondDb.$disconnect(); });
const init = (count = 3) => service.initialize(scope, { count, reason: 'Day22 initialize' });
async function input(robotId = 'robot-1') {
  const order = await outbound.create(scope, { ...cmd(), skuId: batch.skuId, batchId: batch.id, quantity: 1 });
  const allocated = await outbound.allocate(scope, order.id, cmd());
  return { robotId, allocationId: allocated.allocations[0].id, stagingLocationId: staging.id, reason: 'Day22 assignment' };
}
async function reconciled() { assert.equal((await db.$transaction((tx) => reconcileWarehouse(tx, scope), { isolationLevel: 'RepeatableRead' })).consistent, true); }
async function snapshot() { return { runtime: await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } }),
  claims: await db.fleetClaim.findMany({ where: { warehouseId: scope.warehouseId }, orderBy: { id: 'asc' } }),
  balances: await db.inventoryBalance.findMany({ where: { warehouseId: scope.warehouseId }, orderBy: { id: 'asc' } }),
  movements: await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId } }), events: await db.warehouseEvent.count({ where: { warehouseId: scope.warehouseId } }) }; }
function safe(before, after) {
  assert.equal(new Set(after.robots.map((r) => `${r.to.x}:${r.to.z}`)).size, after.robots.length);
  for (const r of after.robots) if (JSON.stringify(r.to) !== JSON.stringify(before.robots.find((b) => b.id === r.id).to)) {
    assert.equal(before.robots.some((b) => b.id !== r.id && b.to.x === r.to.x && b.to.z === r.to.z), false);
  }
}

test('fleet initialization is authorized, scoped, persistent and cannot overwrite an active legacy task or resize', async () => {
  await assert.rejects(service.initialize(viewer, { count: 3, reason: 'read only' }), { status: 403 });
  await assert.rejects(service.read({ ...scope, spaceId: ids.spaceB }), { status: 404 });
  await assert.rejects(service.initialize(scope, { count: 6, reason: 'invalid' }), { status: 400 });
  const legacy = new SimulationService(db, new TransportService(db)), request = await input();
  const { robotId, ...single } = request; assert.equal(robotId, 'robot-1');
  await legacy.start(scope, single);
  await assert.rejects(init(), { status: 409 });
  for (let i = 0; i < 150 && (await legacy.read(scope)).runtime.phase !== 'COMPLETED'; i++) await legacy.advance();
  const saved = (await legacy.read(scope)).runtime;
  const state = await init();
  assert.equal(state.robots.length, 3); assert.equal(state.tick, saved.tick); assert.deepEqual(state.robots[0].to, saved.to);
  assert.equal(state.robots[0].battery, saved.battery);
  assert.deepEqual(await init(), state);
  await assert.rejects(init(5), { status: 409 });
  const next = await input(); const { robotId: unused, ...singleAgain } = next; assert.ok(unused);
  await assert.rejects(legacy.start(scope, singleAgain), { status: 409 });
  await legacy.onModuleDestroy(); await reconciled();
});

test('two real clients compete for one task; one owner wins and database constraints reject duplicate/changed claims', async () => {
  await init(); const body = await input();
  const outcomes = await Promise.allSettled([service.assign(scope, body), other.assign(scope, { ...body, robotId: 'robot-2' })]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  const claim = outcomes.find((r) => r.status === 'fulfilled').value;
  assert.equal(await db.fleetClaim.count({ where: { warehouseId: scope.warehouseId } }), 1);
  const stable = await service.read(scope);
  assert.equal((await service.assign(scope, { ...body, robotId: claim.robotId })).id, claim.id);
  assert.deepEqual(await service.read(scope), stable);
  await assert.rejects(db.fleetClaim.update({ where: { id: claim.id }, data: { robotId: 'robot-3' } }));
  await assert.rejects(db.fleetClaim.create({ data: { ...claim, id: randomUUID(), robotId: 'robot-3' } }));
  const second = await input(claim.robotId);
  await assert.rejects(service.assign(scope, second), { status: 409 });
  assert.equal(await db.transportTask.count({ where: { warehouseId: scope.warehouseId } }), 1, 'failed busy assignment rolls domain creation back');
  await assert.rejects(service.assign(viewer, body), { status: 403 });
  await assert.rejects(service.assign(scope, { ...body, actorId: viewer.actorId }), { status: 400 });
  await reconciled();
});

test('a completed legacy checkpoint from a different layout cannot silently reset position or battery on fleet activation', async () => {
  const legacy = new SimulationService(db, new TransportService(db));
  const { robotId, ...body } = await input(); assert.ok(robotId);
  await legacy.start(scope, body);
  for (let i = 0; i < 150 && (await legacy.read(scope)).runtime.phase !== 'COMPLETED'; i++) await legacy.advance();
  const row = await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } });
  const checkpoint = JSON.parse(JSON.stringify(row.checkpoint));
  checkpoint.task.simulation.map.layoutId = randomUUID(); // Deliberate incompatible-checkpoint fixture, not a business flow.
  await db.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { checkpoint } });
  await assert.rejects(init(), { status: 409 });
  const after = await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } });
  assert.equal(after.fleet, null); assert.deepEqual(after.checkpoint, checkpoint);
  await legacy.onModuleDestroy();
});

test('five persistent active tasks have unique owners, preserve occupancy and expose honest waiting after 120 ticks', async () => {
  await init(5);
  for (let i = 1; i <= 5; i++) await service.assign(scope, await input(`robot-${i}`));
  assert.equal((await service.read(scope)).robots.filter((r) => r.taskId).length, 5);
  let state = await service.read(scope), observedWaits = 0;
  for (let i = 0; i < 120; i++) { await service.advance(); const next = await service.read(scope); safe(state, next); observedWaits += next.robots.filter((r) => r.waitReason).length; state = next; }
  assert.ok(observedWaits > 0); assert.ok(state.robots.some((r) => r.waitTicks > 0));
  assert.equal(new Set(state.robots.map((r) => r.taskId)).size, 5);
  assert.equal((await db.inventoryBalance.aggregate({ where: { warehouseId: scope.warehouseId }, _sum: { onHand: true, reserved: true } }))._sum.onHand, 62);
  await reconciled();
  writeFileSync('reports/day22-persistent-fleet.json', JSON.stringify({ capturedAt: new Date().toISOString(), observedWaits, state, reconciled: true }, null, 2));
});

test('take event failure rolls every vehicle pose, claim, phase and stock back; duplicate proposal and takeover are fenced', async () => {
  await init(); await service.assign(scope, await input());
  let prepared;
  for (let i = 0; i < 150; i++) { prepared = await service.prepare(scope.warehouseId); if (prepared.proposal.effects.length) break; await service.commit(prepared); }
  assert.equal(prepared.proposal.effects[0].stage, 'take');
  const before = await snapshot();
  await db.$executeRawUnsafe(`CREATE FUNCTION day22_fail_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."warehouseId"='${scope.warehouseId}'::uuid AND NEW.kind='FLEET_TICK' THEN RAISE EXCEPTION 'injected batch rollback'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER day22_fail_batch BEFORE INSERT ON "WarehouseEvent" FOR EACH ROW EXECUTE FUNCTION day22_fail_batch()');
  try { await assert.rejects(service.commit(prepared)); assert.deepEqual(await snapshot(), before); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER day22_fail_batch ON "WarehouseEvent"'); await db.$executeRawUnsafe('DROP FUNCTION day22_fail_batch()'); }
  await service.commit(prepared); await assert.rejects(service.commit(prepared), { status: 409 });
  assert.equal(await other.prepare(scope.warehouseId), null);
  const obsolete = await service.prepare(scope.warehouseId);
  await db.$executeRaw`UPDATE "WarehouseRuntime" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE "warehouseId"=${scope.warehouseId}::uuid`;
  const takeover = await other.prepare(scope.warehouseId);
  assert.ok(takeover.epoch > obsolete.epoch);
  await other.commit(takeover); await assert.rejects(service.commit(obsolete), { status: 409 });
  const carrying = await other.read(scope); assert.equal(carrying.robots[0].carrying, true);
  await other.onModuleDestroy();
  const resumed = await service.prepare(scope.warehouseId); assert.equal(resumed.tick, carrying.tick);
  await service.commit(resumed);
  for (let i = 0; i < 150 && (await service.read(scope)).robots[0].phase !== 'COMPLETED'; i++) await service.advance();
  assert.equal((await service.read(scope)).robots[0].phase, 'COMPLETED');
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 2);
  await reconciled();
});

test('three concurrent shared-QC tasks preserve honest head-on waiting and cargo instead of fabricating completion', async () => {
  await init();
  const qc = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, kind: 'QC' } });
  for (const [robotId, code] of [['robot-1', 'R02-3-L1'], ['robot-2', 'R02-1-L1'], ['robot-3', 'R02-2-L1']]) {
    const receipt = await inbound.create(scope, { ...cmd(), skuId: batch.skuId, batchCode: batch.code, quantity: 1, qcLocationId: qc.id, producedAt: null, expiresAt: batch.expiresAt.toISOString() });
    await inbound.phase(scope, receipt.id, 'receive', cmd()); await inbound.phase(scope, receipt.id, 'inspect', { ...cmd(), decision: 'PASS' });
    const target = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, code } });
    await service.assign(scope, { kind: 'PUTAWAY', robotId, inboundOrderId: receipt.id, targetLocationId: target.id, reason: 'Day22 putaway' });
  }
  let state = await service.read(scope);
  for (let i = 0; i < 200 && !state.robots.every((r) => r.phase === 'COMPLETED'); i++) { await service.advance(); const next = await service.read(scope); safe(state, next); state = next; }
  assert.ok(state.robots.some((r) => r.waitTicks > 0 && r.waitReason), JSON.stringify(state));
  assert.ok(state.robots.some((r) => r.carrying));
  assert.ok(state.robots.every((r) => r.phase !== 'ERROR'));
  assert.equal((await db.inventoryBalance.aggregate({ where: { warehouseId: scope.warehouseId }, _sum: { onHand: true } }))._sum.onHand, 65);
  await reconciled();
  writeFileSync('reports/day22-qc-wait.json', JSON.stringify({ capturedAt: new Date().toISOString(), state, reconciled: true, completedAll: false }, null, 2));
});

test('three different vehicles each finish a QC putaway with durable stock and ownership, sequenced to avoid the shared-QC deadlock', async () => {
  await init();
  const qc = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, kind: 'QC' } });
  for (const [robotId, code] of [['robot-1', 'R02-3-L1'], ['robot-2', 'R02-1-L1'], ['robot-3', 'R02-2-L1']]) {
    const receipt = await inbound.create(scope, { ...cmd(), skuId: batch.skuId, batchCode: batch.code, quantity: 1, qcLocationId: qc.id, producedAt: null, expiresAt: batch.expiresAt.toISOString() });
    await inbound.phase(scope, receipt.id, 'receive', cmd()); await inbound.phase(scope, receipt.id, 'inspect', { ...cmd(), decision: 'PASS' });
    const target = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, code } });
    await service.assign(scope, { kind: 'PUTAWAY', robotId, inboundOrderId: receipt.id, targetLocationId: target.id, reason: 'Day22 sequential putaway' });
    let state = await service.read(scope);
    for (let i = 0; i < 150 && state.robots.find((r) => r.id === robotId).phase !== 'COMPLETED'; i++) { await service.advance(); const next = await service.read(scope); safe(state, next); state = next; }
    assert.equal(state.robots.find((r) => r.id === robotId).phase, 'COMPLETED', JSON.stringify(state));
    await reconciled();
  }
  assert.equal(await db.fleetClaim.count({ where: { warehouseId: scope.warehouseId, active: true } }), 0);
  assert.deepEqual((await db.inventoryBalance.aggregate({ where: { warehouseId: scope.warehouseId }, _sum: { onHand: true, reserved: true } }))._sum, { onHand: 65, reserved: 0 });
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'putaway:' } } }), 6);
  await reconciled();
});

test('revocation after pickup stops the batch while retaining physical transit cargo, loaded claim and occupied cell', async () => {
  await init(); await service.assign(scope, await input());
  let prepared;
  for (let i = 0; i < 150; i++) { prepared = await service.prepare(scope.warehouseId); await service.commit(prepared); if (prepared.proposal.effects.some((e) => e.stage === 'take')) break; }
  const carrying = await service.read(scope); assert.equal(carrying.robots[0].carrying, true);
  await db.warehouseAccess.update({ where: { userId_spaceId_warehouseId: { userId: scope.actorId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } }, data: { role: 'VIEWER' } });
  await service.advance();
  const stopped = await service.read(scope);
  assert.equal(stopped.robots[0].phase, 'ERROR'); assert.equal(stopped.robots[0].carrying, true);
  assert.deepEqual(stopped.robots[0].to, carrying.robots[0].to);
  assert.equal(stopped.tick, carrying.tick);
  assert.equal(await db.fleetClaim.count({ where: { warehouseId: scope.warehouseId, active: true, loaded: true } }), 1);
  await reconciled();
});

// Day23: physical permits share the persisted fleet checkpoint and warehouse fence.
const resourceCommand = (resources) => ({ resources, reason: 'Day23 isolated resource configuration' });
test('resource configuration is scoped, validated, idempotent, single-capacity and cannot reset existing permits', async () => {
  const state = await init();
  const resources = [
    { id: 'park', kind: 'PARKING', cells: [state.robots[0].to] },
    { id: 'charger', kind: 'CHARGING', cells: [state.robots[1].to] },
    { id: 'work', kind: 'WORKSTATION', cells: [{ x: 27, z: 3 }] },
    { id: 'aisle', kind: 'AISLE', cells: [{ x: 0, z: 0 }, { x: 1, z: 0 }] },
  ];
  await assert.rejects(service.configure(viewer, resourceCommand(resources)), { status: 403 });
  await assert.rejects(service.configure({ ...scope, spaceId: ids.spaceB }, resourceCommand(resources)), { status: 404 });
  await assert.rejects(service.configure(scope, { ...resourceCommand(resources), actorId: scope.actorId }), { status: 400 });
  await assert.rejects(service.configure(scope, resourceCommand([{ ...resources[0], cells: [{ x: 999, z: 0 }] }])), { status: 400 });
  await assert.rejects(service.configure(scope, resourceCommand([{ ...resources[0], cells: [{ x: 500, z: 0 }] }])), { status: 409 });
  await assert.rejects(service.configure(scope, resourceCommand([resources[0], { ...resources[0], id: 'duplicate' }])), { status: 409 });
  const result = await service.configure(scope, resourceCommand(resources));
  assert.equal(result.resources.length, 4); assert.equal(result.resources.find((r) => r.id === 'park').ownerId, 'robot-1');
  const seq = result.watermark;
  assert.equal((await other.configure(scope, resourceCommand([...resources].reverse()))).watermark, seq);
  await assert.rejects(service.configure(scope, resourceCommand([resources[0]])), { status: 409 });
  assert.deepEqual((await other.read(scope)).resources, result.resources);
  await reconciled();
});
test('permit and position/event roll back together; expired runner lease cannot release a faulted car in the corridor', async () => {
  const successor = new FleetService(secondDb); // Day22 deliberately destroyed `other`; use a live new runner.
  await init(); const body = await input();
  const row = await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } });
  const state = row.fleet.state, start = state.robots[0].simulation.robot.position, map = state.robots[0].simulation.map;
  const allocation = await db.allocation.findUniqueOrThrow({ where: { id: body.allocationId } });
  const placement = await db.layoutLocation.findFirstOrThrow({ where: { layoutId: map.layoutId, locationId: allocation.locationId } });
  const { findPath } = await import('../../packages/simulation/dist/index.js');
  const route = findPath({ ...map, walkable: (p) => p.x >= 0 && p.z >= 0 && p.x < map.width && p.z < map.depth && !map.blocked.some((b) => b.x === p.x && b.z === p.z) }, start, { x: placement.serviceX, z: placement.serviceZ });
  assert.equal(route.status, 'found'); assert.ok(route.path.length > 2);
  await service.configure(scope, resourceCommand([{ id: 'corridor', kind: 'AISLE', cells: route.path.slice(0, 2) }]));
  await service.assign(scope, body);
  const prepared = await service.prepare(scope.warehouseId), before = await snapshot();
  await db.$executeRawUnsafe(`CREATE FUNCTION day23_fail_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."warehouseId"='${scope.warehouseId}'::uuid AND NEW.kind='FLEET_TICK' THEN RAISE EXCEPTION 'injected resource rollback'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER day23_fail_batch BEFORE INSERT ON "WarehouseEvent" FOR EACH ROW EXECUTE FUNCTION day23_fail_batch()');
  try { await assert.rejects(service.commit(prepared)); assert.deepEqual(await snapshot(), before); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER day23_fail_batch ON "WarehouseEvent"'); await db.$executeRawUnsafe('DROP FUNCTION day23_fail_batch()'); }
  await db.$executeRaw`UPDATE "WarehouseRuntime" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE "warehouseId"=${scope.warehouseId}::uuid`;
  assert.equal((await successor.read(scope)).resources[0].ownerId, 'robot-1');
  const takeover = await successor.prepare(scope.warehouseId); assert.ok(takeover.epoch > prepared.epoch);
  await successor.commit(takeover); await assert.rejects(service.commit(prepared), { status: 409 });
  assert.equal((await successor.read(scope)).resources[0].ownerId, 'robot-1');
  await db.warehouseAccess.update({ where: { userId_spaceId_warehouseId: { userId: scope.actorId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } }, data: { role: 'VIEWER' } });
  await successor.advance(); const fault = await successor.read(scope);
  assert.equal(fault.robots[0].phase, 'ERROR'); assert.equal(fault.resources[0].ownerId, 'robot-1');
  for (let i = 0; i < 10; i++) await successor.advance();
  assert.deepEqual((await successor.read(scope)).resources, fault.resources); await reconciled();
  await successor.onModuleDestroy();
});
test('actual departure releases parking but completed endpoint keeps its workstation permit and reconciled stock', async () => {
  const state = await init();
  const placement = await db.layoutLocation.findFirstOrThrow({ where: { layoutId: state.layoutId, locationId: staging.id } });
  await service.configure(scope, resourceCommand([{ id: 'park', kind: 'PARKING', cells: [state.robots[0].to] },
    { id: 'station', kind: 'WORKSTATION', cells: [{ x: placement.serviceX, z: placement.serviceZ }] }]));
  await service.assign(scope, await input());
  for (let i = 0; i < 150 && (await service.read(scope)).robots[0].phase !== 'COMPLETED'; i++) await service.advance();
  const completed = await service.read(scope); assert.equal(completed.robots[0].phase, 'COMPLETED');
  assert.equal(completed.resources.find((r) => r.id === 'park').ownerId, null);
  assert.equal(completed.resources.find((r) => r.id === 'station').ownerId, 'robot-1');
  assert.equal(await other.prepare(scope.warehouseId), null);
  assert.equal((await other.read(scope)).resources.find((r) => r.id === 'station').ownerId, 'robot-1');
  await reconciled();
});
test('corrupted ghost permits fail closed and read-only reconciliation detects their mismatch', async () => {
  const state = await init(); await service.configure(scope, resourceCommand([{ id: 'park', kind: 'PARKING', cells: [state.robots[0].to] }]));
  const row = await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } });
  const bad = JSON.parse(JSON.stringify(row.fleet)); bad.state.resources[0].ownerId = 'robot-2';
  await db.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { fleet: bad } }); // Deliberate corruption fixture only.
  try {
    await assert.rejects(service.read(scope), { status: 409 });
    const result = await db.$transaction((tx) => reconcileWarehouse(tx, scope));
    assert.equal(result.consistent, false); assert.ok(result.reservationMismatches.some((r) => r.kind === 'FLEET_RESOURCE' || Object.values(r).includes('FLEET_RESOURCE')));
  } finally { await db.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { fleet: row.fleet } }); }
  await reconciled();
});

// Day24 closures and bounded replanning never mutate warehouse layout or inventory by themselves.
const mapCommand = (cells, closed, expectedRevision = 0) => ({ cells, closed, expectedRevision, reason: 'Day24 isolated closure test' });
test('closure commands are scoped, revisioned, idempotent and reject current occupancy or confirmed segments', async () => {
  const state = await init();
  await assert.rejects(service.changeMap(viewer, mapCommand([{ x: 0, z: 0 }], true)), { status: 403 });
  await assert.rejects(service.changeMap({ ...scope, spaceId: ids.spaceB }, mapCommand([{ x: 0, z: 0 }], true)), { status: 404 });
  await assert.rejects(service.changeMap(scope, { ...mapCommand([{ x: 0, z: 0 }], true), actorId: scope.actorId }), { status: 400 });
  await assert.rejects(service.changeMap(scope, mapCommand([state.robots[0].to], true)), { status: 409 });
  const saved = await service.changeMap(scope, mapCommand([{ x: 0, z: 0 }], true));
  assert.equal(saved.navigation.revision, 1); assert.deepEqual(saved.robots.map((r) => r.to), state.robots.map((r) => r.to));
  assert.equal((await service.changeMap(scope, mapCommand([{ x: 0, z: 0 }], true, 1))).watermark, saved.watermark);
  await assert.rejects(service.changeMap(scope, mapCommand([{ x: 0, z: 0 }], false, 0)), { status: 409 });
  await service.changeMap(scope, mapCommand([{ x: 0, z: 0 }], false, 1));
  await service.assign(scope, await input()); await service.advance();
  const moving = await service.read(scope); assert.notDeepEqual(moving.robots[0].from, moving.robots[0].to);
  await assert.rejects(service.changeMap(scope, mapCommand([moving.robots[0].from], true, 2)), { status: 409 });
  await reconciled();
});
test('closure event failure rolls back the map; carrying NO_PATH pauses retain cargo and reject old proposals, reopening resumes exactly once', async () => {
  await init(); await service.assign(scope, await input());
  let state;
  for (let i = 0; i < 150; i++) { await service.advance(); state = await service.read(scope); if (state.robots[0].carrying) break; }
  assert.equal(state.robots[0].carrying, true);
  const endpoint = await db.layoutLocation.findFirstOrThrow({ where: { layoutId: state.layoutId, locationId: staging.id } });
  const cell = { x: endpoint.serviceX, z: endpoint.serviceZ }, old = await service.prepare(scope.warehouseId), before = await snapshot();
  await db.$executeRawUnsafe(`CREATE FUNCTION day24_fail_map() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."warehouseId"='${scope.warehouseId}'::uuid AND NEW.kind='FLEET_NAVIGATION_CHANGED' THEN RAISE EXCEPTION 'injected closure rollback'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER day24_fail_map BEFORE INSERT ON "WarehouseEvent" FOR EACH ROW EXECUTE FUNCTION day24_fail_map()');
  try { await assert.rejects(service.changeMap(scope, mapCommand([cell], true))); assert.deepEqual(await snapshot(), before); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER day24_fail_map ON "WarehouseEvent"'); await db.$executeRawUnsafe('DROP FUNCTION day24_fail_map()'); }
  state = await service.changeMap(scope, mapCommand([cell], true));
  assert.equal(state.navigation.revision, 1); assert.equal(state.robots[0].navigationIssue.reason, 'NO_PATH');
  await assert.rejects(service.commit(old), { status: 409 });
  const pose = state.robots[0].to, battery = state.robots[0].battery;
  for (let i = 0; i < 20; i++) await service.advance();
  state = await service.read(scope); assert.deepEqual(state.robots[0].to, pose); assert.equal(state.robots[0].battery, battery); assert.equal(state.robots[0].carrying, true);
  assert.equal(await db.fleetClaim.count({ where: { warehouseId: scope.warehouseId, active: true, loaded: true } }), 1);
  const successor = new FleetService(secondDb);
  await db.$executeRaw`UPDATE "WarehouseRuntime" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE "warehouseId"=${scope.warehouseId}::uuid`;
  const takeover = await successor.prepare(scope.warehouseId); await successor.commit(takeover);
  assert.equal((await successor.read(scope)).robots[0].navigationIssue.reason, 'NO_PATH'); await successor.onModuleDestroy();
  await reconciled();
  await service.changeMap(scope, mapCommand([cell], false, 1));
  for (let i = 0; i < 150 && (await service.read(scope)).robots[0].phase !== 'COMPLETED'; i++) await service.advance();
  assert.equal((await service.read(scope)).robots[0].phase, 'COMPLETED');
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 2);
  await reconciled();
});
test('a real full-width cut pauses before pickup without a fake route, then reopening restores the same claim', async () => {
  await init(); await service.assign(scope, await input());
  const row = await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } });
  const map = row.fleet.state.robots[0].simulation.map;
  const cut = Array.from({ length: map.width }, (_, x) => ({ x, z: 8 })).filter((p) => !map.blocked.some((b) => b.x === p.x && b.z === p.z));
  const paused = await service.changeMap(scope, mapCommand(cut, true));
  assert.equal(paused.robots[0].navigationIssue.reason, 'NO_PATH'); assert.equal(paused.robots[0].carrying, false);
  for (let i = 0; i < 5; i++) await service.advance();
  assert.deepEqual((await service.read(scope)).robots[0].to, paused.robots[0].to);
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 0);
  await reconciled();
  const resumed = await service.changeMap(scope, mapCommand(cut, false, 1));
  assert.equal(resumed.robots[0].taskId, paused.robots[0].taskId); assert.equal(resumed.robots[0].navigationIssue, null);
  await reconciled();
});
// Day25: software fault controls serialize against take/drop and preserve ledger ownership.
const control = (s, action, robotId = 'robot-1') => ({ robotId, action, expectedTaskId: s.robots.find((r) => r.id === robotId).taskId, reason: 'Day25 controlled fault test' });
async function untilPhase(phase) {
  let s = await service.read(scope);
  for (let i = 0; i < 150 && s.robots[0].phase !== phase; i++) { await service.advance(); s = await service.read(scope); }
  assert.equal(s.robots[0].phase, phase); return s;
}
for (const phase of ['APPROACH', 'LOADING', 'TRANSPORT', 'UNLOADING']) test(`Day25 ${phase} fault retains pose/cargo/permits and repair completes original claim once`, async () => {
  const initial = await init(); await service.configure(scope, resourceCommand([{ id: 'park', kind: 'PARKING', cells: [initial.robots[0].to] }]));
  await service.assign(scope, await input()); const before = await untilPhase(phase), old = await service.prepare(scope.warehouseId);
  const paused = await service.control(scope, control(before, 'FAULT'));
  assert.equal(paused.tick, before.tick); assert.deepEqual(paused.robots[0].to, before.robots[0].to); assert.equal(paused.robots[0].carrying, ['TRANSPORT', 'UNLOADING'].includes(phase));
  assert.equal(paused.robots[0].recoveryStatus, paused.robots[0].carrying ? 'NEEDS_RECOVERY' : 'PAUSED');
  await assert.rejects(service.commit(old), { status: 409 });
  const raw = (await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } })).fleet;
  for (let i = 0; i < 12; i++) await service.advance();
  const still = await other.read(scope); assert.deepEqual(still.robots[0].to, paused.robots[0].to); assert.equal(still.robots[0].battery, paused.robots[0].battery);
  assert.equal(still.robots[0].taskId, paused.robots[0].taskId); assert.deepEqual(still.resources, paused.resources);
  assert.deepEqual((await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } })).fleet.state.robots[0].work, raw.state.robots[0].work);
  if (paused.robots[0].carrying) {
    await assert.rejects(service.control(scope, control(still, 'CANCEL')), { status: 409 });
    const claim = await db.fleetClaim.findUniqueOrThrow({ where: { id: still.robots[0].taskId } });
    await assert.rejects(db.transportTask.update({ where: { id: claim.taskId }, data: { phase: 'CANCELLED' } }));
  }
  await reconciled(); await service.control(scope, control(still, 'REPAIR'));
  const done = await untilPhase('COMPLETED'); assert.equal(done.robots[0].taskId, before.robots[0].taskId);
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 2);
  const snap = await snapshot(); await assert.rejects(service.control(scope, control(done, 'FAULT')), { status: 409 }); assert.deepEqual(await snapshot(), snap);
  assert.equal(await db.auditLog.count({ where: { warehouseId: scope.warehouseId, action: { in: ['FLEET_FAULT', 'FLEET_REPAIR'] } } }), 2); await reconciled();
});
for (const phase of ['APPROACH', 'LOADING']) test(`Day25 ${phase} cancellation atomically releases source and target reservations, keeps physical occupancy and tombstones`, async () => {
  const initial = await init(); await service.configure(scope, resourceCommand([{ id: 'park', kind: 'PARKING', cells: [initial.robots[0].to] }]));
  const body = await input(); await service.assign(scope, body); const before = await untilPhase(phase), old = await service.prepare(scope.warehouseId);
  const paused = await service.control(scope, control(before, 'FAULT'));
  const cancelled = await service.control(scope, control(paused, 'CANCEL'));
  assert.equal(cancelled.robots[0].phase, 'IDLE'); assert.equal(cancelled.robots[0].taskId, null); assert.ok(cancelled.robots[0].deviceFault);
  assert.deepEqual(cancelled.robots[0].to, before.robots[0].to); assert.deepEqual(cancelled.resources, before.resources);
  const claim = await db.fleetClaim.findUniqueOrThrow({ where: { id: before.robots[0].taskId } }); assert.equal(claim.active, false);
  assert.equal((await db.transportTask.findUniqueOrThrow({ where: { id: claim.taskId } })).phase, 'CANCELLED');
  assert.equal((await db.inventoryBalance.aggregate({ where: { warehouseId: scope.warehouseId }, _sum: { onHand: true, reserved: true } }))._sum.reserved, 0);
  const [capacity] = await db.$queryRaw`SELECT staging_reserved(${staging.id}::uuid) AS used`; assert.equal(Number(capacity.used), 0);
  await assert.rejects(service.commit(old), { status: 409 }); await assert.rejects(service.control(scope, control(paused, 'CANCEL')), { status: 409 });
  await assert.rejects(service.assign(scope, body), { status: 409 });
  await assert.rejects(new TransportService(db).take(scope, claim.taskId, 'reject cancelled task'), { status: 409 });
  await service.control(scope, control(cancelled, 'REPAIR')); await service.assign(scope, await input()); await untilPhase('COMPLETED'); await reconciled();
});
test('Day25 control is scoped and an audit/event failure rolls back fault or cancellation and its reservation effects', async () => {
  await init(); await service.assign(scope, await input()); const s = await service.read(scope), body = control(s, 'FAULT');
  await assert.rejects(service.control(viewer, body), { status: 403 });
  await assert.rejects(service.control({ ...scope, spaceId: ids.spaceB }, body), { status: 404 });
  await assert.rejects(service.control(scope, { ...body, actorId: scope.actorId }), { status: 400 });
  await assert.rejects(service.control(scope, { ...body, expectedTaskId: randomUUID() }), { status: 409 });
  const before = await snapshot(), audits = await db.auditLog.count({ where: { warehouseId: scope.warehouseId } });
  await db.$executeRawUnsafe(`CREATE FUNCTION day25_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."warehouseId"='${scope.warehouseId}'::uuid AND NEW.kind IN ('FLEET_FAULT','FLEET_CANCEL') THEN RAISE EXCEPTION 'injected recovery rollback'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER day25_fail BEFORE INSERT ON "WarehouseEvent" FOR EACH ROW EXECUTE FUNCTION day25_fail()');
  try {
    for (const action of ['FAULT', 'CANCEL']) { await assert.rejects(service.control(scope, { ...body, action })); assert.deepEqual(await snapshot(), before); }
    assert.equal(await db.auditLog.count({ where: { warehouseId: scope.warehouseId } }), audits);
    assert.equal((await db.transportTask.findFirstOrThrow({ where: { warehouseId: scope.warehouseId } })).phase, 'READY');
  } finally { await db.$executeRawUnsafe('DROP TRIGGER day25_fail ON "WarehouseEvent"'); await db.$executeRawUnsafe('DROP FUNCTION day25_fail()'); }
  await reconciled();
});
async function putawayInput() {
  const qc = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, kind: 'QC' } });
  const receipt = await inbound.create(scope, { ...cmd(), skuId: batch.skuId, batchCode: batch.code, quantity: 1, qcLocationId: qc.id, producedAt: null, expiresAt: batch.expiresAt.toISOString() });
  await inbound.phase(scope, receipt.id, 'receive', cmd()); await inbound.phase(scope, receipt.id, 'inspect', { ...cmd(), decision: 'PASS' });
  const target = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, code: 'R02-3-L1' } });
  return { kind: 'PUTAWAY', robotId: 'robot-1', inboundOrderId: receipt.id, targetLocationId: target.id, reason: 'Day25 putaway fixture' };
}
test('Day25 putaway cancellation frees QC and destination capacity without moving stock or deleting receipt history', async () => {
  await init(); const body = await putawayInput(); await service.assign(scope, body); const s = await service.read(scope);
  await service.control(scope, control(s, 'CANCEL'));
  const task = await db.putawayTask.findUniqueOrThrow({ where: { inboundOrderId: body.inboundOrderId } }); assert.equal(task.phase, 'CANCELLED');
  assert.equal((await db.inventoryBalance.aggregate({ where: { warehouseId: scope.warehouseId }, _sum: { onHand: true, reserved: true } }))._sum.reserved, 0);
  const [capacity] = await db.$queryRaw`SELECT staging_reserved(${body.targetLocationId}::uuid) AS used`; assert.equal(Number(capacity.used), 0);
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'putaway:' } } }), 0);
  await assert.rejects(service.assign(scope, body), { status: 409 }); await reconciled();
});
test('Day25 loaded putaway repair posts only one original drop; a second loaded fault remains persisted for real PG restart checks', async () => {
  await init(); await service.assign(scope, await putawayInput()); const s = await untilPhase('TRANSPORT');
  const paused = await service.control(scope, control(s, 'FAULT')); assert.equal(paused.robots[0].recoveryStatus, 'NEEDS_RECOVERY');
  await assert.rejects(service.control(scope, control(paused, 'CANCEL')), { status: 409 });
  await service.control(scope, control(paused, 'REPAIR')); await untilPhase('COMPLETED');
  assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'putaway:' } } }), 2);
  await service.assign(scope, await input()); const outboundState = await untilPhase('TRANSPORT'); await service.control(scope, control(outboundState, 'FAULT'));
  const successor = new FleetService(secondDb); await db.$executeRaw`UPDATE "WarehouseRuntime" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE "warehouseId"=${scope.warehouseId}::uuid`;
  const p = await successor.prepare(scope.warehouseId); await successor.commit(p); await successor.onModuleDestroy();
  const recovered = await service.read(scope); assert.equal(recovered.robots[0].recoveryStatus, 'NEEDS_RECOVERY'); assert.deepEqual(recovered.robots[0].to, outboundState.robots[0].to); await reconciled();
});

const chargeBody = (robotId, action = 'START') => ({ robotId, action, reason: 'Day26 isolated charge test' });
async function fixtureBattery(values) {
  const runtime = await db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } });
  for (const r of runtime.fleet.state.robots) if (values[r.id] !== undefined) r.simulation.robot.battery = values[r.id];
  await db.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { fleet: runtime.fleet } });
}

test('Day26 rejects insufficient budget and an unreachable dock without creating transport reservations or a claim', async () => {
  await init(); const body = await input();
  await fixtureBattery({ 'robot-1': 20 });
  const before = await snapshot();
  await assert.rejects(service.assign(scope, body), { status: 409 });
  assert.deepEqual(await snapshot(), before);
  assert.equal(await db.transportTask.count({ where: { warehouseId: scope.warehouseId } }), 0);
  await fixtureBattery({ 'robot-1': 10000 });
  const dock = { x: 0, z: 0 };
  await service.configure(scope, resourceCommand([{ id: 'dock', kind: 'CHARGING', cells: [dock] }]));
  await service.changeMap(scope, mapCommand([dock], true));
  const closed = await snapshot();
  await assert.rejects(service.assign(scope, body), { status: 409 });
  await assert.rejects(service.charge(scope, chargeBody('robot-1')), { status: 409 });
  assert.deepEqual(await snapshot(), closed); await reconciled();
});

test('Day26 charge arbitration persists one physical owner, clips at full, and records one stall alert in twenty-five ticks', async () => {
  const initial = await init(), dock = initial.robots[0].to;
  await service.configure(scope, resourceCommand([{ id: 'dock', kind: 'CHARGING', cells: [dock] }]));
  await fixtureBattery({ 'robot-1': 9751, 'robot-2': 9700 });
  await assert.rejects(service.charge(viewer, chargeBody('robot-1')), { status: 403 });
  await service.charge(scope, chargeBody('robot-1')); await service.charge(scope, chargeBody('robot-2'));
  const stable = await service.read(scope); assert.ok(stable.robots.every((r) => r.id === 'robot-3' || r.charge));
  const old = await service.prepare(scope.warehouseId);
  await service.charge(scope, chargeBody('robot-2', 'STOP'));
  await assert.rejects(service.commit(old), { status: 409 });
  await service.charge(scope, chargeBody('robot-2'));
  for (let i = 0; i < 25; i++) {
    await service.advance();
    const s = await service.read(scope);
    assert.equal(s.resources[0].ownerId, 'robot-1'); assert.notDeepEqual(s.robots[1].to, dock);
    if (i === 0) { assert.equal(s.robots[0].battery, 10000); assert.equal(s.robots[0].charge, null); }
  }
  const outcome = await other.read(scope);
  assert.equal(outcome.robots[1].waitReason, 'RESOURCE_BUSY');
  const expected = outcome.alerts.find((a) => a.robotId === 'robot-2'); assert.equal(expected.kind, 'NO_PROGRESS');
  const events = await db.warehouseEvent.findMany({ where: { warehouseId: scope.warehouseId, kind: 'FLEET_TICK' } });
  assert.deepEqual(events.flatMap((e) => e.payload.newAlerts), [expected]);
  assert.equal(await db.fleetClaim.count({ where: { warehouseId: scope.warehouseId } }), 0);
  await reconciled(); // Retain waiting charge plan for post-restart validation.
});

test('Day26 loaded low energy stops without cargo ledger writes, and publishes one durable energy alert', async () => {
  await init(); await service.assign(scope, await input());
  const picked = await untilPhase('TRANSPORT');
  await fixtureBattery({ 'robot-1': 1 });
  const before = await snapshot();
  for (let i = 0; i < 24; i++) await service.advance();
  const s = await service.read(scope), r = s.robots[0];
  assert.deepEqual(r.to, picked.robots[0].to); assert.equal(r.battery, 1);
  assert.equal(r.taskId, picked.robots[0].taskId); assert.equal(r.carrying, true); assert.equal(r.waitReason, 'ENERGY_LOW');
  assert.equal(s.alerts[0].kind, 'ENERGY_LOW');
  const after = await snapshot(); assert.deepEqual(after.claims, before.claims); assert.deepEqual(after.balances, before.balances); assert.equal(after.movements, before.movements);
  await assert.rejects(service.charge(scope, chargeBody('robot-1')), { status: 409 });
  const ticks = await db.warehouseEvent.findMany({ where: { warehouseId: scope.warehouseId, kind: 'FLEET_TICK' } });
  assert.deepEqual(ticks.flatMap((e) => e.payload.newAlerts), s.alerts);
  await reconciled();
});

function startFleetChild(t) {
  const child = fork(resolve(__dirname, 'fixtures/fleet-runner.cjs'), [], { windowsHide: true, execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let requestId = 0;
  const exited = new Promise((res) => {
    child.once('close', (code, signal) => res({ code, signal }));
    child.once('error', () => res({ code: -1, signal: null }));
  });
  async function response(match, send) {
    let timer, listener, closed, failed;
    try {
      return await new Promise((res, rej) => {
        listener = (message) => { if (match(message)) res(message); };
        closed = () => rej(new Error('Fleet child exited before IPC response'));
        failed = rej;
        child.on('message', listener); child.once('close', closed); child.once('error', failed);
        timer = setTimeout(() => rej(new Error('Fleet child IPC timeout')), 20000);
        if (send) child.send(send, (error) => { if (error) rej(error); });
      });
    } finally {
      clearTimeout(timer); child.off('message', listener); child.off('close', closed); child.off('error', failed);
    }
  }
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) assert.ok(child.kill('SIGKILL'));
    return exited;
  }
  t.after(stop);
  const ready = response((m) => m.ready === true).then((m) => assert.equal(m.pid, child.pid));
  return { pid: child.pid, ready, stop, async call(op, body) {
    const id = ++requestId, r = await response((m) => m.id === id, { id, op, scope, body });
    if (r.error) throw Object.assign(new Error(r.error.message), { status: r.error.status });
    return r.data;
  } };
}

test('Day27 five robots across actual process exits: durable claim, take and drop edges, natural lease takeover and exactly-once ledger', { timeout: 155000 }, async (t) => {
  const initial = await init(5), request = await input();
  const [allocation, dock] = await Promise.all([
    db.allocation.findUniqueOrThrow({ where: { id: request.allocationId } }),
    db.layoutLocation.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, locationId: staging.id } }),
  ]);
  const pickup = await db.layoutLocation.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, locationId: allocation.locationId } });
  await service.configure(scope, resourceCommand([
    { id: 'pickup', kind: 'WORKSTATION', cells: [{ x: pickup.serviceX, z: pickup.serviceZ }] },
    { id: 'drop', kind: 'WORKSTATION', cells: [{ x: dock.serviceX, z: dock.serviceZ }] },
  ]));
  const edges = [], recoveries = [];
  const row = () => db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } });
  const start = async () => { const child = startFleetChild(t); await child.ready; return child; };
  const durable = async () => {
    const s = await snapshot();
    const { fleet, tick, seq, version } = s.runtime;
    return { fleet, tick, seq, version, claims: s.claims, balances: s.balances, movements: s.movements, events: s.events };
  };
  const stopAt = async (child, edge) => {
    const r = await row(), from = await durable(), status = await child.stop();
    assert.equal(status.signal, 'SIGKILL');
    assert.deepEqual(await durable(), from, edge + ' changed committed state on exit');
    const raw = await row();
    assert.equal(raw.ownerId, r.ownerId); assert.equal(raw.epoch, r.epoch); assert.deepEqual(raw.leaseUntil, r.leaseUntil);
    edges.push({ edge, pid: child.pid, signal: status.signal, tick: r.tick, epoch: r.epoch, watermark: r.seq,
      claims: from.claims.map((c) => ({ robot: c.robotId, active: c.active, loaded: c.loaded })),
      permits: r.fleet.state.resources.map((r) => [r.id, r.ownerId]) });
  };
  const acquire = async (child, before) => {
    const baseline = await durable();
    const deadline = Date.now() + 12000;
    let p;
    do { p = await child.call('prepare'); if (!p) await delay(125); } while (!p && Date.now() < deadline);
    assert.ok(p, 'lease did not expire naturally');
    assert.equal(p.tick, before.tick);
    assert.equal(p.version, before.version); assert.equal(p.epoch, before.epoch + 1);
    assert.notEqual(p.ownerId, before.ownerId);
    assert.deepEqual(await durable(), baseline, 'preparation changed committed state');
    recoveries.push({ recoveredTick: p.tick, firstCommitTick: null, oldEpoch: before.epoch, newEpoch: p.epoch });
    return p;
  };
  const commit = async (child, prepared) => {
    await child.call('commit');
    const current = await row();
    assert.equal(current.tick, prepared.tick + 1); assert.equal(current.epoch, prepared.epoch);
    const recent = recoveries.at(-1);
    if (recent && recent.newEpoch === prepared.epoch && recent.firstCommitTick === null) recent.firstCommitTick = current.tick;
  };
  const seek = async (child, select, first) => {
    for (let i = 0; i < 100; i++) {
      const p = i === 0 && first ? first : await child.call('prepare');
      assert.ok(p, 'runner unexpectedly inactive');
      if (await select(p)) return p;
      await commit(child, p);
    }
    assert.fail('edge not reached');
  };
  const effect = (c, stage) => (p) => p.effects.some((e) => e.taskId === c.id && e.stage === stage);
  let child = await start();
  assert.equal(await db.fleetClaim.count({ where: { warehouseId: scope.warehouseId } }), 0);
  await stopAt(child, 'before-claim'); // The fixture has not sent the assignment command.
  child = await start();
  const claim = await child.call('assign', request);
  assert.equal((await service.read(scope)).robots[0].taskId, claim.id);
  await stopAt(child, 'after-claim');
  child = await start();
  assert.equal((await child.call('assign', request)).id, claim.id);
  const beforeTake = await seek(child, effect(claim, 'take'));
  assert.equal((await service.read(scope)).robots[0].carrying, false);
  const contender = await start();
  assert.equal(await contender.call('prepare'), null, 'live lease admitted a second runner');
  const takeover = await acquire(contender, await row());
  assert.equal(takeover.tick, beforeTake.tick); assert.ok(effect(claim, 'take')(takeover));
  const fenced = await durable();
  await assert.rejects(child.call('commit'), { status: 409 });
  assert.deepEqual(await durable(), fenced);
  assert.equal((await child.stop()).signal, 'SIGKILL');
  const preTakeRow = await row();
  await stopAt(contender, 'before-take'); // Replacement also dies holding the uncommitted take proposal.
  child = await start();
  const take = await acquire(child, preTakeRow);
  assert.ok(effect(claim, 'take')(take)); await commit(child, take);
  assert.equal((await service.read(scope)).robots[0].carrying, true);
  const postTakeRow = await row();
  await stopAt(child, 'after-take');
  child = await start();
  const fromTake = await acquire(child, postTakeRow); await commit(child, fromTake);
  for (let i = 0; i < 100 && (await service.read(scope)).robots[0].phase !== 'UNLOADING'; i++) {
    await commit(child, await child.call('prepare'));
  }
  assert.equal((await service.read(scope)).robots[0].phase, 'UNLOADING');
  const second = await child.call('assign', { ...await putawayInput(), robotId: 'robot-2' });
  const drop = await seek(child, effect(claim, 'drop'));
  assert.equal(await db.fleetClaim.count({ where: { warehouseId: scope.warehouseId, active: true } }), 2);
  const preDropRow = await row();
  await stopAt(child, 'before-drop');
  child = await start();
  const retryDrop = await acquire(child, preDropRow);
  assert.ok(effect(claim, 'drop')(retryDrop)); assert.equal(retryDrop.tick, drop.tick);
  await commit(child, retryDrop);
  const dropped = await service.read(scope);
  assert.equal(dropped.robots[0].phase, 'COMPLETED'); assert.equal(dropped.robots[0].carrying, false);
  assert.equal(dropped.resources.find((r) => r.id === 'drop').ownerId, 'robot-1');
  const postDropRow = await row();
  await stopAt(child, 'after-drop');
  child = await start();
  const fromDrop = await acquire(child, postDropRow); await commit(child, fromDrop);
  for (let i = 0; i < 120; i++) {
    const p = await child.call('prepare'); if (!p) break; await commit(child, p);
  }
  const final = await service.read(scope);
  assert.deepEqual(final.robots.map((r) => r.phase), ['COMPLETED', 'COMPLETED', 'IDLE', 'IDLE', 'IDLE']);
  assert.deepEqual(final.robots.slice(0, 2).map((r) => r.taskId), [claim.id, second.id]);
  assert.ok(final.robots.every((r) => !r.carrying));
  assert.equal((await child.stop()).signal, 'SIGKILL');
  const movements = await db.inventoryMovement.findMany({ where: { warehouseId: scope.warehouseId, OR: [
    { businessKey: { startsWith: 'transport:' } }, { businessKey: { startsWith: 'putaway:' } }] }, select: { businessKey: true } });
  assert.deepEqual(movements.map((m) => m.businessKey).sort(),
    ['take', 'drop'].flatMap((stage) => ['transport:' + claim.taskId + ':' + stage, 'putaway:' + second.taskId + ':' + stage]).sort());
  const allClaims = await db.fleetClaim.findMany({ where: { warehouseId: scope.warehouseId } });
  assert.equal(allClaims.length, 2); assert.ok(allClaims.every((c) => !c.active && !c.loaded));
  const events = await db.warehouseEvent.findMany({ where: { warehouseId: scope.warehouseId }, orderBy: { seq: 'asc' } });
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: final.watermark }, (_, i) => i + 1));
  assert.equal(events.filter((e) => e.kind === 'FLEET_ASSIGNED').length, 2);
  const ticks = events.filter((e) => e.kind === 'FLEET_TICK');
  assert.deepEqual(ticks.map((e) => e.payload.tick), Array.from({ length: final.tick }, (_, i) => i + 1));
  let last = new Map(initial.robots.map((r) => [r.id, r.to]));
  const walls = (await row()).fleet.state.robots[0].simulation.map.blocked;
  const cell = (p) => p.x + ':' + p.z;
  for (const { payload } of ticks) {
    const positions = payload.robots.map((r) => cell(r.cell));
    assert.equal(positions.length, 5); assert.equal(new Set(positions).size, 5);
    for (const r of payload.robots) {
      const p = last.get(r.id);
      assert.ok(Math.abs(p.x - r.cell.x) + Math.abs(p.z - r.cell.z) <= 1);
      assert.ok(!walls.some((p) => cell(p) === cell(r.cell)));
      for (const [otherId, otherCell] of last) if (otherId !== r.id) assert.notEqual(cell(r.cell), cell(otherCell));
    }
    for (const p of payload.resources) {
      const owners = payload.robots.filter((r) => p.cells.some((c) => cell(c) === cell(r.cell)));
      assert.ok(owners.length <= 1); assert.equal(p.ownerId, owners[0]?.id ?? null);
    }
    last = new Map(payload.robots.map((r) => [r.id, r.cell]));
  }
  await reconciled();
  writeFileSync(resolve(__dirname, '../../reports/day27-process-restart.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), edges, recoveries, liveLeaseDenied: true, staleCommitStatus: 409,
    robots: final.robots.length, finalTick: final.tick, watermark: final.watermark, claims: allClaims.length, movements: movements.length,
    collisionTicks: ticks.length, reconciled: true,
  }, null, 2));
});
