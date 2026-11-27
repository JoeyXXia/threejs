const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { PrismaClient, reconcileWarehouse } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { CountService } = require('../../apps/api/dist/count/count.service');
const { FleetService } = require('../../apps/api/dist/simulation/fleet.service');
const { InboundService } = require('../../apps/api/dist/inbound/inbound.service');
const { OutboundService } = require('../../apps/api/dist/outbound/outbound.service');
const { TransportService } = require('../../apps/api/dist/transport/transport.service');

const url = process.env.INBOUND_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/warehouse_twin_inbound_test') throw new Error('Isolated DB required');
const [left, right, observer] = Array.from({ length: 3 }, () => new PrismaClient({ datasourceUrl: url }));
const note = 'Day38 concurrent WMS fixture';
const cmd = () => ({ key: randomUUID(), reason: note });
const rounds = 4, evidence = [];
const injectedRollback = new Error('Day38 rollback after all dispatch writes');

// Only the test controls when the real Prisma transaction callback may return.
function endpoint(client) {
  const edge = { hook: undefined };
  const transact = (work, options) => client.$transaction(async (tx) => {
      const hook = edge.hook;
      if (!hook) return work(tx);
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      hook.pid.resolve(pid);
      const result = await work(tx);
      await hook.after?.(tx);
      return result;
  }, options);
  const db = new Proxy(client, { get(target, key) {
    if (key === '$transaction') return transact;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return Object.assign(edge, { inbound: new InboundService(db), outbound: new OutboundService(db), transport: new TransportService(db),
    count: new CountService(db), fleet: new FleetService(db) });
}
const a = endpoint(left), b = endpoint(right);
const settled = (work) => Promise.resolve().then(work).then((value) => ({ value }), (error) => ({ error }));
const signalBeforeExit = (signal, result, label) => Promise.race([signal.promise, result.then((outcome) => {
  throw outcome.error ?? new Error(`${label} returned before barrier`);
})]);
let observedWaits = 0;

async function race(first, second, options = {}) {
  const staged = Promise.withResolvers(), release = Promise.withResolvers();
  const lead = { pid: Promise.withResolvers(), async after(tx) {
    await options.inLeader?.(tx);
    staged.resolve(); await release.promise;
    if (options.rollback) throw injectedRollback;
  } };
  const follow = { pid: Promise.withResolvers(), after: options.afterFollower };
  a.hook = lead; b.hook = follow;
  const head = settled(first);
  let tail;
  try {
    await signalBeforeExit(staged, head, 'leader');
    const holding = await lead.pid.promise;
    tail = settled(second);
    const waiting = await signalBeforeExit(follow.pid, tail, 'follower');
    assert.notEqual(holding, waiting);
    const deadline = Date.now() + 4000;
    let blocked = false;
    do {
      const [row] = await observer.$queryRaw`SELECT ${holding}::int = ANY(pg_blocking_pids(${waiting}::int)) AS blocked`;
      blocked = row.blocked;
      if (!blocked) await delay(25);
    } while (!blocked && Date.now() < deadline);
    assert.ok(blocked, 'PostgreSQL never observed the follower blocked by the real leader transaction');
    observedWaits++;
    await options.during?.();
  } finally {
    release.resolve();
    await Promise.all([head, tail]);
    a.hook = undefined; b.hook = undefined;
  }
  return [await head, await tail];
}

function ok(outcome) { assert.equal(outcome.error, undefined); return outcome.value; }
function conflict(outcome) { assert.equal(outcome.error?.getStatus?.(), 409, String(outcome.error)); }

async function fixture(label) {
  const admin = await observer.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
  const where = { spaceId: ids.spaceA, warehouseId: randomUUID() }, scope = { ...where, actorId: admin.id };
  await observer.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: where.warehouseId, spaceId: where.spaceId, name: `Day38 ${label}` } });
    await seedInventory(tx, where.spaceId, where.warehouseId);
    await tx.warehouseAccess.create({ data: { ...where, userId: admin.id, role: 'ADMIN' } });
  });
  const batch = await observer.batch.findFirstOrThrow({ where: { ...where, sku: { code: 'SKU-A' } } });
  const stage = await observer.location.findFirstOrThrow({ where: { ...where, kind: 'OUTBOUND' } });
  const opening = await observer.inventoryBalance.aggregate({ where: { ...where, batchId: batch.id, quality: 'RELEASED' }, _sum: { onHand: true } });
  return { where, scope, batch, stage, available: opening._sum.onHand };
}

const newOrder = (f, quantity = 1) => a.outbound.create(f.scope, { ...cmd(), skuId: f.batch.skuId, batchId: f.batch.id, quantity });
const reserve = async (f) => a.outbound.allocate(f.scope, (await newOrder(f)).id, cmd());
const createTask = (f, allocationId, side = a) => side.transport.create(f.scope, allocationId, f.stage.id, note);
const stock = async (f) => (await observer.inventoryBalance.aggregate({ where: f.where, _sum: { onHand: true, reserved: true } }))._sum;
const moves = (f) => observer.inventoryMovement.findMany({ where: { ...f.where, kind: { not: 'OPENING' } }, orderBy: { businessKey: 'asc' } });
const keys = async (f) => (await moves(f)).map((row) => row.businessKey).sort();
const capacityUsed = async (f) => (await observer.$queryRaw`SELECT staging_reserved(${f.stage.id}::uuid) AS used`)[0].used;
const orders = (f) => observer.outboundOrder.findMany({ where: f.where, orderBy: { id: 'asc' } });
const outbox = (f, tx = observer) => tx.dispatchReportJob.findMany({ where: { warehouseId: f.where.warehouseId }, orderBy: { sourceSeq: 'asc' } });
const events = (f) => observer.warehouseEvent.findMany({ where: f.where, orderBy: { seq: 'asc' } });
async function scopedSnapshot(f) {
  const balances = await observer.inventoryBalance.findMany({ where: f.where, orderBy: { id: 'asc' } });
  return { balances, orders: await orders(f), moves: await moves(f), events: await events(f), outbox: await outbox(f),
    tasks: await observer.transportTask.findMany({ where: f.where, orderBy: { id: 'asc' } }),
    audits: await observer.auditLog.findMany({ where: f.where, orderBy: { id: 'asc' } }),
    commands: await observer.idempotencyRecord.findMany({ where: f.where, orderBy: { id: 'asc' } }) };
}
async function reconciled(f) {
  const result = await observer.$transaction((tx) => reconcileWarehouse(tx, f.where), { isolationLevel: 'RepeatableRead' });
  assert.deepEqual(result, { consistent: true, mismatches: [], reservationMismatches: [] });
  const track = await events(f);
  assert.deepEqual(track.map((e) => e.seq), track.map((_, i) => i + 1));
  const runtime = await observer.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: f.where.warehouseId } });
  assert.equal(track.length, runtime.seq);
}

function repeated(id, scenario) {
  test(`Day38 ${id} four isolated rounds`, { timeout: 100000 }, async () => {
    for (let round = 1; round <= rounds; round++) {
      const blockedBefore = observedWaits;
      evidence.push({ id, round, ...await scenario(round), blockedWindows: observedWaits - blockedBefore });
    }
  });
}

repeated('T02', async (round) => {
  const f = await fixture(`T02-${round}`);
  const qc = await observer.location.findFirstOrThrow({ where: { ...f.where, kind: 'QC' } });
  const receipt = await a.inbound.create(f.scope, { ...cmd(), skuId: f.batch.skuId, batchCode: `D38-${round}`, qcLocationId: qc.id,
    producedAt: null, expiresAt: null, quantity: 2 });
  const receive = cmd();
  const [r1, r2] = await race(() => a.inbound.phase(f.scope, receipt.id, 'receive', receive), () => b.inbound.phase(f.scope, receipt.id, 'receive', receive));
  assert.deepEqual(ok(r1), ok(r2));
  assert.equal(ok(r1).status, 'RECEIVED');
  const o = await reserve(f), task = await createTask(f, o.allocations[0].id);
  for (const stage of ['take', 'drop']) {
    const [p, q] = await race(() => a.transport[stage](f.scope, task.id, note), () => b.transport[stage](f.scope, task.id, note));
    assert.equal(ok(p).phase, stage === 'take' ? 'IN_TRANSIT' : 'STAGED'); assert.equal(ok(q).phase, ok(p).phase);
  }
  const dispatch = cmd();
  const [d1, d2] = await race(() => a.outbound.dispatch(f.scope, o.id, dispatch), () => b.outbound.dispatch(f.scope, o.id, dispatch));
  assert.deepEqual(ok(d1), ok(d2));
  assert.deepEqual(await keys(f), [`inbound:${receipt.id}:receipt`, ...['take', 'drop', 'dispatch'].map((s) => `transport:${task.id}:${s}`)].sort());
  const [intent, extra] = await outbox(f);
  assert.ok(intent); assert.equal(extra, undefined);
  assert.deepEqual(await stock(f), { onHand: 63, reserved: 0 });
  await reconciled(f);
  return { postings: 4, onHand: 63, dispatchIntents: 1 };
});

repeated('T03', async (round) => {
  const f = await fixture(`T03-stock-${round}`);
  const [x, y] = [await newOrder(f, f.available), await newOrder(f, f.available)];
  const [winner, loser] = await race(() => a.outbound.allocate(f.scope, x.id, cmd()), () => b.outbound.allocate(f.scope, y.id, cmd()));
  assert.equal(ok(winner).status, 'ALLOCATED'); conflict(loser);
  assert.equal((await orders(f)).find((o) => o.id === y.id).status, 'CREATED');
  assert.equal(await observer.allocation.count({ where: { ...f.where, orderId: y.id } }), 0);
  assert.deepEqual(await stock(f), { onHand: 62, reserved: f.available });
  assert.deepEqual(await keys(f), []);
  await reconciled(f);

  const g = await fixture(`T03-capacity-${round}`);
  const placement = await observer.layoutLocation.findFirstOrThrow({ where: { ...g.where, locationId: g.stage.id } });
  const opening = { ...g.where, batchId: g.batch.id, skuId: g.batch.skuId };
  const loaded = placement.capacity - 1;
  await observer.$transaction(async (tx) => {
    await tx.inventoryBalance.create({ data: { ...opening, locationId: g.stage.id, quality: 'RELEASED', onHand: loaded } });
    await tx.inventoryMovement.create({ data: { ...opening, kind: 'OPENING', destinationLocationId: g.stage.id,
      destinationQuality: 'RELEASED', quantity: loaded, businessKey: 'opening:day38-stage', actorId: 'day38-fixture', actorType: 'TEST', reason: note, reference: note } });
  });
  const [first, second] = [await reserve(g), await reserve(g)];
  const [fits, overflow] = await race(() => createTask(g, first.allocations[0].id), () => createTask(g, second.allocations[0].id, b));
  assert.equal(ok(fits).phase, 'READY'); conflict(overflow);
  assert.equal(await observer.transportTask.count({ where: g.where }), 1);
  assert.equal(await observer.location.count({ where: { ...g.where, kind: 'TRANSIT' } }), 1);
  assert.equal(await capacityUsed(g), 1n);
  assert.equal(await observer.warehouseEvent.count({ where: { ...g.where, kind: 'TRANSPORT_CREATED' } }), 1);
  await reconciled(g);
  return { sourceReserved: f.available, sourceLosers: 1, stagedOnHand: loaded, reservedCapacity: 1, capacity: placement.capacity };
});

async function toPhase(f, phase) {
  for (let i = 0; i < 120; i++) {
    const state = await b.fleet.read(f.scope), robot = state.robots.find((r) => r.id === 'robot-2');
    if (robot.phase === phase) return robot;
    assert.notEqual(robot.phase, 'ERROR');
    const proposal = await b.fleet.prepare(f.where.warehouseId); assert.ok(proposal); await b.fleet.commit(proposal);
  }
  assert.fail(`Fleet did not reach ${phase}`);
}

repeated('T04', async (round) => {
  const f = await fixture(`T04-${round}`);
  await b.fleet.initialize(f.scope, { count: 3, reason: note });
  const o = await reserve(f);
  const assigned = await b.fleet.assign(f.scope, { kind: 'OUTBOUND', robotId: 'robot-2', allocationId: o.allocations[0].id,
    stagingLocationId: f.stage.id, reason: note });
  const carrying = await toPhase(f, 'TRANSPORT');
  const stale = await b.fleet.prepare(f.where.warehouseId);
  assert.ok(stale);
  const command = (action) => ({ expectedTaskId: assigned.id, robotId: carrying.id, action, reason: note });
  const originalClaim = await observer.fleetClaim.findUniqueOrThrow({ where: { id: assigned.id } });
  const task = await observer.transportTask.findUniqueOrThrow({ where: { id: originalClaim.taskId } });
  const [faulted, fenced] = await race(() => a.fleet.control(f.scope, command('FAULT')), () => b.fleet.commit(stale));
  assert.equal(ok(faulted).robots.find((r) => r.id === carrying.id).recoveryStatus, 'NEEDS_RECOVERY'); conflict(fenced);
  const claim = await observer.fleetClaim.findUniqueOrThrow({ where: { id: assigned.id } });
  assert.deepEqual([claim.active, claim.loaded, claim.taskId], [true, true, task.id]);
  assert.equal((await observer.transportTask.findUniqueOrThrow({ where: { id: task.id } })).phase, 'IN_TRANSIT');
  const transit = await observer.inventoryBalance.findFirstOrThrow({ where: { ...f.where, locationId: task.transitLocationId } });
  assert.deepEqual([transit.onHand, transit.reserved], [1, 1]);
  await assert.rejects(a.count.create(f.scope, { ...cmd(), locationId: f.stage.id }), { status: 409 });
  assert.deepEqual(await keys(f), [`transport:${task.id}:take`]);
  assert.deepEqual(await stock(f), { onHand: 62, reserved: 1 });
  await reconciled(f);
  await a.fleet.control(f.scope, command('REPAIR'));
  assert.equal((await toPhase(f, 'COMPLETED')).taskId, assigned.id);
  assert.equal((await observer.transportTask.findUniqueOrThrow({ where: { id: task.id } })).phase, 'STAGED');
  assert.deepEqual(await keys(f), ['drop', 'take'].map((s) => `transport:${task.id}:${s}`));
  assert.deepEqual(await stock(f), { onHand: 62, reserved: 1 });
  assert.equal(await observer.auditLog.count({ where: { ...f.where, action: { in: ['FLEET_FAULT', 'FLEET_REPAIR'] } } }), 2);
  await reconciled(f);
  return { transitOnFault: 1, stagedOnRepair: 1, onHand: 62, staleProposalRejected: true };
});

repeated('T05', async (round) => {
  const f = await fixture(`T05-${round}`), o = await reserve(f), task = await createTask(f, o.allocations[0].id);
  await a.transport.take(f.scope, task.id, note);
  const inTransit = await scopedSnapshot(f);
  await assert.rejects(a.outbound.dispatch(f.scope, o.id, cmd()), { status: 409 });
  assert.deepEqual(await scopedSnapshot(f), inTransit);
  await a.transport.drop(f.scope, task.id, note);
  const staged = await scopedSnapshot(f), dispatch = cmd();
  assert.deepEqual(await stock(f), { onHand: 62, reserved: 1 });
  const [aborted, committed] = await race(() => a.outbound.dispatch(f.scope, o.id, dispatch), () => b.outbound.dispatch(f.scope, o.id, dispatch), {
    rollback: true,
    async inLeader(tx) { assert.equal((await outbox(f, tx)).length, 1); },
    async during() { assert.deepEqual(await scopedSnapshot(f), staged); },
    async afterFollower() { assert.deepEqual(await scopedSnapshot(f), staged); },
  });
  assert.equal(aborted.error, injectedRollback); assert.equal(ok(committed).status, 'DISPATCHED');
  assert.deepEqual(await stock(f), { onHand: 61, reserved: 0 });
  assert.deepEqual(await keys(f), ['dispatch', 'drop', 'take'].map((s) => `transport:${task.id}:${s}`));
  assert.equal(await observer.auditLog.count({ where: { ...f.where, action: 'OUTBOUND_DISPATCHED' } }), 1);
  assert.equal(await observer.idempotencyRecord.count({ where: { ...f.where, operation: 'OUTBOUND_DISPATCH' } }), 1);
  const [intent, extra] = await outbox(f);
  assert.ok(intent); assert.equal(extra, undefined);
  const source = (await events(f)).filter((e) => e.kind === 'OUTBOUND_DISPATCHED');
  assert.deepEqual(source.map((e) => e.seq), [intent.sourceSeq]);
  await reconciled(f);
  return { stagedOnHand: 62, dispatchedOnHand: 61, rolledBackFullWrite: true, committedDispatches: 1 };
});

repeated('T06', async (round) => {
  const f = await fixture(`T06-${round}`), o = await newOrder(f, f.available);
  const balance = await observer.inventoryBalance.findFirstOrThrow({ where: { ...f.where, batchId: f.batch.id, quality: 'RELEASED' }, orderBy: { locationId: 'asc' } });
  const open = () => a.count.create(f.scope, { ...cmd(), locationId: balance.locationId });
  const allocate = (side) => side.outbound.allocate(f.scope, o.id, cmd());
  if (round % 2 === 1) {
    const [frozen, rejected] = await race(open, () => allocate(b));
    const count = ok(frozen); conflict(rejected);
    assert.deepEqual(await stock(f), { onHand: 62, reserved: 0 });
    assert.equal((await orders(f))[0].status, 'CREATED');
    assert.equal(await observer.allocation.count({ where: f.where }), 0);
    await a.count.phase(f.scope, count.id, 'submit', { ...cmd(), lines: count.lines.map((line) => ({ balanceId: line.balanceId,
      actual: line.expected + (line.balanceId === balance.id ? 1 : 0) })) });
    assert.equal((await a.count.phase(f.scope, count.id, 'approve', cmd())).status, 'APPROVED');
    assert.equal((await allocate(b)).status, 'ALLOCATED');
    assert.equal((await observer.inventoryBalance.findUniqueOrThrow({ where: { id: balance.id } })).onHand, balance.onHand + 1);
    assert.equal((await moves(f)).filter((m) => m.kind === 'COUNT_ADJUSTMENT').length, 1);
  } else {
    const [allocated, rejected] = await race(() => allocate(a), () => b.count.create(f.scope, { ...cmd(), locationId: balance.locationId }));
    assert.equal(ok(allocated).status, 'ALLOCATED'); conflict(rejected);
    assert.equal(await observer.countOrder.count({ where: f.where }), 0);
    assert.deepEqual(await keys(f), []);
  }
  const onHand = 62 + round % 2;
  assert.deepEqual(await stock(f), { onHand, reserved: f.available });
  await reconciled(f);
  return { winner: round % 2 ? 'COUNT' : 'ALLOCATE', onHand, reserved: f.available };
});

after(async () => {
  try {
    if (evidence.length === 20) writeFileSync('reports/day38-wms-contention.json', JSON.stringify({
      capturedAt: new Date().toISOString(), rounds: evidence.length, observedWaits, cases: evidence,
    }, null, 2));
  } finally {
    await a.fleet.onModuleDestroy(); await b.fleet.onModuleDestroy();
    await Promise.all([left.$disconnect(), right.$disconnect(), observer.$disconnect()]);
  }
});
