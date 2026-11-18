const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
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
