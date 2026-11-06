const { PrismaClient } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { reconcile, reconcileReservations } = require('../../packages/database/reconcile.cjs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { resolve } = require('node:path');
const request = require('supertest');
const testUrl = process.env.INBOUND_TEST_DATABASE_URL;
if (!testUrl || new URL(testUrl).hostname !== '127.0.0.1' || new URL(testUrl).pathname !== '/warehouse_twin_inbound_test') throw new Error('Isolated write test DB required');
const db = new PrismaClient({ datasourceUrl: testUrl }), url = 'http://127.0.0.1:13005';
let server, admin, operator, viewer, actor, operatorActor, scope, base, sku, batch;
async function start() {
  server = spawn(process.execPath, ['apps/api/dist/main.js'], { cwd: resolve(__dirname, '../..'), windowsHide: true,
    env: { ...process.env, DATABASE_URL: testUrl, API_HOST: '127.0.0.1', API_PORT: '13005' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    if (server.exitCode !== null) throw new Error('API exited'); await delay(100); }
  throw new Error('API did not start');
}
async function stop() { if (server && server.exitCode === null) { const closed = once(server, 'close'); server.kill(); await closed; } }
const get = (path, cookie = admin) => request(url).get(path).set('Cookie', cookie);
const post = (path, body, cookie = admin) => request(url).post(path).set('Cookie', cookie).set('X-Requested-With', 'WarehouseTwin').send(body);
async function login(name) { const r = await request(url).post('/auth/login').set('X-Requested-With', 'WarehouseTwin').send({ email: `${name}@demo.local`, password: process.env.DEMO_PASSWORD }).expect(201); return r.headers['set-cookie'][0].split(';')[0]; }
const input = (change = {}) => ({ key: randomUUID(), skuId: sku.id, batchId: batch.id, quantity: 3, reason: 'create outbound', ...change });
const create = async (change = {}, cookie = admin) => (await post(`${base}/outbound-orders`, input(change), cookie).expect(201)).body;
const allocate = (order, change = {}, cookie = admin) => post(`${base}/outbound-orders/${order.id}/allocate`, { key: randomUUID(), reason: 'allocate test', ...change }, cookie);
const inventory = () => get(`${base}/inventory`).expect(200).then((r) => r.body);
const list = () => get(`${base}/outbound-orders`).expect(200).then((r) => r.body);
async function effects() { return { balances: await db.inventoryBalance.findMany({ where: scope, orderBy: { id: 'asc' } }),
  orders: await db.outboundOrder.findMany({ where: scope, orderBy: { id: 'asc' } }), allocations: await db.allocation.findMany({ where: scope, orderBy: { id: 'asc' } }),
  audit: await db.auditLog.count({ where: scope }), keys: await db.idempotencyRecord.count({ where: scope }), movements: await db.inventoryMovement.count({ where: scope }) }; }
async function fixtureStock({ expiresAt, quality = 'RELEASED', kind = 'STORAGE', quantity = 3, code = randomUUID() }) {
  return db.$transaction(async (tx) => {
    const locations = await tx.location.findMany({ where: { ...scope, kind }, include: { balances: true }, orderBy: { id: 'asc' } });
    const location = locations.find((l) => kind !== 'STORAGE' || l.balances.every((b) => b.onHand === 0));
    if (!location) throw new Error('No fixture location');
    const created = await tx.batch.create({ data: { id: randomUUID(), ...scope, skuId: sku.id, code, expiresAt: expiresAt ? new Date(expiresAt) : null } });
    const balance = await tx.inventoryBalance.create({ data: { ...scope, skuId: sku.id, batchId: created.id, locationId: location.id, quality, onHand: quantity } });
    await tx.inventoryMovement.create({ data: { ...scope, skuId: sku.id, batchId: created.id, kind: 'OPENING', destinationLocationId: location.id, destinationQuality: quality,
      quantity, businessKey: randomUUID(), actorType: 'TEST', actorId: 'outbound-fixture', reason: 'isolated fixture', reference: 'outbound.test.cjs' } });
    return { batch: created, balance };
  });
}
beforeAll(async () => {
  await start(); admin = await login('admin'); operator = await login('operator'); viewer = await login('viewer');
  actor = (await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } })).id;
  operatorActor = (await db.user.findUniqueOrThrow({ where: { email: 'operator@demo.local' } })).id;
});
beforeEach(async () => {
  scope = { spaceId: ids.spaceA, warehouseId: randomUUID() }; base = `/spaces/${scope.spaceId}/warehouses/${scope.warehouseId}`;
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: scope.warehouseId, spaceId: scope.spaceId, name: 'Day 9 isolated case' } });
    await seedInventory(tx, scope.spaceId, scope.warehouseId);
    for (const [name, role] of [['admin', 'ADMIN'], ['operator', 'OPERATOR'], ['viewer', 'VIEWER']]) {
      const user = await tx.user.findUniqueOrThrow({ where: { email: `${name}@demo.local` } });
      await tx.warehouseAccess.create({ data: { ...scope, userId: user.id, role } });
    }
  }, { timeout: 20000 });
  sku = await db.sku.findFirstOrThrow({ where: { ...scope, code: 'SKU-A' } });
  batch = await db.batch.findFirstOrThrow({ where: { ...scope, skuId: sku.id } });
});
afterAll(async () => { await stop(); await db.$disconnect(); });

test('anonymous/viewer/cross-warehouse writes and forged fields are rejected', async () => {
  await request(url).get(`${base}/outbound-orders`).expect(401); await get(`${base}/outbound-orders`, viewer).expect(200);
  await post(`${base}/outbound-orders`, input(), viewer).expect(403);
  await post(`/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}/outbound-orders`, input()).expect(404);
  await post(`${base}/outbound-orders`, { ...input(), available: 1000 }).expect(400);
  await post(`${base}/outbound-orders`, { ...input(), actorId: randomUUID() }).expect(400);
  const order = await create(); await allocate(order, {}, viewer).expect(403);
  await post(`/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}/outbound-orders/${order.id}/allocate`, { key: randomUUID(), reason: 'cross scope' }).expect(404);
});
test.each([0, -1, 1.5, 1000001])('invalid quantity %s has no side effects', async (quantity) => {
  const before = await effects(); await post(`${base}/outbound-orders`, input({ quantity })).expect(400); expect(await effects()).toEqual(before);
});
test('batch/SKU mismatch and a foreign batch cannot create an order', async () => {
  const other = await db.sku.findFirstOrThrow({ where: { ...scope, code: 'SKU-B' } });
  await post(`${base}/outbound-orders`, input({ skuId: other.id })).expect(404);
  const foreign = await db.batch.findFirstOrThrow({ where: { warehouseId: ids.warehouseB } });
  await post(`${base}/outbound-orders`, input({ batchId: foreign.id })).expect(404);
});
test('create is idempotent concurrently, quantity is not reserved until allocation', async () => {
  const body = input(); const before = await effects(); const results = await Promise.all([post(`${base}/outbound-orders`, body), post(`${base}/outbound-orders`, body)]);
  expect(results.map((r) => r.status)).toEqual([201, 201]); expect(results[0].body).toEqual(results[1].body);
  expect(results[0].body.createdById).toBe(actor);
  const after = await effects(); expect(after.orders).toHaveLength(1); expect(after.balances).toEqual(before.balances); expect(after.allocations).toHaveLength(0); expect(after.audit).toBe(before.audit + 1);
  await post(`${base}/outbound-orders`, { ...body, quantity: 4 }).expect(409);
});
test('FEFO sorts earlier expiry first and no expiry last for the same SKU', async () => {
  const early = await fixtureStock({ expiresAt: '2028-01-01T00:00:00.000Z' }); const endless = await fixtureStock({ expiresAt: null });
  const result = (await list()).recommendations.filter((r) => r.skuId === sku.id);
  expect(result.map((r) => r.batchId)).toEqual([early.batch.id, batch.id, endless.batch.id]); expect(result.find((r) => r.batchId === batch.id).available).toBe(25);
});
test('equal-date FEFO recommendation order is stable by batch ID', async () => {
  const equal = await fixtureStock({ expiresAt: '2030-01-01T00:00:00.000Z' });
  expect((await list()).recommendations.filter((r) => r.skuId === sku.id).map((r) => r.batchId)).toEqual([batch.id, equal.batch.id].sort());
});
test('HOLD, expired and RELEASED QC stock are excluded at recommendation and commit', async () => {
  const hold = await fixtureStock({ expiresAt: null, quality: 'HOLD' });
  const expired = await fixtureStock({ expiresAt: '2000-01-01T00:00:00.000Z' });
  const qc = await fixtureStock({ expiresAt: null, kind: 'QC' });
  const recommendations = (await list()).recommendations.map((r) => r.batchId);
  for (const fixture of [hold, expired, qc]) {
    expect(recommendations).not.toContain(fixture.batch.id);
    const order = await create({ batchId: fixture.batch.id, quantity: 1 }); const before = await effects();
    await allocate(order).expect(409); expect(await effects()).toEqual(before);
  }
});
test('multi-location allocation preserves onHand/ledger and reconciles every reserved row', async () => {
  const order = await create({ quantity: 18 }); const before = await effects(); const result = (await allocate(order, {}, operator).expect(201)).body;
  expect(result).toMatchObject({ status: 'ALLOCATED', allocatedById: operatorActor }); expect(result.allocations.length).toBeGreaterThanOrEqual(3);
  expect(result.allocations.reduce((s, r) => s + r.quantity, 0)).toBe(18);
  const after = await effects(); expect(after.movements).toBe(before.movements);
  for (const row of before.balances) expect(after.balances.find((b) => b.id === row.id).onHand).toBe(row.onHand);
  expect((await inventory()).summary).toEqual({ onHand: 62, reserved: 18, available: 37, hold: 7 });
  expect(await db.$transaction(reconcileReservations, { isolationLevel: 'RepeatableRead' })).toEqual([]);
  expect(await db.$transaction(reconcile, { isolationLevel: 'RepeatableRead' })).toEqual([]);
});
test('same-key retries and lost-response replay return one allocation; different parameters conflict', async () => {
  const order = await create(); const key = randomUUID(); const responses = await Promise.all([allocate(order, { key }), allocate(order, { key })]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]); expect(responses[0].body).toEqual(responses[1].body);
  expect((await allocate(order, { key }).expect(201)).body).toEqual(responses[0].body);
  await allocate(order, { key, reason: 'different' }).expect(409); expect((await inventory()).summary.reserved).toBe(3);
});
test('different keys and actors still allocate an existing order only once', async () => {
  const order = await create(); const responses = await Promise.all([allocate(order), allocate(order, {}, operator)]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]); expect((await inventory()).summary.reserved).toBe(3);
  expect(await db.auditLog.count({ where: { ...scope, action: 'OUTBOUND_ALLOCATED' } })).toBe(1);
});
test('two orders competing for one batch never oversubscribe', async () => {
  const one = await create({ quantity: 18 }), two = await create({ quantity: 18 });
  const responses = await Promise.all([allocate(one), allocate(two, {}, operator)]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect((await inventory()).summary.reserved).toBe(18); expect(await db.allocation.aggregate({ where: scope, _sum: { quantity: true } })).toMatchObject({ _sum: { quantity: 18 } });
});
test('stale recommendations and insufficient selected batch refuse the whole order without cross-batch fallback', async () => {
  const alternative = await fixtureStock({ expiresAt: null, quantity: 20 });
  const recommendation = (await list()).recommendations.find((r) => r.batchId === batch.id); expect(recommendation.available).toBe(25);
  await allocate(await create({ quantity: 20 })).expect(201);
  const insufficient = await create({ quantity: 10 }); const before = await effects(); await allocate(insufficient).expect(409); expect(await effects()).toEqual(before);
  expect((await db.inventoryBalance.findUniqueOrThrow({ where: { id: alternative.balance.id } })).reserved).toBe(0);
});
test('a batch expiring after creation is rejected again at allocation', async () => {
  const order = await create(); await db.batch.update({ where: { id: batch.id }, data: { expiresAt: new Date('2000-01-01T00:00:00Z') } });
  const before = await effects(); await allocate(order).expect(409); expect(await effects()).toEqual(before);
});
test.each(['second-allocation', 'audit'])('%s failure rolls back prior balance updates, records, status and key', async (failure) => {
  const order = await create({ quantity: 18 }); const key = randomUUID(); const before = await effects();
  const table = failure === 'audit' ? 'AuditLog' : 'Allocation';
  const condition = failure === 'audit' ? `NEW.action = 'OUTBOUND_ALLOCATED'` : `(SELECT count(*) FROM "Allocation" WHERE "orderId"=NEW."orderId") >= 1`;
  await db.$executeRawUnsafe(`CREATE FUNCTION day9_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER day9_failure BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION day9_failure()`);
  try { await allocate(order, { key }).expect(500); expect(await effects()).toEqual(before); }
  finally { await db.$executeRawUnsafe(`DROP TRIGGER day9_failure ON "${table}"`); await db.$executeRawUnsafe('DROP FUNCTION day9_failure()'); }
  await allocate(order, { key }).expect(201);
});
test('role downgrade prevents replaying a successful allocation', async () => {
  const order = await create(); const key = randomUUID(); await allocate(order, { key }, operator).expect(201);
  await db.warehouseAccess.update({ where: { userId_spaceId_warehouseId: { userId: operatorActor, ...scope } }, data: { role: 'VIEWER' } });
  await allocate(order, { key }, operator).expect(403);
});
test('reservation reconciliation detects missing allocations, mismatched order totals and manual reserved changes', async () => {
  const order = await create(); const result = (await allocate(order).expect(201)).body;
  await db.$transaction(async (tx) => {
    await tx.allocation.deleteMany({ where: { orderId: order.id } });
    const differences = await reconcileReservations(tx); expect(differences.some((r) => r.kind === 'BALANCE')).toBe(true); expect(differences.some((r) => r.kind === 'ORDER')).toBe(true);
    throw new Error('rollback fixture');
  }).catch((e) => { if (e.message !== 'rollback fixture') throw e; });
  const id = result.allocations[0].balanceId;
  await db.$transaction(async (tx) => {
    await tx.inventoryBalance.update({ where: { id }, data: { reserved: { decrement: 1 } } });
    expect((await reconcileReservations(tx)).some((r) => r.id === id)).toBe(true); throw new Error('rollback fixture');
  }).catch((e) => { if (e.message !== 'rollback fixture') throw e; });
  expect(await db.$transaction(reconcileReservations, { isolationLevel: 'RepeatableRead' })).toEqual([]);
});
test('database checks reject invalid phase, quantity and cross-batch/HOLD allocations', async () => {
  const order = await create(); const raw = await db.outboundOrder.findUniqueOrThrow({ where: { id: order.id } });
  await expect(db.outboundOrder.create({ data: { ...raw, id: randomUUID(), quantity: -1 } })).rejects.toThrow();
  await expect(db.outboundOrder.create({ data: { ...raw, id: randomUUID(), status: 'ALLOCATED' } })).rejects.toThrow();
  const hold = await db.inventoryBalance.findFirstOrThrow({ where: { ...scope, quality: 'HOLD' } });
  await expect(db.allocation.create({ data: { ...scope, orderId: order.id, balanceId: hold.id, locationId: hold.locationId, skuId: sku.id, batchId: batch.id, quality: 'HOLD', quantity: 1 } })).rejects.toThrow();
  const wrong = await db.inventoryBalance.findFirstOrThrow({ where: { ...scope, skuId: { not: sku.id } } });
  await expect(db.allocation.create({ data: { ...scope, orderId: order.id, balanceId: wrong.id, locationId: wrong.locationId, skuId: sku.id, batchId: batch.id, quantity: 1 } })).rejects.toThrow();
});
test('allocated orders, records and balances survive API restart and key replay', async () => {
  const order = await create(); const key = randomUUID(); const response = (await allocate(order, { key }).expect(201)).body;
  const before = await list(); await stop(); await start(); const after = await list();
  expect(after.orders).toEqual(before.orders); expect((await allocate(order, { key }).expect(201)).body).toEqual(response);
  expect(await db.$transaction(reconcileReservations, { isolationLevel: 'RepeatableRead' })).toEqual([]);
});
