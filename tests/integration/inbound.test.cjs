const { PrismaClient } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { reconcile } = require('../../packages/database/reconcile.cjs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { resolve } = require('node:path');
const request = require('supertest');
const testUrl = process.env.INBOUND_TEST_DATABASE_URL;
if (!testUrl || new URL(testUrl).pathname !== '/warehouse_twin_inbound_test' || new URL(testUrl).hostname !== '127.0.0.1') throw new Error('Isolated Day 8 test database required');
const db = new PrismaClient({ datasourceUrl: testUrl });
const scope = { spaceId: ids.spaceA, warehouseId: randomUUID() };
const base = `/spaces/${scope.spaceId}/warehouses/${scope.warehouseId}`;
const url = 'http://127.0.0.1:13003';
let server, admin, operator, viewer, choices, actor, operatorActor;
async function start() {
  server = spawn(process.execPath, ['apps/api/dist/main.js'], { cwd: resolve(__dirname, '../..'), windowsHide: true,
    env: { ...process.env, DATABASE_URL: testUrl, API_PORT: '13003', API_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    if (server.exitCode !== null) throw new Error('API exited'); await delay(100);
  }
  throw new Error('API did not start');
}
async function stop() { if (server && server.exitCode === null) { const closed = once(server, 'close'); server.kill(); await closed; } }
async function login(name) {
  const response = await request(url).post('/auth/login').set('X-Requested-With', 'WarehouseTwin').send({ email: `${name}@demo.local`, password: process.env.DEMO_PASSWORD }).expect(201);
  return response.headers['set-cookie'][0].split(';')[0];
}
const get = (path, cookie = admin) => request(url).get(path).set('Cookie', cookie);
const post = (path, body, cookie = admin) => request(url).post(path).set('Cookie', cookie).set('X-Requested-With', 'WarehouseTwin').send(body);
function input(overrides = {}) { return { key: randomUUID(), skuId: choices.skus[0].id, qcLocationId: choices.qcLocations[0].id,
  batchCode: `TEST-${randomUUID()}`, quantity: 2, producedAt: null, expiresAt: '2030-01-01T00:00:00.000Z', reason: 'integration', ...overrides }; }
async function create(overrides = {}, cookie = admin) { return (await post(`${base}/inbound-orders`, input(overrides), cookie).expect(201)).body; }
const receive = (order, overrides = {}, cookie = admin) => post(`${base}/inbound-orders/${order.id}/receive`, { key: randomUUID(), reason: 'receipt', ...overrides }, cookie);
const inspect = (order, overrides = {}, cookie = admin) => post(`${base}/inbound-orders/${order.id}/inspect`, { key: randomUUID(), reason: 'inspection', decision: 'PASS', ...overrides }, cookie);
const stock = () => get(`${base}/inventory`).expect(200).then((r) => r.body);
async function effects() { return { orders: await db.inboundOrder.count({ where: scope }), movements: await db.inventoryMovement.count({ where: scope }),
  audit: await db.auditLog.count({ where: scope }), keys: await db.idempotencyRecord.count({ where: scope }), balances: await db.inventoryBalance.findMany({ where: scope, orderBy: { id: 'asc' } }) }; }

beforeAll(async () => {
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: scope.warehouseId, spaceId: scope.spaceId, name: 'Isolated Day 8' } });
    await seedInventory(tx, scope.spaceId, scope.warehouseId);
    for (const [name, role] of [['admin', 'ADMIN'], ['operator', 'OPERATOR'], ['viewer', 'VIEWER']]) {
      const user = await tx.user.findUniqueOrThrow({ where: { email: `${name}@demo.local` } });
      if (name === 'admin') actor = user.id; if (name === 'operator') operatorActor = user.id;
      await tx.warehouseAccess.create({ data: { ...scope, userId: user.id, role } });
    }
  }, { timeout: 20000 });
  await start(); admin = await login('admin'); operator = await login('operator'); viewer = await login('viewer');
  choices = (await get(`${base}/inbound-orders`).expect(200)).body;
});
afterAll(async () => { await stop(); await db.$disconnect(); });

test('authorized reads are scoped; anonymous/viewer/cross-warehouse writes cannot create stock', async () => {
  await request(url).get(`${base}/inbound-orders`).expect(401);
  await get(`${base}/inbound-orders`, viewer).expect(200);
  await post(`${base}/inbound-orders`, input(), viewer).expect(403);
  await post(`/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}/inbound-orders`, input()).expect(404);
  const order = await create();
  await receive(order, {}, viewer).expect(403); await inspect(order, {}, viewer).expect(403);
  await post(`/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}/inbound-orders/${order.id}/receive`, { key: randomUUID(), reason: 'wrong scope' }).expect(404);
});
test.each([0, -1, 1.5, 1000001])('rejects invalid quantity %s without effects', async (quantity) => {
  const before = await effects(); await post(`${base}/inbound-orders`, input({ quantity })).expect(400); expect(await effects()).toEqual(before);
});
test('rejects forged identity, invalid dates and wrong SKU/location; existing batch dates are immutable through commands', async () => {
  await post(`${base}/inbound-orders`, { ...input(), actorId: randomUUID() }).expect(400);
  await post(`${base}/inbound-orders`, input({ producedAt: '2025-02-30T00:00:00.000Z' })).expect(400);
  await post(`${base}/inbound-orders`, input({ producedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2024-01-01T00:00:00.000Z' })).expect(400);
  await post(`${base}/inbound-orders`, input({ producedAt: '2040-01-01T00:00:00.000Z', expiresAt: null })).expect(400);
  await post(`${base}/inbound-orders`, input({ skuId: randomUUID() })).expect(404);
  const location = await db.location.findFirstOrThrow({ where: { ...scope, kind: 'STORAGE' } });
  await post(`${base}/inbound-orders`, input({ qcLocationId: location.id })).expect(409);
  const order = await create();
  await post(`${base}/inbound-orders`, input({ batchCode: order.batchCode, expiresAt: null })).expect(409);
});
test('concurrent create replay returns one order, same-key different body conflicts', async () => {
  const body = input(); const before = await effects();
  const responses = await Promise.all([post(`${base}/inbound-orders`, body), post(`${base}/inbound-orders`, body)]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]); expect(responses[0].body).toEqual(responses[1].body);
  const after = await effects(); expect(after.orders).toBe(before.orders + 1); expect(after.movements).toBe(before.movements); expect(after.audit).toBe(before.audit + 1);
  await post(`${base}/inbound-orders`, { ...body, quantity: body.quantity + 1 }).expect(409);
});
test('receipt is exactly once for concurrent retries and lost-response replay; HOLD is never available', async () => {
  const order = await create({ quantity: 3 }); const before = await stock(); const key = randomUUID();
  const responses = await Promise.all([receive(order, { key }), receive(order, { key })]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]); expect(responses[0].body).toEqual(responses[1].body);
  expect((await receive(order, { key }).expect(201)).body).toEqual(responses[0].body);
  await receive(order, { key, reason: 'changed' }).expect(409);
  const after = await stock(); expect(after.summary.onHand).toBe(before.summary.onHand + 3); expect(after.summary.hold).toBe(before.summary.hold + 3); expect(after.summary.available).toBe(before.summary.available);
  const movement = await db.inventoryMovement.findUniqueOrThrow({ where: { spaceId_warehouseId_businessKey: { ...scope, businessKey: `inbound:${order.id}:receipt` } } });
  expect(movement).toMatchObject({ kind: 'RECEIPT', actorId: actor, reference: order.id, sourceLocationId: null, destinationQuality: 'HOLD', quantity: 3 });
});
test('different keys and actors still cannot receive one order twice', async () => {
  const order = await create(); const responses = await Promise.all([receive(order), receive(order, {}, operator)]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(await db.inventoryMovement.count({ where: { ...scope, reference: order.id } })).toBe(1);
});
test('same-batch multiple orders release only their own quantity, not seed or other HOLD', async () => {
  const batch = await db.batch.findFirstOrThrow({ where: { ...scope, sku: { code: choices.skus[0].code } } });
  const first = await create({ batchCode: batch.code, quantity: 2 }); const second = await create({ batchCode: batch.code, quantity: 4 });
  await receive(first).expect(201); await receive(second).expect(201); const before = await stock();
  const passed = (await inspect(first, {}, operator).expect(201)).body;
  expect(passed).toMatchObject({ status: 'PASSED', inspectedById: operatorActor, quantity: 2 });
  const after = await stock(); expect(after.summary.onHand).toBe(before.summary.onHand); expect(after.summary.hold).toBe(before.summary.hold - 2); expect(after.summary.available).toBe(before.summary.available + 2);
  expect((await db.inboundOrder.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('RECEIVED');
  expect(after.summary.hold).toBeGreaterThanOrEqual(11); // seed QC 7 + the other order 4
});
test('inspection replays its result; concurrent opposite decisions commit once', async () => {
  const order = await create(); await receive(order).expect(201); const key = randomUUID();
  const response = await inspect(order, { key }).expect(201);
  expect((await inspect(order, { key }).expect(201)).body).toEqual(response.body);
  await inspect(order, { key, decision: 'REJECT' }).expect(409); await inspect(order).expect(409);
  const other = await create(); await receive(other).expect(201);
  const both = await Promise.all([inspect(other), inspect(other, { decision: 'REJECT' }, operator)]);
  expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(await db.auditLog.count({ where: { ...scope, correlationId: other.id, action: { in: ['INBOUND_PASSED', 'INBOUND_REJECTED'] } } })).toBe(1);
});
test('expired receipt remains isolated and rejection records an actor without stock changes', async () => {
  const order = await create({ expiresAt: '2000-01-01T00:00:00.000Z' }); await receive(order).expect(201);
  const before = await stock(); await inspect(order).expect(409); await inspect(order, { decision: 'REJECT', reason: 'expired quarantine' }).expect(201);
  const after = await stock(); expect(after.summary).toEqual(before.summary);
  const result = await db.inboundOrder.findUniqueOrThrow({ where: { id: order.id } }); expect(result).toMatchObject({ status: 'REJECTED', inspectedById: actor, inspectionReason: 'expired quarantine' });
});
test('requires receipt before inspection and refuses QC over-capacity atomically', async () => {
  const order = await create({ quantity: 1000000 }); await inspect(order).expect(409);
  const before = await effects(); await receive(order).expect(409); expect(await effects()).toEqual(before);
});
test.each(['InventoryMovement', 'AuditLog'])('%s insertion failure rolls back receipt, including its idempotency result', async (table) => {
  const order = await create(); const before = await effects(); const key = randomUUID();
  await db.$executeRawUnsafe(`CREATE FUNCTION day8_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER day8_failure BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION day8_failure()`);
  try { await receive(order, { key }).expect(500); expect(await effects()).toEqual(before); }
  finally { await db.$executeRawUnsafe(`DROP TRIGGER day8_failure ON "${table}"`); await db.$executeRawUnsafe('DROP FUNCTION day8_failure()'); }
  await receive(order, { key }).expect(201);
});
test('audit failure rolls back both quality balances, transfer and decision', async () => {
  const order = await create(); await receive(order).expect(201); const before = await effects();
  await db.$executeRawUnsafe(`CREATE FUNCTION day8_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER day8_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION day8_failure()');
  try { await inspect(order).expect(500); expect(await effects()).toEqual(before); expect((await db.inboundOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('RECEIVED'); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER day8_failure ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION day8_failure()'); }
});
test('role downgrade prevents replaying a stored successful write', async () => {
  const order = await create(); const key = randomUUID(); await receive(order, { key }, operator).expect(201);
  await db.warehouseAccess.update({ where: { userId_spaceId_warehouseId: { userId: operatorActor, ...scope } }, data: { role: 'VIEWER' } });
  try { await receive(order, { key }, operator).expect(403); }
  finally { await db.warehouseAccess.update({ where: { userId_spaceId_warehouseId: { userId: operatorActor, ...scope } }, data: { role: 'OPERATOR' } }); }
});
test('new receipt/quality postings fully reconcile and survive API restart', async () => {
  expect(await db.$transaction(reconcile, { isolationLevel: 'RepeatableRead' })).toEqual([]);
  const before = (await get(`${base}/inbound-orders`).expect(200)).body; const inventory = await stock();
  await stop(); await start(); expect((await get(`${base}/inbound-orders`).expect(200)).body).toEqual(before);
  expect({ ...(await stock()), asOf: '' }).toEqual({ ...inventory, asOf: '' });
});

test('new database constraints reject invalid order phase, quantity, scope and receipt quality', async () => {
  const order = await create(); const saved = await db.inboundOrder.findUniqueOrThrow({ where: { id: order.id } });
  const before = await effects();
  await expect(db.inboundOrder.create({ data: { ...saved, id: randomUUID(), quantity: -1 } })).rejects.toThrow();
  await expect(db.inboundOrder.create({ data: { ...saved, id: randomUUID(), status: 'RECEIVED' } })).rejects.toThrow();
  await expect(db.inboundOrder.create({ data: { ...saved, id: randomUUID(), spaceId: ids.spaceB } })).rejects.toThrow();
  await expect(db.batch.update({ where: { id: order.batchId }, data: { producedAt: new Date('2031-01-01T00:00:00Z') } })).rejects.toThrow();
  await expect(db.inventoryMovement.create({ data: { ...scope, skuId: order.skuId, batchId: order.batchId,
    kind: 'RECEIPT', destinationLocationId: order.qcLocationId, destinationQuality: 'RELEASED', quantity: 1,
    businessKey: randomUUID(), actorType: 'USER', actorId: actor, reason: 'invalid receipt', reference: order.id } })).rejects.toThrow();
  expect(await effects()).toEqual(before);
});
test('two different orders competing for remaining QC capacity cannot both receive', async () => {
  const value = await stock(); const qc = value.locationTotals.find((row) => row.locationId === choices.qcLocations[0].id);
  const quantity = Math.floor((qc.capacity - qc.onHand) / 2) + 1;
  expect(qc.capacity - qc.onHand).toBeGreaterThan(1);
  const one = await create({ quantity }), two = await create({ quantity });
  const responses = await Promise.all([receive(one), receive(two, {}, operator)]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  const after = await stock(); expect(after.summary.onHand).toBe(value.summary.onHand + quantity);
  expect(after.locationTotals.find((row) => row.locationId === qc.locationId).onHand).toBeLessThanOrEqual(qc.capacity);
  expect(await db.$transaction(reconcile, { isolationLevel: 'RepeatableRead' })).toEqual([]);
});
