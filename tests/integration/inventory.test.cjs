const { PrismaClient } = require('../../packages/database');
const { ids, seed } = require('../../packages/database/seed.cjs');
const { reconcile } = require('../../packages/database/reconcile.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { resolve } = require('node:path');
const request = require('supertest');

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || new URL(testUrl).pathname !== '/warehouse_twin_test' || new URL(testUrl).hostname !== '127.0.0.1') {
  throw new Error('Inventory tests require isolated local test database');
}
const db = new PrismaClient({ datasourceUrl: testUrl });
const scope = { spaceId: ids.spaceA, warehouseId: ids.warehouseA };
const base = `/spaces/${ids.spaceA}/warehouses/${ids.warehouseA}`;
const other = `/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}`;
const http = 'http://127.0.0.1:13002';
let server, adminCookie, viewerCookie, otherCookie, layout;

async function start() {
  server = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: resolve(__dirname, '../..'), windowsHide: true,
    env: { ...process.env, API_PORT: '13002', API_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (data) => { logs += data.toString(); });
  server.stderr.on('data', (data) => { logs += data.toString(); });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`API exited: ${logs}`);
    try { if ((await fetch(`${http}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error(`API did not start: ${logs}`);
}
async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'close'); server.kill(); await closed;
  }
}
async function login(name) {
  const result = await request(http).post('/auth/login').set('X-Requested-With', 'WarehouseTwin')
    .send({ email: `${name}@demo.local`, password: process.env.DEMO_PASSWORD }).expect(201);
  return result.headers['set-cookie'][0].split(';')[0];
}
const get = (path, token = adminCookie) => request(http).get(path).set('Cookie', token);
const rollback = 'rollback test fixture';
async function inRollback(work) {
  await expect(db.$transaction(async (tx) => { await work(tx); throw new Error(rollback); }, { timeout: 15000 }))
    .rejects.toThrow(rollback);
}

beforeAll(async () => {
  await start();
  adminCookie = await login('admin'); viewerCookie = await login('viewer'); otherCookie = await login('other');
  layout = (await get(`${base}/layout`).expect(200)).body;
});
afterAll(async () => { await stop(); await db.$disconnect(); });

test('layout API returns a versioned 30x20 map with 17 stable locations and rack obstacles', () => {
  expect(layout.layoutVersion).toMatchObject({ version: 1, width: 30, depth: 20, cellSize: 1, origin: { x: 0, z: 0 } });
  expect(layout.zones).toHaveLength(6);
  expect(layout.racks).toHaveLength(2);
  expect(layout.locations).toHaveLength(17);
  expect(layout.locations.filter((location) => location.kind === 'STORAGE')).toHaveLength(12);
  expect(new Set(layout.locations.map((location) => location.id)).size).toBe(17);
  const expected = layout.racks.flatMap((rack) => Array.from({ length: rack.sizeX * rack.sizeZ }, (_, index) =>
    `${rack.gridX + index % rack.sizeX},${rack.gridZ + Math.floor(index / rack.sizeX)}`));
  expect(new Set(layout.blockedCells.map((cell) => `${cell.x},${cell.z}`))).toEqual(new Set(expected));
  expect(layout.blockedCells).toHaveLength(6);
});

test('all service cells are legal, rack-adjacent and connected by four-neighbor floor cells', () => {
  const { width, depth } = layout.layoutVersion;
  const blocked = new Set(layout.blockedCells.map((cell) => `${cell.x},${cell.z}`));
  const first = layout.locations[0].serviceCell;
  const reached = new Set([`${first.x},${first.z}`]);
  const queue = [first];
  for (let index = 0; index < queue.length; index++) {
    const point = queue[index];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = point.x + dx, z = point.z + dz, key = `${x},${z}`;
      if (x >= 0 && z >= 0 && x < width && z < depth && !blocked.has(key) && !reached.has(key)) {
        reached.add(key); queue.push({ x, z });
      }
    }
  }
  for (const location of layout.locations) {
    const { x, z } = location.serviceCell;
    expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(width);
    expect(z).toBeGreaterThanOrEqual(0); expect(z).toBeLessThan(depth);
    expect(blocked.has(`${x},${z}`)).toBe(false);
    expect(reached.has(`${x},${z}`)).toBe(true);
    if (location.kind === 'STORAGE') {
      expect(blocked.has(`${location.grid.x},${location.grid.z}`)).toBe(true);
      expect(Math.abs(location.grid.x - x) + Math.abs(location.grid.z - z)).toBe(1);
    }
  }
  expect(reached.size).toBe(width * depth - blocked.size);
});

test('inventory API matches database, includes empty locations and distinguishes HOLD availability', async () => {
  const response = await get(`${base}/inventory`).expect(200);
  const value = response.body;
  expect(value.layoutId).toBe(layout.layoutVersion.id);
  expect(value.summary).toEqual({ onHand: 62, reserved: 0, available: 55, hold: 7 });
  expect(value.balances).toHaveLength(11);
  expect(value.locationTotals).toHaveLength(17);
  expect(value.locationTotals.filter((location) => location.onHand === 0)).toHaveLength(6);
  const rows = await db.inventoryBalance.findMany({ where: scope });
  expect(value.summary.onHand).toBe(rows.reduce((sum, row) => sum + row.onHand, 0));
  for (const balance of value.balances) {
    expect(balance).toMatchObject({ onHand: rows.find((row) => row.id === balance.id).onHand });
    expect(balance.sku.unit).toBe('piece');
    if (balance.quality === 'HOLD') expect(balance.available).toBe(0);
  }
});

test('anonymous requests fail and all three authorized roles can read only their own warehouse', async () => {
  for (const endpoint of ['layout', 'inventory']) {
    await request(http).get(`${base}/${endpoint}`).expect(401);
    await get(`${base}/${endpoint}`, viewerCookie).expect(200);
    await get(`${other}/${endpoint}`).expect(404);
    await get(`/spaces/${ids.spaceB}/warehouses/${ids.warehouseA}/${endpoint}`).expect(404);
    await get(`${other}/${endpoint}`, otherCookie).expect(200);
    await get(`${base}/${endpoint}`, otherCookie).expect(404);
    await request(http).post(`${base}/${endpoint}`).set('Cookie', viewerCookie)
      .set('X-Requested-With', 'WarehouseTwin').send({ onHand: 999 }).expect(404);
  }
});

test('an expired batch remains on hand but is excluded from available quantity', async () => {
  const sku = await db.sku.findFirstOrThrow({ where: { ...scope, code: 'SKU-A' } });
  const batch = await db.batch.findFirstOrThrow({ where: { ...scope, skuId: sku.id } });
  try {
    await db.batch.update({ where: { id: batch.id }, data: { expiresAt: new Date('2000-01-01T00:00:00Z') } });
    const response = await get(`${base}/inventory`).expect(200);
    expect(response.body.summary).toEqual({ onHand: 62, reserved: 0, available: 30, hold: 7 });
    expect(response.body.balances.filter((entry) => entry.batch.id === batch.id).every((entry) => entry.available === 0)).toBe(true);
  } finally { await db.batch.update({ where: { id: batch.id }, data: { expiresAt: batch.expiresAt } }); }
});

test('every balance can be reconstructed from opening/transfer postings including zero-net ledger keys', async () => {
  expect(await db.$transaction(reconcile, { isolationLevel: 'RepeatableRead' })).toEqual([]);
  expect(await db.inventoryMovement.count({ where: scope })).toBe(11);
  const movements = await db.inventoryMovement.findMany({ where: scope });
  expect(movements.every((movement) => movement.kind === 'OPENING' && movement.sourceLocationId === null
    && movement.actorType === 'SEED' && movement.actorId === 'seed:demo-v1' && movement.reference.length > 0)).toBe(true);
});

test('repeated and concurrent seeds preserve stable IDs, balances, versions and movement counts', async () => {
  const before = await db.inventoryBalance.findMany({ orderBy: { id: 'asc' } });
  const movements = await db.inventoryMovement.findMany({ orderBy: { id: 'asc' } });
  await Promise.all([seed(testUrl, process.env.DEMO_PASSWORD), seed(testUrl, process.env.DEMO_PASSWORD)]);
  expect(await db.inventoryBalance.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  expect(await db.inventoryMovement.findMany({ orderBy: { id: 'asc' } })).toEqual(movements);
  expect((await get(`${base}/layout`).expect(200)).body).toEqual(layout);
});

test('a complete transfer record reconstructs both endpoints without changing warehouse quantity', async () => {
  await inRollback(async (tx) => {
    const source = await tx.inventoryBalance.findFirstOrThrow({ where: { ...scope, quality: 'RELEASED' }, orderBy: { onHand: 'asc' } });
    const placements = await tx.layoutLocation.findMany({ where: { layoutId: layout.layoutVersion.id, capacity: 40 } });
    const occupied = new Set((await tx.inventoryBalance.findMany({ where: scope })).map((row) => row.locationId));
    const destination = placements.find((row) => !occupied.has(row.locationId));
    await tx.inventoryBalance.update({ where: { id: source.id }, data: { onHand: 0 } });
    await tx.inventoryBalance.create({ data: { ...scope, locationId: destination.locationId,
      skuId: source.skuId, batchId: source.batchId, quality: source.quality, onHand: source.onHand } });
    await tx.inventoryMovement.create({ data: { ...scope, skuId: source.skuId, batchId: source.batchId, kind: 'TRANSFER',
      sourceLocationId: source.locationId, sourceQuality: source.quality,
      destinationLocationId: destination.locationId, destinationQuality: source.quality, quantity: source.onHand,
      businessKey: randomUUID(), actorType: 'TEST', actorId: 'test', reason: 'ledger reconstruction', reference: 'integration fixture' } });
    expect(await reconcile(tx)).toEqual([]);
    expect((await tx.inventoryBalance.aggregate({ where: scope, _sum: { onHand: true } }))._sum.onHand).toBe(62);
    await tx.inventoryBalance.delete({ where: { id: source.id } });
    expect(await reconcile(tx)).toEqual([]); // a zero-net ledger key is not missing stock
  });
});

test('opening movement insertion failure rolls back all newly seeded warehouse stock and layout', async () => {
  const warehouseId = randomUUID();
  await db.$executeRawUnsafe(`CREATE FUNCTION reject_opening() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced opening failure'; END; $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER fail_opening BEFORE INSERT ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION reject_opening()`);
  try {
    await expect(db.$transaction(async (tx) => {
      await tx.warehouse.create({ data: { id: warehouseId, spaceId: ids.spaceA, name: 'rollback fixture' } });
      await seedInventory(tx, ids.spaceA, warehouseId);
    }, { timeout: 15000 })).rejects.toThrow(/forced opening failure/);
    expect(await db.warehouse.findUnique({ where: { id: warehouseId } })).toBeNull();
    expect(await db.inventoryBalance.count({ where: { warehouseId } })).toBe(0);
    expect(await db.inventoryMovement.count({ where: { warehouseId } })).toBe(0);
    expect(await db.layoutVersion.count({ where: { warehouseId } })).toBe(0);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER fail_opening ON "InventoryMovement"`);
    await db.$executeRawUnsafe(`DROP FUNCTION reject_opening()`);
  }
});

test('API data survives an API restart with the same database and session', async () => {
  const before = (await get(`${base}/inventory`).expect(200)).body;
  await stop(); await start();
  const after = (await get(`${base}/inventory`).expect(200)).body;
  expect({ ...after, asOf: '' }).toEqual({ ...before, asOf: '' });
  expect((await get(`${base}/layout`).expect(200)).body).toEqual(layout);
});

test.each(['negative-onHand', 'negative-reserved', 'reserved-over-onHand', 'over-capacity'])('database rejects %s without changing the row', async (scenario) => {
  const balance = await db.inventoryBalance.findFirstOrThrow({ where: { ...scope, quality: 'RELEASED' }, orderBy: { onHand: 'asc' } });
  const statement = {
    'negative-onHand': '"onHand" = -1', 'negative-reserved': 'reserved = -1',
    'reserved-over-onHand': 'reserved = "onHand" + 1', 'over-capacity': '"onHand" = 41',
  }[scenario];
  await expect(db.$executeRawUnsafe(`UPDATE "InventoryBalance" SET ${statement} WHERE id = $1::uuid`, balance.id))
    .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
  expect(await db.inventoryBalance.findUnique({ where: { id: balance.id } })).toEqual(balance);
});

test('storage capacity aggregates quality rows and forbids mixing SKU or batch', async () => {
  const balance = await db.inventoryBalance.findFirstOrThrow({ where: { ...scope, quality: 'RELEASED' }, orderBy: { onHand: 'asc' } });
  const otherBatch = await db.batch.findFirstOrThrow({ where: { ...scope, skuId: { not: balance.skuId } } });
  await expect(db.inventoryBalance.create({ data: { ...scope, locationId: balance.locationId, skuId: balance.skuId, batchId: balance.batchId, quality: 'HOLD', onHand: 40 } })).rejects.toThrow();
  await expect(db.inventoryBalance.create({ data: { ...scope, locationId: balance.locationId, skuId: otherBatch.skuId, batchId: otherBatch.id, quality: 'RELEASED', onHand: 1 } })).rejects.toThrow();
});

test('two real concurrent capacity competitors cannot jointly exceed a location capacity', async () => {
  const inventory = (await get(`${base}/inventory`).expect(200)).body;
  const empty = inventory.locationTotals.find((entry) => entry.onHand === 0 && entry.capacity === 40);
  const batch = await db.batch.findFirstOrThrow({ where: scope });
  try {
    const results = await Promise.allSettled(['RELEASED', 'HOLD'].map((quality) => db.inventoryBalance.create({ data: {
      ...scope, locationId: empty.locationId, skuId: batch.skuId, batchId: batch.id, quality, onHand: 25,
    } })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await db.inventoryBalance.aggregate({ where: { locationId: empty.locationId }, _sum: { onHand: true } }))._sum.onHand).toBe(25);
  } finally { await db.inventoryBalance.deleteMany({ where: { locationId: empty.locationId } }); }
  expect(await db.$transaction(reconcile)).toEqual([]);
});

test('composite foreign keys reject a batch/SKU mismatch and cross-warehouse ledger endpoints', async () => {
  const balance = await db.inventoryBalance.findFirstOrThrow({ where: scope });
  const otherSku = await db.sku.findFirstOrThrow({ where: { ...scope, id: { not: balance.skuId } } });
  await expect(db.inventoryBalance.update({ where: { id: balance.id }, data: { skuId: otherSku.id } })).rejects.toMatchObject({ code: 'P2003' });
  const otherLocation = await db.location.findFirstOrThrow({ where: { warehouseId: ids.warehouseB } });
  await expect(db.inventoryMovement.create({ data: {
    ...scope, skuId: balance.skuId, batchId: balance.batchId, kind: 'OPENING',
    destinationLocationId: otherLocation.id, destinationQuality: 'RELEASED', quantity: 1,
    businessKey: randomUUID(), actorType: 'TEST', actorId: 'test', reason: 'invalid scope', reference: 'test',
  } })).rejects.toMatchObject({ code: 'P2003' });
});

test('ledger quantity/endpoints are checked and committed movements cannot be edited or deleted', async () => {
  const movement = await db.inventoryMovement.findFirstOrThrow({ where: scope });
  const data = { ...movement, id: randomUUID(), businessKey: randomUUID(), quantity: 0 };
  await expect(db.inventoryMovement.create({ data })).rejects.toThrow();
  await expect(db.inventoryMovement.create({ data: { ...data, quantity: 1, kind: 'TRANSFER' } })).rejects.toThrow();
  await expect(db.inventoryMovement.update({ where: { id: movement.id }, data: { quantity: 999 } })).rejects.toThrow();
  await expect(db.inventoryMovement.delete({ where: { id: movement.id } })).rejects.toThrow();
});

let draftVersion = 100;
async function cloneDraft(tx) {
  const layoutId = randomUUID();
  await tx.layoutVersion.create({ data: { ...scope, id: layoutId, version: draftVersion++, width: 30, depth: 20 } });
  const zones = new Map(), racks = new Map();
  for (const zone of await tx.layoutZone.findMany({ where: { layoutId: layout.layoutVersion.id } })) {
    const id = randomUUID(); zones.set(zone.id, id);
    await tx.layoutZone.create({ data: { ...zone, id, layoutId } });
  }
  for (const rack of await tx.rack.findMany({ where: { layoutId: layout.layoutVersion.id } })) {
    const id = randomUUID(); racks.set(rack.id, id);
    await tx.rack.create({ data: { ...rack, id, layoutId, zoneId: zones.get(rack.zoneId) } });
  }
  for (const placement of await tx.layoutLocation.findMany({ where: { layoutId: layout.layoutVersion.id } })) {
    await tx.layoutLocation.create({ data: { ...placement, layoutId, zoneId: zones.get(placement.zoneId), rackId: racks.get(placement.rackId) ?? null } });
  }
  return layoutId;
}

test.each(['blocked-service', 'outside-service', 'outside-zone', 'overlapping-racks'])('publication rejects %s; invalid draft transaction rolls back', async (scenario) => {
  const layoutsBefore = await db.layoutVersion.count();
  await expect(db.$transaction(async (tx) => {
    const layoutId = await cloneDraft(tx);
    const storage = await tx.layoutLocation.findFirstOrThrow({ where: { layoutId, rackId: { not: null } } });
    if (scenario === 'overlapping-racks') {
      const racks = await tx.rack.findMany({ where: { layoutId }, orderBy: { gridX: 'asc' } });
      await tx.rack.update({ where: { id: racks[1].id }, data: { gridX: racks[0].gridX } });
    } else {
      const data = scenario === 'blocked-service' ? { serviceX: storage.gridX, serviceZ: storage.gridZ }
        : scenario === 'outside-service' ? { serviceX: 30 } : { gridX: 29 };
      await tx.layoutLocation.update({ where: { layoutId_locationId: { layoutId, locationId: storage.locationId } }, data });
    }
    await tx.layoutVersion.update({ where: { id: layoutId }, data: { status: 'PUBLISHED' } });
  }, { timeout: 15000 })).rejects.toThrow();
  expect(await db.layoutVersion.count()).toBe(layoutsBefore);
});

test('published geometry, capacity and stable location identity cannot be changed', async () => {
  const placement = await db.layoutLocation.findFirstOrThrow({ where: { layoutId: layout.layoutVersion.id } });
  await expect(db.layoutLocation.update({ where: { layoutId_locationId: { layoutId: placement.layoutId, locationId: placement.locationId } }, data: { capacity: 999 } })).rejects.toThrow();
  await expect(db.layoutVersion.update({ where: { id: placement.layoutId }, data: { width: 99 } })).rejects.toThrow();
  await expect(db.location.update({ where: { id: placement.locationId }, data: { code: 'changed' } })).rejects.toThrow();
});

test('a new snapshot can reuse business IDs while the old snapshot stays intact', async () => {
  await inRollback(async (tx) => {
    const draftId = await cloneDraft(tx);
    await tx.layoutVersion.update({ where: { id: draftId }, data: { status: 'PUBLISHED' } });
    await tx.warehouse.update({ where: { id: ids.warehouseA }, data: { activeLayoutId: draftId } });
    const previous = await tx.layoutLocation.findMany({ where: { layoutId: layout.layoutVersion.id }, orderBy: { locationId: 'asc' } });
    const next = await tx.layoutLocation.findMany({ where: { layoutId: draftId }, orderBy: { locationId: 'asc' } });
    expect(next.map((entry) => entry.locationId)).toEqual(previous.map((entry) => entry.locationId));
    expect(previous).toHaveLength(17);
    expect(await reconcile(tx)).toEqual([]);
  });
});

test('active layout cannot be a draft, belong to another warehouse, or omit positive stock', async () => {
  const otherLayout = await db.layoutVersion.findFirstOrThrow({ where: { warehouseId: ids.warehouseB } });
  await expect(db.warehouse.update({ where: { id: ids.warehouseA }, data: { activeLayoutId: otherLayout.id } })).rejects.toThrow();
  await expect(db.$transaction(async (tx) => {
    const id = randomUUID();
    await tx.layoutVersion.create({ data: { ...scope, id, version: draftVersion++, width: 30, depth: 20 } });
    await tx.warehouse.update({ where: { id: ids.warehouseA }, data: { activeLayoutId: id } });
  })).rejects.toThrow();
  await expect(db.$transaction(async (tx) => {
    const id = randomUUID();
    await tx.layoutVersion.create({ data: { ...scope, id, version: draftVersion++, width: 30, depth: 20 } });
    await tx.layoutVersion.update({ where: { id }, data: { status: 'PUBLISHED' } });
    await tx.warehouse.update({ where: { id: ids.warehouseA }, data: { activeLayoutId: id } });
  })).rejects.toThrow();
});

test('reconciliation reports a changed balance and catches a missing balance without hiding ledger-only keys', async () => {
  await inRollback(async (tx) => {
    const balance = await tx.inventoryBalance.findFirstOrThrow({ where: { ...scope, quality: 'HOLD' } });
    await tx.inventoryBalance.update({ where: { id: balance.id }, data: { onHand: balance.onHand + 1 } });
    const mismatches = await reconcile(tx);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ locationId: balance.locationId, actual: '8', expected: '7' });
    await tx.inventoryBalance.delete({ where: { id: balance.id } });
    const missing = await reconcile(tx);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ locationId: balance.locationId, actual: '0', expected: '7' });
  });
});
