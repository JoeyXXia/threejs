const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const request = require('supertest');
const { PrismaClient } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { reconcile } = require('../../packages/database/reconcile.cjs');

const databaseUrl = process.env.INBOUND_TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== '127.0.0.1' || new URL(databaseUrl).pathname !== '/warehouse_twin_inbound_test') {
  throw new Error('Isolated write test DB required');
}
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const url = 'http://127.0.0.1:13006';
const reason = 'Day 11 count fixture';
let server, admin, operator, viewer, scope, base, balance, stagingId;

const get = (path, cookie = admin) => request(url).get(path).set('Cookie', cookie);
const write = (path, body, cookie = admin) => request(url).post(path).set('Cookie', cookie)
  .set('X-Requested-With', 'WarehouseTwin').send(body);
const command = (overrides = {}) => ({ reason, key: randomUUID(), ...overrides });
const startCount = (locationId = balance.locationId, cookie = operator) => write(`${base}/count-orders`, command({ locationId }), cookie);
const open = async () => (await startCount().expect(201)).body;
const phase = (id, action, body = command(), cookie = admin) => write(`${base}/count-orders/${id}/${action}`, body, cookie);
const submit = (id, actual) => phase(id, 'submit', command({ lines: [{ balanceId: balance.id, actual }] }), operator);
const postings = () => db.inventoryMovement.findMany({ where: { ...scope, kind: 'COUNT_ADJUSTMENT' } });
const savedBalance = () => db.inventoryBalance.findUniqueOrThrow({ where: { id: balance.id } });
const warehouseCounts = () => get(`${base}/count-orders`).expect(200).then((response) => response.body);

async function login(name) {
  const response = await request(url).post('/auth/login').set('X-Requested-With', 'WarehouseTwin')
    .send({ email: `${name}@demo.local`, password: process.env.DEMO_PASSWORD }).expect(201);
  return response.headers['set-cookie'][0].split(';')[0];
}

beforeAll(async () => {
  server = spawn(process.execPath, ['apps/api/dist/main.js'], { windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl, API_HOST: '127.0.0.1', API_PORT: '13006' }, stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 80 && !ready; attempt++) {
    try { ready = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* starting */ }
    if (server.exitCode !== null) throw new Error('Count test API exited');
    if (!ready) await delay(100);
  }
  if (!ready) throw new Error('Count test API did not start');
  admin = await login('admin');
  operator = await login('operator');
  viewer = await login('viewer');
});

beforeEach(async () => {
  scope = { spaceId: ids.spaceA, warehouseId: randomUUID() };
  base = `/spaces/${scope.spaceId}/warehouses/${scope.warehouseId}`;
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: scope.warehouseId, spaceId: scope.spaceId, name: 'Day 11 isolated case' } });
    await seedInventory(tx, scope.spaceId, scope.warehouseId);
    for (const [name, role] of [['admin', 'ADMIN'], ['operator', 'OPERATOR'], ['viewer', 'VIEWER']]) {
      const user = await tx.user.findUniqueOrThrow({ where: { email: `${name}@demo.local` } });
      await tx.warehouseAccess.create({ data: { ...scope, userId: user.id, role } });
    }
  }, { timeout: 20000 });
  balance = await db.inventoryBalance.findFirstOrThrow({
    where: { ...scope, location: { kind: 'STORAGE' }, onHand: 9, batch: { sku: { code: 'SKU-A' } } },
  });
  stagingId = (await db.location.findFirstOrThrow({ where: { ...scope, code: 'OUT-01' } })).id;
});

afterAll(async () => {
  if (server && server.exitCode === null) {
    const closed = once(server, 'close');
    server.kill();
    await closed;
  }
  await db.$disconnect();
});

test('submit and reject preserve inventory and ledger; role and warehouse scope are checked', async () => {
  const before = await savedBalance();
  await request(url).get(`${base}/count-orders`).expect(401);
  await startCount(balance.locationId, viewer).expect(403);
  const order = await open();
  expect(order.lines).toEqual([expect.objectContaining({ balanceId: balance.id, expected: 9, balanceVersion: 0, actual: null })]);
  await startCount().expect(409);
  await submit(order.id, 12).expect(201);
  await phase(order.id, 'approve', command(), operator).expect(403);
  const foreign = `/spaces/${ids.spaceA}/warehouses/${ids.warehouseA}/count-orders`;
  await write(`${foreign}/${order.id}/approve`, command()).expect(404);
  expect((await get(foreign).expect(200)).body.orders).not.toContainEqual(expect.objectContaining({ id: order.id }));
  expect((await get(`${base}/count-orders`, viewer).expect(200)).body.role).toBe('VIEWER');
  expect(await savedBalance()).toEqual(before);
  expect(await postings()).toEqual([]);
  expect((await warehouseCounts()).locations.find((row) => row.id === balance.locationId).frozen).toBe(true);
  await phase(order.id, 'reject').expect(201);
  expect((await warehouseCounts()).locations.find((row) => row.id === balance.locationId).frozen).toBe(false);
  expect(await savedBalance()).toEqual(before);
  expect(await postings()).toEqual([]);
});

test.each([12, 6, 9])('approval of actual=%i posts only the signed difference once', async (actual) => {
  const order = await open();
  await phase(order.id, 'approve').expect(409);
  await submit(order.id, actual).expect(201);
  const payload = command();
  const [first, replay] = await Promise.all([phase(order.id, 'approve', payload), phase(order.id, 'approve', payload)]);
  expect([first.status, replay.status]).toEqual([201, 201]);
  expect(first.body.status).toBe('APPROVED');
  expect(first.body).toEqual(replay.body);
  await phase(order.id, 'approve', { ...payload, reason: 'changed' }).expect(409);
  await phase(order.id, 'approve').expect(409);
  expect(await savedBalance()).toMatchObject({ onHand: actual, version: actual === 9 ? 0 : 1, reserved: 0 });
  const movements = await postings();
  if (actual === 9) expect(movements).toHaveLength(0);
  else expect(movements).toEqual([expect.objectContaining({
    quantity: Math.abs(actual - 9), sourceLocationId: actual < 9 ? balance.locationId : null,
    destinationLocationId: actual > 9 ? balance.locationId : null, reference: order.id,
  })]);
  expect((await warehouseCounts()).locations.find((row) => row.id === balance.locationId).frozen).toBe(false);
  expect(await reconcile(db)).toEqual([]);
});

test('frozen and allocated stock compete under the same warehouse lock', async () => {
  const outbound = (await write(`${base}/outbound-orders`, command({
    skuId: balance.skuId, batchId: balance.batchId, quantity: 25,
  })).expect(201)).body;
  const allocate = () => write(`${base}/outbound-orders/${outbound.id}/allocate`, command());
  const [freeze, allocation] = await Promise.all([startCount(), allocate()]);
  expect([freeze.status, allocation.status].sort()).toEqual([201, 409]);
  if (freeze.status === 201) {
    const recommendations = (await get(`${base}/outbound-orders`).expect(200)).body.recommendations;
    expect(recommendations.find((row) => row.batchId === balance.batchId).available).toBe(16);
    await allocate().expect(409);
    await phase(freeze.body.id, 'reject').expect(201);
    await allocate().expect(201);
  }
  await startCount().expect(409);
  expect((await savedBalance()).reserved).toBe(9);
});

test('an empty count freezes inserts and invalid or extra submitted lines are rejected', async () => {
  const count = (await startCount(stagingId).expect(201)).body;
  expect(count.lines).toEqual([]);
  await expect(db.inventoryBalance.create({ data: { ...scope, locationId: stagingId,
    skuId: balance.skuId, batchId: balance.batchId, quality: 'RELEASED', onHand: 0 } })).rejects.toThrow(/frozen for counting/);
  await phase(count.id, 'submit', command({ lines: [{ balanceId: balance.id, actual: 0 }] }), operator).expect(400);
  await phase(count.id, 'submit', command({ lines: [], reason: 'Empty, unlisted stock reported separately' }), operator).expect(201);
  await phase(count.id, 'approve').expect(201);
  expect(await postings()).toEqual([]);
});

test.each(['version', 'new row'])('approval detects stale snapshot caused by %s', async (scenario) => {
  const count = await open();
  await submit(count.id, 12).expect(201);
  // Simulate privileged repair outside the command path. The freeze guard is restored before commit.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`ALTER TABLE "InventoryBalance" DISABLE TRIGGER balance_freeze_guard`;
    if (scenario === 'version') await tx.inventoryBalance.update({ where: { id: balance.id }, data: { version: { increment: 1 } } });
    else await tx.inventoryBalance.create({ data: { ...scope, locationId: balance.locationId,
      skuId: balance.skuId, batchId: balance.batchId, quality: 'HOLD', onHand: 0 } });
    await tx.$executeRaw`ALTER TABLE "InventoryBalance" ENABLE TRIGGER balance_freeze_guard`;
  });
  const before = await savedBalance();
  await phase(count.id, 'approve').expect(409);
  expect(await savedBalance()).toEqual(before);
  expect(await postings()).toEqual([]);
  expect((await warehouseCounts()).orders.find((row) => row.id === count.id).status).toBe('SUBMITTED');
  await phase(count.id, 'reject').expect(201);
});

test('capacity failure leaves the count frozen; posting failure rolls back balance and terminal state', async () => {
  const over = await open();
  await submit(over.id, 41).expect(201);
  await phase(over.id, 'approve').expect(409);
  expect((await warehouseCounts()).locations.find((row) => row.id === balance.locationId).frozen).toBe(true);
  await phase(over.id, 'reject').expect(201);
  const count = await open();
  await submit(count.id, 12).expect(201);
  const payload = command();
  const before = await savedBalance();
  await db.$executeRaw`CREATE FUNCTION test_fail_count_posting() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = 'COUNT_ADJUSTMENT' THEN RAISE EXCEPTION 'test count posting failure'; END IF;
      RETURN NEW;
    END $$`;
  try {
    await db.$executeRaw`CREATE TRIGGER test_fail_count_posting BEFORE INSERT ON "InventoryMovement"
      FOR EACH ROW EXECUTE FUNCTION test_fail_count_posting()`;
    try {
      await phase(count.id, 'approve', payload).expect(500);
      expect(await savedBalance()).toEqual(before);
      expect(await postings()).toEqual([]);
      expect((await warehouseCounts()).orders.find((row) => row.id === count.id).status).toBe('SUBMITTED');
      expect(await db.auditLog.count({ where: { ...scope, correlationId: count.id, action: 'COUNT_APPROVED' } })).toBe(0);
    } finally {
      await db.$executeRaw`DROP TRIGGER test_fail_count_posting ON "InventoryMovement"`;
    }
  } finally {
    await db.$executeRaw`DROP FUNCTION test_fail_count_posting()`;
  }
  await phase(count.id, 'approve', payload).expect(201);
  expect((await savedBalance()).onHand).toBe(12);
  expect(await reconcile(db)).toEqual([]);
});
