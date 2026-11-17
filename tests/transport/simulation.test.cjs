const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
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
const otherDb = new PrismaClient({ datasourceUrl: url });
const second = new SimulationService(otherDb, new TransportService(otherDb));
const { lockWarehouseState, appendWarehouseEvent } = require('../../apps/api/dist/warehouse-state');
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
after(async () => { await service.onModuleDestroy(); await second.onModuleDestroy(); await db.$disconnect(); await otherDb.$disconnect(); });
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
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(results[0].value.taskId, results[1].value.taskId);
  assert.equal(await db.transportTask.count({ where: { warehouseId: scope.warehouseId } }), 1);
  await runUntil('COMPLETED');
});

test('ledger failure stops at last confirmed pose and never publishes a take effect', async () => {
  const domain = Object.create(transport);
  domain.moveInTransaction = async () => { throw new Error('injected take failure'); };
  const failing = new SimulationService(db, domain);
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

test('a new runner reads the persisted in-transit checkpoint without reinitializing it', async () => {
  await service.start(scope, input());
  await runUntil('TRANSPORT');
  const restarted = new SimulationService(db, transport);
  const checkpoint = await current();
  assert.deepEqual((await restarted.read(scope)).runtime, checkpoint);
  assert.equal((await restarted.start(scope, input())).tick, checkpoint.tick);
  assert.equal(await restarted.prepare(scope.warehouseId), null);
  await runUntil('COMPLETED');
  await reconciled();
});

test('failed unload retains confirmed carrying state and reconciled transit cargo', async () => {
  const domain = Object.create(transport);
  domain.moveInTransaction = async (...args) => {
    if (args[3] === 'drop') throw new Error('injected unload failure');
    return transport.moveInTransaction(...args);
  };
  const failing = new SimulationService(db, domain);
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

const runtimeRow = () => db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } });
const expireLease = () => db.$executeRaw`UPDATE "WarehouseRuntime" SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE "warehouseId"=${scope.warehouseId}::uuid`;
async function durableEffects() {
  const r = await runtimeRow();
  return { tick: r.tick, version: r.version, seq: r.seq, checkpoint: r.checkpoint,
    stock: await db.inventoryBalance.findMany({ where: { warehouseId: scope.warehouseId }, orderBy: { id: 'asc' } }),
    movements: await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId } }),
    audit: await db.auditLog.count({ where: { warehouseId: scope.warehouseId } }),
    tasks: await db.transportTask.findMany({ where: { warehouseId: scope.warehouseId } }),
    events: await db.warehouseEvent.count({ where: { warehouseId: scope.warehouseId } }) };
}

test('two real clients cannot share a live lease; takeover increments epoch and fences the old computation', async () => {
  await service.start(scope, input());
  const old = await service.prepare(scope.warehouseId);
  assert.ok(old);
  assert.equal(await second.prepare(scope.warehouseId), null);
  await expireLease();
  const fresh = await second.prepare(scope.warehouseId);
  assert.ok(fresh);
  assert.ok(fresh.epoch > old.epoch);
  const before = await durableEffects();
  await assert.rejects(service.commit(old), { status: 409 });
  assert.deepEqual(await durableEffects(), before);
  await second.commit(fresh);
  assert.equal((await current()).tick, old.expectedTick + 1);
  await expireLease();
  await runUntil('COMPLETED');
});

test('a repeated expectedTick and a changed WMS state version cannot overwrite a committed checkpoint', async () => {
  await service.start(scope, input());
  const first = await service.prepare(scope.warehouseId);
  await service.commit(first);
  await assert.rejects(service.commit(first), { status: 409 });
  const computed = await service.prepare(scope.warehouseId);
  const batch = await db.batch.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, sku: { code: 'SKU-A' } } });
  const request = { key: randomUUID(), skuId: batch.skuId, batchId: batch.id, quantity: 1, reason: 'version invalidation' };
  await outbound.create(scope, request);
  const watermark = (await runtimeRow()).seq;
  await outbound.create(scope, request);
  assert.equal((await runtimeRow()).seq, watermark, 'idempotent WMS replay must not append an event');
  await assert.rejects(service.commit(computed), { status: 409 });
  assert.equal((await current()).tick, first.expectedTick + 1);
  await runUntil('COMPLETED');
});

test('failure appending a tick event rolls back take, checkpoint, audit and seq; retry has no gap', async () => {
  await service.start(scope, input());
  let prepared;
  for (let i = 0; i < 200; i++) {
    prepared = await service.prepare(scope.warehouseId);
    if (prepared.proposal.effect === 'take') break;
    await service.commit(prepared);
  }
  assert.equal(prepared.proposal.effect, 'take');
  const before = await durableEffects();
  await db.$executeRawUnsafe(`CREATE FUNCTION day19_reject_tick() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."warehouseId"='${scope.warehouseId}'::uuid AND NEW.kind='SIM_TICK' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER day19_reject_tick BEFORE INSERT ON "WarehouseEvent" FOR EACH ROW EXECUTE FUNCTION day19_reject_tick()');
  try { await assert.rejects(service.commit(prepared)); assert.deepEqual(await durableEffects(), before); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER day19_reject_tick ON "WarehouseEvent"'); await db.$executeRawUnsafe('DROP FUNCTION day19_reject_tick()'); }
  await service.commit(prepared);
  assert.equal((await current()).carrying, true);
  const all = (await service.events(scope, 0)).events;
  assert.deepEqual(all.map((e) => e.seq), Array.from({ length: all.length }, (_, i) => i + 1));
  await runUntil('COMPLETED');
  await reconciled();
});

test('seq follows row-lock commit order and uncommitted/aborted events never advance the visible watermark', async () => {
  const before = (await runtimeRow()).seq;
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = db.$transaction(async (tx) => {
    await lockWarehouseState(tx, scope);
    const seq = await appendWarehouseEvent(tx, scope, 'PROBE_A', {});
    entered(); await gate; return seq;
  }, { timeout: 15000 });
  await ready;
  const later = otherDb.$transaction(async (tx) => {
    await lockWarehouseState(tx, scope); return appendWarehouseEvent(tx, scope, 'PROBE_B', {});
  }, { timeout: 15000 });
  assert.equal((await service.events(scope, 0)).watermark, before);
  release();
  assert.deepEqual(await Promise.all([first, later]), [before + 1, before + 2]);
  await assert.rejects(db.$transaction(async (tx) => {
    await lockWarehouseState(tx, scope); await appendWarehouseEvent(tx, scope, 'ABORTED', {}); throw new Error('abort');
  }));
  assert.equal((await service.events(scope, 0)).watermark, before + 2);
  await assert.rejects(db.warehouseEvent.update({ where: { warehouseId_seq: { warehouseId: scope.warehouseId, seq: before + 1 } }, data: { kind: 'MUTATED' } }));
});

test('lease expiry during a slow event write rolls back the entire tick and its seq', async () => {
  await service.start(scope, input());
  const prepared = await service.prepare(scope.warehouseId);
  const before = await durableEffects();
  await db.$executeRawUnsafe(`CREATE FUNCTION day19_slow_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."warehouseId"='${scope.warehouseId}'::uuid AND NEW.kind='SIM_TICK' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER day19_slow_event BEFORE INSERT ON "WarehouseEvent" FOR EACH ROW EXECUTE FUNCTION day19_slow_event()');
  await db.$executeRaw`UPDATE "WarehouseRuntime" SET "leaseUntil"=clock_timestamp()+interval '200 milliseconds' WHERE "warehouseId"=${scope.warehouseId}::uuid`;
  try { await assert.rejects(service.commit(prepared), { status: 409 }); assert.deepEqual(await durableEffects(), before); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER day19_slow_event ON "WarehouseEvent"'); await db.$executeRawUnsafe('DROP FUNCTION day19_slow_event()'); }
  await runUntil('COMPLETED');
});

test('graceful release resumes from the committed tick, events paginate, and cursors are scope checked', async () => {
  const instance = new SimulationService(otherDb, new TransportService(otherDb));
  await instance.start(scope, input());
  await instance.advance();
  const saved = await current();
  await instance.onModuleDestroy();
  const proposal = await service.prepare(scope.warehouseId);
  assert.equal(proposal.expectedTick, saved.tick);
  await service.commit(proposal);
  assert.equal((await current()).tick, saved.tick + 1);
  for (let i = 0; i < 105; i++) await db.$transaction(async (tx) => {
    await lockWarehouseState(tx, scope); await appendWarehouseEvent(tx, scope, 'PAGE_TEST', {});
  });
  const page = await service.events(scope, 0);
  assert.equal(page.events.length, 100); assert.equal(page.hasMore, true);
  const rest = await service.events(viewer, page.events.at(-1).seq);
  assert.equal(rest.events[0].seq, 101); assert.equal(rest.hasMore, false);
  await assert.rejects(service.events({ ...scope, spaceId: ids.spaceB }, 0), { status: 404 });
  await assert.rejects(service.events(scope, -1), { status: 400 });
  await assert.rejects(service.events(scope, rest.watermark + 1), { status: 409 });
  await runUntil('COMPLETED');
});

test('a killed API process restarts from the persisted tick and completes with a new fencing epoch', async () => {
  const origin = 'http://127.0.0.1:13019';
  const base = `${origin}/spaces/${scope.spaceId}/warehouses/${scope.warehouseId}`;
  let child;
  async function until(read, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (predicate(value)) return value;
      await delay(40);
    }
    assert.fail('API/checkpoint condition timed out');
  }
  async function startApi() {
    child = spawn(process.execPath, ['apps/api/dist/main.js'], { cwd: resolve(__dirname, '../..'), windowsHide: true,
      env: { ...process.env, DATABASE_URL: url, API_HOST: '127.0.0.1', API_PORT: '13019', NODE_ENV: 'test', SESSION_SECURE: 'false' }, stdio: 'ignore' });
    await until(() => fetch(`${origin}/health`).then((r) => r.ok).catch(() => false), Boolean);
    const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin' },
      body: JSON.stringify({ email: 'admin@demo.local', password: process.env.DEMO_PASSWORD }) });
    assert.equal(login.status, 201);
    return login.headers.get('set-cookie').split(';')[0];
  }
  async function stopApi() {
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  }
  try {
    let cookie = await startApi();
    const started = await fetch(`${base}/simulation/start`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin' }, body: JSON.stringify(input()) });
    assert.equal(started.status, 201);
    const task = await started.json();
    const first = await until(() => fetch(`${base}/simulation`, { headers: { Cookie: cookie } }).then((r) => r.json()), (r) => r.runtime.tick >= 2);
    await stopApi();
    const saved = await runtimeRow();
    assert.equal(saved.checkpoint.taskId, task.taskId);
    assert.ok(saved.tick >= first.runtime.tick);
    cookie = await startApi();
    const resumed = await until(() => fetch(`${base}/simulation`, { headers: { Cookie: cookie } }).then((r) => r.json()), (r) => r.runtime.tick > saved.tick);
    assert.equal(resumed.runtime.taskId, task.taskId);
    assert.ok(resumed.epoch > saved.epoch);
    const done = await until(() => fetch(`${base}/simulation`, { headers: { Cookie: cookie } }).then((r) => r.json()), (r) => r.runtime.phase === 'COMPLETED');
    assert.equal(done.runtime.logicalTimeMs, done.runtime.tick * 250);
    assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'transport:' } } }), 2);
    await reconciled();
    writeFileSync(resolve(__dirname, '../../reports/day19-restart.json'), JSON.stringify({
      capturedAt: new Date().toISOString(), taskId: task.taskId, savedTick: saved.tick, oldEpoch: saved.epoch,
      resumedTick: resumed.runtime.tick, newEpoch: resumed.epoch, completedTick: done.runtime.tick,
      watermark: done.watermark, processRestarted: true,
    }, null, 2));
  } finally { await stopApi(); }
});

test('putaway survives an API kill after pickup, then resumes once without a second ledger posting', async () => {
  const { InboundService } = require('../../apps/api/dist/inbound/inbound.service');
  const inbound = new InboundService(db), note = 'Day20 restart fixture';
  const cmd = () => ({ key: randomUUID(), reason: note });
  const sku = await db.sku.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, code: 'SKU-A' } });
  const qc = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, kind: 'QC' } });
  const storage = await db.location.findFirstOrThrow({ where: { warehouseId: scope.warehouseId, kind: 'STORAGE', balances: { none: { onHand: { gt: 0 } } } } });
  const receipt = await inbound.create(scope, { ...cmd(), skuId: sku.id, qcLocationId: qc.id, batchCode: randomUUID(), quantity: 3, producedAt: null, expiresAt: null });
  await inbound.phase(scope, receipt.id, 'receive', cmd());
  await inbound.phase(scope, receipt.id, 'inspect', { ...cmd(), decision: 'PASS' });
  const putawayInput = { kind: 'PUTAWAY', inboundOrderId: receipt.id, targetLocationId: storage.id, reason: note };
  const origin = 'http://127.0.0.1:13019';
  const base = `${origin}/spaces/${scope.spaceId}/warehouses/${scope.warehouseId}`;
  let child;
  async function until(read, predicate, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (predicate(value)) return value;
      await delay(40);
    }
    assert.fail('API/checkpoint condition timed out');
  }
  async function startApi() {
    child = spawn(process.execPath, ['apps/api/dist/main.js'], { cwd: resolve(__dirname, '../..'), windowsHide: true,
      env: { ...process.env, DATABASE_URL: url, API_HOST: '127.0.0.1', API_PORT: '13019', NODE_ENV: 'test', SESSION_SECURE: 'false' }, stdio: 'ignore' });
    await until(() => fetch(`${origin}/health`).then((r) => r.ok).catch(() => false), Boolean);
    const login = await fetch(`${origin}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin' },
      body: JSON.stringify({ email: 'admin@demo.local', password: process.env.DEMO_PASSWORD }) });
    assert.equal(login.status, 201);
    return login.headers.get('set-cookie').split(';')[0];
  }
  async function stopApi() {
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  }
  try {
    let cookie = await startApi();
    const started = await fetch(`${base}/simulation/start`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin' }, body: JSON.stringify(putawayInput) });
    assert.equal(started.status, 201);
    const task = await started.json();
    const first = await until(() => fetch(`${base}/simulation`, { headers: { Cookie: cookie } }).then((r) => r.json()), (r) => r.runtime.phase === 'TRANSPORT');
    await stopApi();
    const saved = await runtimeRow();
    assert.equal(saved.checkpoint.taskId, task.taskId);
    assert.ok(saved.tick >= first.runtime.tick);
    cookie = await startApi();
    const resumed = await until(() => fetch(`${base}/simulation`, { headers: { Cookie: cookie } }).then((r) => r.json()), (r) => r.runtime.tick > saved.tick);
    assert.equal(resumed.runtime.taskId, task.taskId);
    assert.ok(resumed.epoch > saved.epoch);
    const done = await until(() => fetch(`${base}/simulation`, { headers: { Cookie: cookie } }).then((r) => r.json()), (r) => r.runtime.phase === 'COMPLETED');
    assert.equal(done.runtime.logicalTimeMs, done.runtime.tick * 250);
    assert.equal(await db.inventoryMovement.count({ where: { warehouseId: scope.warehouseId, businessKey: { startsWith: 'putaway:' } } }), 2);
    await reconciled();
    writeFileSync(resolve(__dirname, '../../reports/day20-restart.json'), JSON.stringify({
      capturedAt: new Date().toISOString(), taskId: task.taskId, savedTick: saved.tick, oldEpoch: saved.epoch,
      resumedTick: resumed.runtime.tick, newEpoch: resumed.epoch, completedTick: done.runtime.tick,
      watermark: done.watermark, processRestarted: true,
    }, null, 2));
  } finally { await stopApi(); }
});
