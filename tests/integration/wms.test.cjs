const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const request = require('supertest');
const { PrismaClient } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');

const databaseUrl = process.env.INBOUND_TEST_DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== '127.0.0.1' || new URL(databaseUrl).pathname !== '/warehouse_twin_inbound_test') {
  throw new Error('Isolated write test DB required');
}
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const url = 'http://127.0.0.1:13007';
const foreign = `/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}/wms`;
let server, admin, operator, viewer, other, scope, base, actorId;

const get = (path, cookie = admin) => request(url).get(path).set('Cookie', cookie);
const route = (params = {}) => `${base}?${new URLSearchParams(params)}`;
async function login(name) {
  const result = await request(url).post('/auth/login').set('X-Requested-With', 'WarehouseTwin')
    .send({ email: `${name}@demo.local`, password: process.env.DEMO_PASSWORD }).expect(201);
  return result.headers['set-cookie'][0].split(';')[0];
}

beforeAll(async () => {
  server = spawn(process.execPath, ['apps/api/dist/main.js'], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: databaseUrl, API_HOST: '127.0.0.1', API_PORT: '13007' } });
  let ready = false;
  for (let attempt = 0; attempt < 80 && !ready; attempt++) {
    try { ready = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* starting */ }
    if (server.exitCode !== null) throw new Error('WMS test API exited');
    if (!ready) await delay(100);
  }
  if (!ready) throw new Error('WMS test API did not start');
  admin = await login('admin');
  operator = await login('operator');
  viewer = await login('viewer');
  other = await login('other');
});

beforeEach(async () => {
  scope = { spaceId: ids.spaceA, warehouseId: randomUUID() };
  base = `/spaces/${scope.spaceId}/warehouses/${scope.warehouseId}/wms`;
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: scope.warehouseId, spaceId: scope.spaceId, name: 'Day 12 isolated case' } });
    await seedInventory(tx, scope.spaceId, scope.warehouseId);
    for (const [name, role] of [['admin', 'ADMIN'], ['operator', 'OPERATOR'], ['viewer', 'VIEWER']]) {
      const user = await tx.user.findUniqueOrThrow({ where: { email: `${name}@demo.local` } });
      if (role === 'ADMIN') actorId = user.id;
      await tx.warehouseAccess.create({ data: { ...scope, userId: user.id, role } });
    }
  }, { timeout: 20000 });
});

afterAll(async () => {
  if (server && server.exitCode === null) {
    const closed = once(server, 'close');
    server.kill();
    await closed;
  }
  await db.$disconnect();
});

test('diagnostic pages and reconciliation require warehouse membership and a write role', async () => {
  for (const path of [base, `${base}/reconcile`]) {
    await request(url).get(path).expect(401);
    await get(path, viewer).expect(403);
    await get(path, other).expect(404);
    await get(path, operator).expect(200);
  }
  const foreignRows = (await get(foreign, other).expect(200)).body;
  await get(route({ batchId: foreignRows.batches[0].id })).expect(404);
  await get(route({ movementBefore: foreignRows.movements[0].id })).expect(400);
  await get(route({ kind: 'wrong' })).expect(400);
  await get(`${base}?batchId=a&batchId=b`).expect(400);
});

test('batch detail and overlapping warnings aggregate the same physical stock without double counting', async () => {
  const skuA = await db.batch.findFirstOrThrow({ where: { ...scope, sku: { code: 'SKU-A' } } });
  const skuB = await db.batch.findFirstOrThrow({ where: { ...scope, sku: { code: 'SKU-B' } } });
  await db.batch.update({ where: { id: skuA.id }, data: { expiresAt: new Date(Date.now() + 86400000) } });
  await db.batch.update({ where: { id: skuB.id }, data: { expiresAt: new Date('2000-01-01T00:00:00Z') } });
  const view = (await get(route({ batchId: skuA.id })).expect(200)).body;
  expect(view.batch.balances.reduce((sum, row) => sum + row.onHand, 0)).toBe(32);
  expect(view.movements).toHaveLength(6);
  expect(view.movements.every((row) => row.batch.id === skuA.id && row.kind === 'OPENING' && row.source === null)).toBe(true);
  expect(view.warnings.map((row) => [row.batch.skuCode, row.type, row.quantity])).toEqual(expect.arrayContaining([
    ['SKU-A', 'EXPIRING', 32], ['SKU-A', 'HOLD', 7], ['SKU-B', 'EXPIRED', 30],
  ]));
  expect(view.warnings).toHaveLength(3);
  expect((await get(route({ batchId: skuA.id, kind: 'DISPATCH' })).expect(200)).body.movements).toEqual([]);
  await get(route({ kind: 'DISPATCH', movementBefore: view.movements[0].id })).expect(400);
});

test('movement and audit keysets retain every row when timestamps tie', async () => {
  const location = await db.location.findFirstOrThrow({ where: { ...scope, kind: 'OUTBOUND' } });
  const batch = await db.batch.findFirstOrThrow({ where: { ...scope, sku: { code: 'SKU-A' } } });
  const sameTime = new Date('2090-01-01T00:00:00Z');
  const stock = { ...scope, skuId: batch.skuId, batchId: batch.id };
  await db.$transaction(async (tx) => {
    await tx.inventoryBalance.create({ data: { ...stock, locationId: location.id, quality: 'RELEASED', onHand: 30 } });
    await tx.inventoryMovement.createMany({ data: Array.from({ length: 30 }, () => ({
      ...stock, kind: 'OPENING', destinationLocationId: location.id, destinationQuality: 'RELEASED', quantity: 1,
      businessKey: randomUUID(), actorId, actorType: 'TEST', reason: 'keyset fixture', reference: 'Day 12', createdAt: sameTime,
    })) });
    await tx.auditLog.createMany({ data: Array.from({ length: 30 }, () => ({
      ...scope, actorId, action: 'TEST', reason: 'keyset fixture', requestId: randomUUID(), before: {}, after: {}, createdAt: sameTime,
    })) });
  });
  const filters = { kind: 'OPENING', batchId: batch.id };
  const first = (await get(route(filters)).expect(200)).body;
  const second = (await get(route({ ...filters, movementBefore: first.movementBefore, auditBefore: first.auditBefore })).expect(200)).body;
  expect([first.movements.length, second.movements.length]).toEqual([25, 11]);
  expect([first.audits.length, second.audits.length]).toEqual([25, 5]);
  expect(second.movementBefore).toBeNull();
  expect(second.auditBefore).toBeNull();
  expect(new Set([...first.movements, ...second.movements].map((row) => row.id)).size).toBe(36);
  expect(new Set([...first.audits, ...second.audits].map((row) => row.id)).size).toBe(30);
});

test('a scoped reconciliation detects injected stock and reserved drift while a different warehouse stays clean', async () => {
  const balance = await db.inventoryBalance.findFirstOrThrow({ where: { ...scope, location: { kind: 'STORAGE' } } });
  const status = () => get(`${base}/reconcile`).expect(200).then((response) => response.body);
  const cli = () => spawnSync(process.execPath, ['packages/database/reconcile.cjs'], {
    env: { ...process.env, DATABASE_URL: databaseUrl }, windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  expect(await status()).toMatchObject({ ...scope, consistent: true, mismatches: [], reservationMismatches: [] });
  await db.inventoryBalance.update({ where: { id: balance.id }, data: { onHand: { increment: 1 }, reserved: 1 } });
  try {
    const result = await status();
    expect(result.consistent).toBe(false);
    expect(result.mismatches).toEqual([expect.objectContaining({ locationId: balance.locationId,
      actual: String(balance.onHand + 1), expected: String(balance.onHand) })]);
    expect(result.reservationMismatches).toEqual([{ kind: 'BALANCE', id: balance.id, actual: '1', expected: '0' }]);
    expect((await get(`${foreign}/reconcile`, other).expect(200)).body.consistent).toBe(true);
    const failedCli = cli();
    expect(failedCli.status).toBe(1);
    expect(JSON.parse(failedCli.stdout)).toMatchObject({ consistent: false, reservationMismatches: result.reservationMismatches });
  } finally {
    await db.inventoryBalance.update({ where: { id: balance.id }, data: { onHand: balance.onHand, reserved: 0 } });
  }
  expect((await status()).consistent).toBe(true);
  const cleanCli = cli();
  expect(cleanCli.status).toBe(0);
  expect(JSON.parse(cleanCli.stdout)).toEqual({ consistent: true, mismatches: [], reservationMismatches: [] });
});
