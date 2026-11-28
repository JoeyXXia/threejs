import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { PrismaClient, reconcileWarehouse } = require('../packages/database');
const { ids } = require('../packages/database/seed.cjs');
const { seedInventory } = require('../packages/database/seed-inventory.cjs');
export async function verifyDatabaseOutage(pg, url, evidencePath) {
  // integration.mjs also imports the simulation ESM package. Only require Nest's CJS after its module graph has loaded.
  const { SimulationService } = require('../apps/api/dist/simulation/simulation.service');
  const { OutboundService } = require('../apps/api/dist/outbound/outbound.service');
  const { TransportService } = require('../apps/api/dist/transport/transport.service');
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal(new URL(url).pathname, '/warehouse_twin_inbound_test');
  const [ownerDb, contenderDb, observer] = Array.from({ length: 3 }, () => new PrismaClient({ datasourceUrl: url }));
  const staged = Promise.withResolvers(), release = Promise.withResolvers();
  let pauseBeforeCommit = false, pending;
  const gated = new Proxy(ownerDb, { get(target, prop) {
    if (prop === '$transaction') return (work, opts) => target.$transaction(async (tx) => {
      const result = await work(tx);
      if (pauseBeforeCommit) {
        const posted = await tx.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: `transport:${result.taskId}:take` } });
        staged.resolve({ tick: result.tick, posted });
        await release.promise;
      }
      return result;
    }, opts);
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const original = new SimulationService(gated, new TransportService(gated));
  const second = new SimulationService(contenderDb, new TransportService(contenderDb));
  const where = { spaceId: ids.spaceA, warehouseId: randomUUID() };
  const scope = { ...where, actorId: '' };
  const runtime = () => observer.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: where.warehouseId } });
  const snapshot = async () => ({ runtime: await runtime(),
    events: await observer.warehouseEvent.findMany({ where, orderBy: { seq: 'asc' } }),
    movements: await observer.inventoryMovement.findMany({ where, orderBy: { businessKey: 'asc' } }),
    frames: await observer.warehouseReplayFrame.findMany({ where, orderBy: { seq: 'asc' } }),
    audits: await observer.auditLog.findMany({ where, orderBy: { id: 'asc' } }),
    balances: await observer.inventoryBalance.findMany({ where, orderBy: { id: 'asc' } }),
    tasks: await observer.transportTask.findMany({ where, orderBy: { id: 'asc' } }),
  });
  const reason = 'Day40 isolated database outage', command = () => ({ key: randomUUID(), reason });
  // Only retain classification, never Prisma error text (which can include connection details).
  const failed = async (work) => {
    try { await work(); } catch (error) { return error.code ?? error.errorCode ?? error.name; }
    assert.fail('Database operation unexpectedly succeeded without PostgreSQL');
  };
  try {
    scope.actorId = (await observer.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } })).id;
    await observer.$transaction(async (tx) => {
      await tx.warehouse.create({ data: { id: where.warehouseId, spaceId: where.spaceId, name: reason } });
      await seedInventory(tx, where.spaceId, where.warehouseId);
      await tx.warehouseAccess.create({ data: { ...where, userId: scope.actorId, role: 'ADMIN' } });
    });
    const outbound = new OutboundService(ownerDb);
    const batch = await ownerDb.batch.findFirstOrThrow({ where: { ...where, sku: { code: 'SKU-A' } } });
    const staging = await ownerDb.location.findFirstOrThrow({ where: { ...where, code: 'OUT-01' } });
    const order = await outbound.create(scope, { ...command(), skuId: batch.skuId, batchId: batch.id, quantity: 1 });
    const reserved = await outbound.allocate(scope, order.id, command());
    const task = await original.start(scope, { allocationId: reserved.allocations[0].id, stagingLocationId: staging.id, reason });
    let inFlight;
    for (let i = 0; i < 80; i++) {
      const proposal = await original.prepare(where.warehouseId);
      assert.ok(proposal);
      if (proposal.proposal.effect === 'take') { inFlight = proposal; break; }
      await original.commit(proposal);
    }
    assert.ok(inFlight, 'Fixture did not reach take boundary');
    assert.equal(await second.prepare(where.warehouseId), null, 'Second connection entered a live lease');
    const before = await snapshot();
    pauseBeforeCommit = true;
    pending = original.commit(inFlight).then((value) => ({ value }), (error) => ({ error }));
    const uncommitted = await Promise.race([staged.promise, pending.then((result) => { throw result.error ?? new Error('Commit escaped the barrier'); })]);
    assert.deepEqual(uncommitted, { tick: before.runtime.tick + 1, posted: 1 });
    assert.deepEqual(await snapshot(), before);
    const downStart = Date.now();
    await pg.stop(); // Only the integration runner's own cluster; this terminates the open transaction.
    const stopped = Date.now();
    release.resolve();
    const lost = (await pending).error;
    assert.ok(lost, 'Lost transaction returned a confirmed tick');
    pauseBeforeCommit = false;
    const outageFailures = await Promise.all([failed(() => original.advance()), failed(() => second.prepare(where.warehouseId))]);
    // Retire connections closed by PostgreSQL before inspecting recovery; retain both runner objects and the old proposal.
    await Promise.all([ownerDb.$disconnect(), contenderDb.$disconnect(), observer.$disconnect()]);
    const lease = before.runtime.leaseUntil;
    assert.ok(lease);
    await delay(Math.max(0, lease.getTime() - Date.now() + 150));
    await pg.start();
    const recoveredAt = Date.now();
    assert.deepEqual(await snapshot(), before, 'Restart exposed a partial take, event, checkpoint or replay frame');
    const next = await second.prepare(where.warehouseId);
    assert.ok(next && next.epoch === before.runtime.epoch + 1 && next.expectedTick === before.runtime.tick);
    await assert.rejects(original.commit(inFlight), { status: 409 });
    assert.equal((await runtime()).seq, before.runtime.seq);
    let done = await second.commit(next);
    for (let i = 0; i < 120 && done.phase !== 'COMPLETED'; i++) {
      const p = await second.prepare(where.warehouseId);
      assert.ok(p);
      done = await second.commit(p);
    }
    assert.equal(done.phase, 'COMPLETED');
    assert.equal(done.taskId, task.taskId);
    const final = await snapshot();
    const committed = final.movements.filter((row) => row.businessKey.startsWith('transport:'));
    assert.deepEqual(committed.map((row) => row.businessKey), [`transport:${task.taskId}:drop`, `transport:${task.taskId}:take`]);
    assert.deepEqual(final.events.map((row) => row.seq), final.events.map((_, i) => i + 1));
    assert.equal(final.runtime.seq, final.events.length);
    assert.deepEqual(await observer.$transaction((tx) => reconcileWarehouse(tx, where)), { consistent: true, mismatches: [], reservationMismatches: [] });
    const result = { capturedAt: new Date().toISOString(), fullyStoppedToReadyMs: recoveredAt - stopped,
      shutdownToReadyMs: recoveredAt - downStart, stagedTick: uncommitted.tick,
      savedTick: before.runtime.tick, savedSeq: before.runtime.seq, oldEpoch: before.runtime.epoch, newEpoch: next.epoch,
      finalTick: final.runtime.tick, finalSeq: final.runtime.seq, outageFailures, lostCommit: lost.code ?? lost.errorCode ?? lost.name,
      rejectedStaleRunner: true, committedMovements: committed.length, reconciled: true };
    writeFileSync(evidencePath, JSON.stringify(result, null, 2));
    console.log('PASS: Day40 PostgreSQL outage', JSON.stringify(result));
  } finally {
    release.resolve();
    await pending;
    await Promise.all([ownerDb.$disconnect(), contenderDb.$disconnect(), observer.$disconnect()]);
  }
}
