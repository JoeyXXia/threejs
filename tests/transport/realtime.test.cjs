const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { PrismaClient } = require('../../packages/database');
const { ids } = require('../../packages/database/seed.cjs');
const { seedInventory } = require('../../packages/database/seed-inventory.cjs');
const { appendWarehouseEvent, lockWarehouseState } = require('../../apps/api/dist/warehouse-state');
const { io } = require('../../apps/web/node_modules/socket.io-client');

const url = process.env.REALTIME_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/warehouse_twin_realtime_test') {
  throw new Error('Isolated realtime test DB required');
}
const db = new PrismaClient({ datasourceUrl: url });
const port = require('../api-test-port.cjs')(20);
const apiUrl = 'http://127.0.0.1:' + port;
const origin = 'http://127.0.0.1:5173';
const scope = { spaceId: ids.spaceA, warehouseId: randomUUID() };
const endpoint = `/spaces/${scope.spaceId}/warehouses/${scope.warehouseId}`;
const clients = new Set();
let child, viewerId;

async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 8000;
  do { const value = await read(); if (predicate(value)) return value; await delay(25); } while (Date.now() < deadline);
  throw new Error('Realtime test observation timed out');
}
async function login(email) {
  const r = await fetch(apiUrl + '/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin' },
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD }) });
  assert.equal(r.status, 201);
  return r.headers.get('set-cookie').split(';')[0];
}
function request(path, Cookie, body) {
  return fetch(apiUrl + path, { method: body ? 'POST' : 'GET', headers: {
    Cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin',
  }, body: body && JSON.stringify(body) });
}
function peer(cookie, claimedOrigin = origin) {
  const client = io(apiUrl, { forceNew: true, autoConnect: false, reconnection: false,
    transports: ['websocket'], extraHeaders: { Origin: claimedOrigin, ...(cookie && { Cookie: cookie }) } });
  const events = [];
  client.on('warehouse:events', (value, ack) => { events.push(...value.events.map((event) => ({ ...event, spaceId: value.spaceId, warehouseId: value.warehouseId }))); ack(true); });
  clients.add(client);
  return { client, events, async start() {
    const result = new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    client.connect(); await result;
  }, sub: (payload = scope) => client.timeout(2500).emitWithAck('warehouse:subscribe', payload) };
}
before(async () => {
  const [admin, viewer] = await Promise.all(['admin@demo.local', 'viewer@demo.local'].map((email) => db.user.findUniqueOrThrow({ where: { email } })));
  viewerId = viewer.id;
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: scope.warehouseId, spaceId: scope.spaceId, name: 'Day29 isolated realtime' } });
    await seedInventory(tx, scope.spaceId, scope.warehouseId);
    await tx.warehouseAccess.createMany({ data: [{ ...scope, role: 'ADMIN', userId: admin.id }, { ...scope, role: 'VIEWER', userId: viewerId }] });
  });
  child = spawn(process.execPath, ['apps/api/dist/main.js'], { cwd: resolve(__dirname, '../..'), windowsHide: true,
    env: { ...process.env, DATABASE_URL: url, API_HOST: '127.0.0.1', API_PORT: port, WEB_ORIGINS: origin, NODE_ENV: 'test' }, stdio: 'ignore' });
  await until(() => fetch(apiUrl + '/health').then((r) => r.ok).catch(() => false));
});
after(async () => {
  for (const client of clients) client.disconnect();
  if (child?.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  await db.$disconnect();
});

test('Day29 Socket.IO rejects missing identity/origin and unauthorized or arbitrary rooms, and drops revoked subscriptions', { timeout: 18000 }, async () => {
  const adminCookie = await login('admin@demo.local');
  const viewerCookie = await login('viewer@demo.local');
  const denied = peer();
  await assert.rejects(denied.start(), /UNAUTHORIZED/);
  const foreign = peer(adminCookie, 'http://example.invalid');
  await assert.rejects(foreign.start(), /websocket error/);
  const viewer = peer(viewerCookie); await viewer.start();
  assert.deepEqual(await viewer.sub({ ...scope, room: 'anything' }), { ok: false, code: 'BAD_REQUEST' });
  assert.deepEqual(await viewer.sub({ spaceId: ids.spaceB, warehouseId: ids.warehouseB }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await viewer.sub({ ...scope, spaceId: ids.spaceB }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await viewer.sub({ ...scope, after: 1 }), { ok: false, code: 'CURSOR_AHEAD' });
  assert.deepEqual(await viewer.sub(), { ok: true, after: 0 });
  assert.deepEqual(await viewer.sub(), { ok: false, code: 'BUSY' });
  const removal = once(viewer.client, 'disconnect');
  await db.warehouseAccess.delete({ where: { userId_spaceId_warehouseId: { ...scope, userId: viewerId } } });
  await removal; assert.deepEqual(viewer.events, []);
  await db.warehouseAccess.create({ data: { ...scope, userId: viewerId, role: 'VIEWER' } });
  const expired = peer(viewerCookie); await expired.start(); assert.equal((await expired.sub()).ok, true);
  const expiration = once(expired.client, 'disconnect');
  await db.session.update({ where: { tokenHash: createHash('sha256').update(viewerCookie.split('=')[1]).digest('hex') },
    data: { expiresAt: new Date(0) } });
  await expiration;
  await assert.rejects(peer(viewerCookie).start(), /UNAUTHORIZED/);
});

test('Day29 two authorized clients see committed events only, and a cursor replays real inventory, task and fleet position in order', { timeout: 22000 }, async () => {
  const cookie = await login('admin@demo.local'), viewerCookie = await login('viewer@demo.local');
  const a = peer(cookie), b = peer(viewerCookie);
  await Promise.all([a.start(), b.start()]);
  assert.deepEqual(await a.sub(), { ok: true, after: 0 });
  assert.deepEqual(await b.sub(), { ok: true, after: 0 });
  await assert.rejects(db.$transaction(async (tx) => {
    await lockWarehouseState(tx, scope);
    await appendWarehouseEvent(tx, scope, 'TRANSPORT_DROPPED', { rollbackProbe: true });
    await delay(700); // Several relay sweeps while the apparently-successful event is uncommitted.
    assert.deepEqual(a.events, []); assert.deepEqual(b.events, []);
    throw new Error('abort before commit');
  }), /abort before commit/);
  await delay(350);
  assert.deepEqual(a.events, []); assert.deepEqual(b.events, []);
  assert.equal(await db.warehouseEvent.count({ where: scope }), 0);
  const command = () => ({ key: randomUUID(), reason: 'Day29 realtime fixture' });
  const post = async (path, data) => {
    const response = await request(endpoint + path, cookie, data);
    assert.equal(response.status, 201, path); return response.json();
  };
  const choices = await (await request(endpoint + '/outbound-orders', cookie)).json();
  const batch = choices.recommendations[0];
  const order = await post('/outbound-orders', { ...command(), skuId: batch.skuId, batchId: batch.batchId, quantity: 1 });
  const allocation = (await post('/outbound-orders/' + order.id + '/allocate', command())).allocations[0];
  const staging = (await (await request(endpoint + '/simulation', cookie)).json()).staging[0].id;
  await post('/fleet/initialize', { count: 3, reason: 'Day29 fixture' });
  const claim = await post('/fleet/assign', { robotId: 'robot-2', kind: 'OUTBOUND', allocationId: allocation.id, stagingLocationId: staging, reason: 'Day29 fixture' });
  const position = await until(() => a.events.find((event) => event.kind === 'FLEET_TICK'));
  await post('/fleet/control', { robotId: 'robot-2', expectedTaskId: claim.id, action: 'FAULT', reason: 'Day29 fixture' });
  const fault = await until(() => a.events.find((event) => event.kind === 'FLEET_FAULT'));
  await until(() => b.events.some((event) => event.seq === fault.seq));
  await until(() => b.events.some((event) => event.seq === position.seq));
  const prefix = a.events.filter((event) => event.seq <= position.seq);
  assert.deepEqual(b.events.filter((event) => event.seq <= position.seq), prefix);
  assert.ok(prefix.some((event) => event.kind === 'OUTBOUND_ALLOCATE') && prefix.some((event) => event.kind === 'FLEET_ASSIGNED'));
  assert.ok(prefix.every((event, i) => event.seq === i + 1 && event.version > 0 && event.epoch >= 0
    && event.spaceId === scope.spaceId && event.warehouseId === scope.warehouseId));
  assert.equal(position.payload.robots.length, 3);
  assert.ok(position.epoch > 0);
  assert.deepEqual(b.events.find((event) => event.seq === fault.seq), fault);
  const history = await (await request(endpoint + '/simulation/events?after=0', cookie)).json();
  assert.deepEqual(history.events.filter((event) => event.seq <= position.seq).map((event) => ({ ...event, ...scope })), prefix);
  a.client.disconnect();
  const resumed = peer(cookie); await resumed.start();
  assert.deepEqual(await resumed.sub({ ...scope, after: 1 }), { ok: true, after: 1 });
  await until(() => resumed.events.some((event) => event.seq === position.seq));
  assert.deepEqual(resumed.events.filter((event) => event.seq <= position.seq), prefix.slice(1));
  const logout = once(resumed.client, 'disconnect');
  assert.equal((await request('/auth/logout', cookie, {})).status, 201);
  await logout;
  assert.equal(b.client.connected, true);
  b.client.disconnect();
});

test('Day30 snapshot preserves one MVCC boundary across a real concurrent allocation', { timeout: 18000 }, async () => {
  const { InventoryController } = require('../../apps/api/dist/inventory.controller');
  const { AuthService } = require('../../apps/api/dist/auth/auth.service');
  const { FleetService } = require('../../apps/api/dist/simulation/fleet.service');
  const { SimulationService } = require('../../apps/api/dist/simulation/simulation.service');
  const { TransportService } = require('../../apps/api/dist/transport/transport.service');
  const { realtimeSnapshotSchema } = require('../../packages/contracts');
  const cookie = await login('admin@demo.local');
  const transport = new TransportService(db);
  const controller = new InventoryController(db, new FleetService(db, transport), new SimulationService(db, transport), new AuthService(db));
  const readInventory = controller.readInventory.bind(controller);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  controller.readInventory = async (tx, ...args) => {
    entered.resolve((await tx.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } })).seq);
    await release.promise;
    return readInventory(tx, ...args);
  };
  const before = (await (await request(endpoint + '/inventory', cookie)).json()).summary.reserved;
  const { recommendations: [batch] } = await (await request(endpoint + '/outbound-orders', cookie)).json();
  const command = () => ({ key: randomUUID(), reason: 'Day30 snapshot race' });
  const made = await request(endpoint + '/outbound-orders', cookie, { ...command(), skuId: batch.skuId, batchId: batch.batchId, quantity: 1 });
  assert.equal(made.status, 201);
  const order = await made.json();
  const reading = controller.consistent({ headers: { cookie } }, scope.spaceId, scope.warehouseId);
  let oldWatermark;
  try {
    oldWatermark = await Promise.race([entered.promise, reading.then(() => { throw new Error('Snapshot skipped barrier'); })]);
    const allocated = await request(endpoint + '/outbound-orders/' + order.id + '/allocate', cookie, command());
    assert.equal(allocated.status, 201);
  } finally { release.resolve(); }
  const snapshot = realtimeSnapshotSchema.parse(await reading);
  assert.equal(snapshot.watermark, oldWatermark);
  assert.equal(snapshot.inventory.summary.reserved, before);
  const response = await request(endpoint + '/snapshot', cookie);
  assert.equal(response.status, 200);
  const current = realtimeSnapshotSchema.parse(await response.json());
  assert.equal(current.inventory.summary.reserved, before + 1);
  assert.ok(current.watermark > oldWatermark);
  assert.equal((await request(`/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}/snapshot`, cookie)).status, 404);
});

test('Day30 missing history expires the old cursor and fresh authorized snapshot remains available', { timeout: 18000 }, async () => {
  const cookie = await login('viewer@demo.local');
  const fixture = { spaceId: scope.spaceId, warehouseId: randomUUID() };
  const path = `/spaces/${fixture.spaceId}/warehouses/${fixture.warehouseId}`;
  const row = { ...fixture, tick: 0, epoch: 0, kind: 'CURSOR_FIXTURE', payload: {} };
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: fixture.warehouseId, spaceId: fixture.spaceId, name: 'Day30 missing history fixture' } });
    await seedInventory(tx, fixture.spaceId, fixture.warehouseId);
    await tx.warehouseAccess.create({ data: { ...fixture, userId: viewerId, role: 'VIEWER' } });
    await lockWarehouseState(tx, fixture);
    await tx.warehouseRuntime.update({ where: { warehouseId: fixture.warehouseId }, data: { seq: 2, version: 2 } });
    await tx.warehouseEvent.create({ data: { ...row, seq: 2, version: 2 } });
  });
  const socket = peer(cookie); await socket.start();
  try {
    assert.deepEqual(await socket.sub({ ...fixture, after: 0 }), { ok: false, code: 'CURSOR_EXPIRED' });
    assert.equal((await request(path + '/simulation/events?after=0', cookie)).status, 410);
    assert.deepEqual(await socket.sub(fixture), { ok: true, after: 2 });
    const snapshot = await request(path + '/snapshot', cookie);
    assert.equal(snapshot.status, 200); assert.equal((await snapshot.json()).watermark, 2);
    const close = once(socket.client, 'disconnect', { signal: AbortSignal.timeout(5000) });
    await db.warehouseAccess.delete({ where: { userId_spaceId_warehouseId: { ...fixture, userId: viewerId } } });
    await close;
    assert.equal((await request(path + '/snapshot', cookie)).status, 404);
  } finally {
    socket.client.disconnect();
    // Restore the synthetic history by append only, before the suite's restart reconciliation.
    await db.warehouseEvent.create({ data: { ...row, seq: 1, version: 1 } });
  }
});

test('Day31 waiting heat sums robot-ticks, not visits, cumulative counters or incompatible layouts', () => {
  const { waitHeat } = require('../../apps/api/dist/operations');
  const layout = { id: 'current', width: 10, depth: 8 };
  const r = (id, waitReason, x = 2, z = 3) => ({ id, cell: { x, z }, waitReason, waitTicks: 20 });
  const event = (seq, tick, robots, layoutId = 'current') => ({ seq, tick, payload: { layoutId, tickMs: 250, robots } });
  const heat = waitHeat([
    event(9, 5, [r('a', 'RESOURCE_BUSY'), r('a', 'RESOURCE_BUSY'), r('b', 'DEVICE_FAULT'), r('c', null)]),
    event(8, 4, [r('a', 'EDGE_SWAP'), r('b', 'OCCUPIED', 5), r('out-of-bounds', 'OCCUPIED', 11)]),
    event(7, 4, [r('a', 'TARGET_CONFLICT')]),
    event(6, 3, [r('a', 'RESOURCE_BUSY')], 'previous'),
    { seq: 5, tick: 2, payload: { robots: [r('a', 'OCCUPIED')] } },
  ], layout);
  assert.deepEqual(heat, { limit: 240, sampledTicks: 2, firstSeq: 8, lastSeq: 9,
    cells: [{ x: 2, z: 3, ms: 500 }, { x: 5, z: 3, ms: 250 }] });
  const recent = waitHeat(Array.from({ length: 250 }, (_, n) => event(250 - n, 250 - n, [r('a', 'OCCUPIED')])), layout);
  assert.equal(recent.sampledTicks, 240);
  assert.equal(recent.cells[0].ms, 60000);
});

test('Day31 HTTP counts visible orders and real task terminal events, excludes older history and enforces warehouse ACL', { timeout: 18000 }, async () => {
  const { TransportService } = require('../../apps/api/dist/transport/transport.service');
  const { operationsSchema } = require('../../packages/contracts');
  const cookie = await login('admin@demo.local');
  const actorId = (await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } })).id;
  const fixture = { spaceId: scope.spaceId, warehouseId: randomUUID() };
  const authScope = { ...fixture, actorId };
  const path = `/spaces/${fixture.spaceId}/warehouses/${fixture.warehouseId}`;
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: fixture.warehouseId, spaceId: fixture.spaceId, name: 'Day31 operations fixture' } });
    await seedInventory(tx, fixture.spaceId, fixture.warehouseId);
    await tx.warehouseAccess.create({ data: { ...fixture, userId: actorId, role: 'ADMIN' } });
  });
  async function operations() {
    const response = await request(path + '/operations', cookie);
    assert.equal(response.status, 200);
    return operationsSchema.parse(await response.json());
  }
  const blank = await operations();
  assert.deepEqual(blank.pending, { inbound: 0, outbound: 0, count: 0 });
  assert.deepEqual(blank.queue, { ready: 0, inTransit: 0 });
  assert.deepEqual(blank.wait, { limit: 240, sampledTicks: 0, firstSeq: null, lastSeq: null, cells: [] });
  const command = () => ({ key: randomUUID(), reason: 'Day31 fixture' });
  const post = async (url, data) => {
    const response = await request(path + url, cookie, data);
    assert.equal(response.status, 201, url); return response.json();
  };
  const choice = (await (await request(path + '/outbound-orders', cookie)).json()).recommendations[0];
  const staging = (await (await request(path + '/simulation', cookie)).json()).staging[0].id;
  const service = new TransportService(db);
  const commit = async (work) => db.$transaction(async (tx) => { await lockWarehouseState(tx, fixture); return work(tx); });
  const create = async () => {
    const order = await post('/outbound-orders', { ...command(), skuId: choice.skuId, batchId: choice.batchId, quantity: 1 });
    const { allocations: [allocation] } = await post('/outbound-orders/' + order.id + '/allocate', command());
    return commit((tx) => service.createInTransaction(tx, authScope, allocation.id, staging, 'Day31 fixture'));
  };
  const [a, b, c] = [await create(), await create(), await create()];
  await commit((tx) => service.moveInTransaction(tx, authScope, a.id, 'take', 'Day31 fixture'));
  const progress = await operations();
  assert.deepEqual(progress.queue, { ready: 2, inTransit: 1 });
  assert.equal(progress.pending.outbound, 3);
  await commit((tx) => service.moveInTransaction(tx, authScope, a.id, 'drop', 'Day31 fixture'));
  await commit((tx) => service.cancelInTransaction(tx, authScope, b.id, 'Day31 fixture'));
  // An old synthetic event tests only the time filter; no ledger state is altered.
  await commit(async (tx) => {
    const row = await tx.warehouseRuntime.update({ where: { warehouseId: fixture.warehouseId }, data: { seq: { increment: 1 }, version: { increment: 1 } } });
    await tx.warehouseEvent.create({ data: { ...fixture, seq: row.seq, tick: row.tick, kind: 'TRANSPORT_DROPPED',
      payload: {}, createdAt: new Date(Date.now() - 2 * 3600000) } });
  });
  const terminal = await operations();
  assert.equal(terminal.terminal.completed, 1); assert.equal(terminal.terminal.cancelled, 1);
  assert.equal(Date.parse(terminal.terminal.through) - Date.parse(terminal.terminal.from), 3600000);
  assert.deepEqual(terminal.queue, { ready: 1, inTransit: 0 });
  assert.ok(c.id);
  assert.equal((await request(`/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}/operations`, cookie)).status, 404);
});

test('Day32 fleet history keeps all robots, closures and a pinned event horizon across pages', { timeout: 18000 }, async () => {
  const { historyPageSchema } = require('../../packages/contracts');
  const cookie = await login('admin@demo.local');
  const closure = { x: 0, z: 0 };
  const change = await request(endpoint + '/fleet/navigation', cookie, { cells: [closure], closed: true, expectedRevision: 0, reason: 'Day32 history fixture' });
  assert.equal(change.status, 201);
  const changed = await change.json();
  await until(() => db.warehouseReplayFrame.findFirst({ where: { ...scope, seq: { gt: changed.watermark } } }));
  const params = new URLSearchParams({ from: new Date(Date.now() - 60000).toISOString(), to: new Date(Date.now() + 60000).toISOString(), limit: '2' });
  const get = async () => {
    const response = await request(endpoint + '/history?' + params, cookie);
    assert.equal(response.status, 200); return historyPageSchema.parse(await response.json());
  };
  let page = await get();
  const { baseline, through } = page;
  assert.equal(baseline.mode, 'FLEET');
  assert.equal(baseline.tick, 1);
  assert.equal(baseline.state.robots.length, 3);
  const events = [], frames = [];
  await until(() => db.warehouseReplayFrame.findFirst({ where: { ...scope, seq: { gt: through } } }));
  for (;;) {
    events.push(...page.events); frames.push(...page.frames);
    if (page.nextAfter === null) break;
    assert.ok(page.events.length <= 2);
    params.set('after', String(page.nextAfter)); params.set('through', String(through));
    page = await get();
    assert.equal(page.through, through); assert.equal(page.baseline.seq, baseline.seq);
  }
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: through - baseline.seq }, (_, i) => baseline.seq + i + 1));
  assert.ok(events.some((e) => e.kind === 'FLEET_NAVIGATION_CHANGED' && e.payload.navigation.closed.some((c) => c.x === closure.x && c.z === closure.z)));
  assert.ok(events.some((e) => e.kind === 'FLEET_FAULT'));
  assert.ok(events.filter((e) => e.kind === 'FLEET_TICK').every((e) => e.payload === null && frames.some((f) => f.seq === e.seq)));
  assert.ok(frames.some((f) => f.state.robots.some((r) => r.fault)));
  assert.ok(frames.every((f) => f.state.robots.length === 3));
  let navigation = baseline.state.definition.navigation;
  for (const event of events) {
    if (event.kind === 'FLEET_NAVIGATION_CHANGED') navigation = event.payload.navigation;
    const anchor = frames.find((frame) => frame.seq === event.seq && frame.anchor);
    if (anchor) navigation = anchor.state.definition.navigation;
  }
  const lastFrame = frames.at(-1);
  const originalTick = await db.warehouseEvent.findUniqueOrThrow({
    where: { warehouseId_seq: { warehouseId: scope.warehouseId, seq: lastFrame.seq } },
  });
  assert.deepEqual(navigation, originalTick.payload.navigation);
  assert.deepEqual(lastFrame.state.robots.map(({ id, cell, phase }) => ({ id, cell, phase })),
    originalTick.payload.robots.map(({ id, cell, phase }) => ({ id, cell, phase })));
  const denied = `/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}/history?${params}`;
  assert.equal((await request(denied, cookie)).status, 404);
  assert.equal((await request(endpoint + '/history?' + new URLSearchParams({ ...Object.fromEntries(params), limit: '101' }), cookie)).status, 400);
  assert.equal((await request(endpoint + '/history?' + new URLSearchParams({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:01Z' }), cookie)).status, 400);
  require('node:fs').writeFileSync('reports/day32-fleet-history.json', JSON.stringify({
    capturedAt: new Date().toISOString(), baseline: baseline.seq, through, eventCount: events.length, trackCount: frames.length,
    robotCount: lastFrame.state.robots.length, navigation,
  }));
});

test('Day32 single-robot history captures post-ledger inventory, cadence anchors, and retained old layout', { timeout: 25000 }, async () => {
  const { SimulationService } = require('../../apps/api/dist/simulation/simulation.service');
  const { TransportService } = require('../../apps/api/dist/transport/transport.service');
  const { replayFrameSchema, layoutSchema, historyPageSchema } = require('../../packages/contracts');
  const cookie = await login('admin@demo.local');
  const actorId = (await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } })).id;
  const fixture = { spaceId: scope.spaceId, warehouseId: randomUUID() }, authScope = { ...fixture, actorId };
  const path = `/spaces/${fixture.spaceId}/warehouses/${fixture.warehouseId}`;
  await db.$transaction(async (tx) => {
    await tx.warehouse.create({ data: { id: fixture.warehouseId, spaceId: fixture.spaceId, name: 'Day32 layout fixture' } });
    await seedInventory(tx, fixture.spaceId, fixture.warehouseId);
    await tx.warehouseAccess.create({ data: { ...fixture, role: 'ADMIN', userId: actorId } });
  });
  const read = async (p) => {
    const response = await request(path + p, cookie);
    assert.equal(response.status, 200, p); return response.json();
  };
  const post = async (p, value) => {
    const response = await request(path + p, cookie, value);
    assert.equal(response.status, 201, p); return response.json();
  };
  const choice = (await read('/outbound-orders')).recommendations[0], staging = (await read('/simulation')).staging[0].id;
  const service = new SimulationService(db, new TransportService(db));
  const command = () => ({ key: randomUUID(), reason: 'Day32 fixture' });
  const start = async () => {
    const order = await post('/outbound-orders', { ...command(), skuId: choice.skuId, batchId: choice.batchId, quantity: 1 });
    const allocated = await post('/outbound-orders/' + order.id + '/allocate', command());
    return service.start(authScope, { allocationId: allocated.allocations[0].id, stagingLocationId: staging, reason: 'Day32 fixture' });
  };
  const tick = async () => service.commit(await service.prepare(fixture.warehouseId));
  const rows = async () => (await db.warehouseReplayFrame.findMany({ where: fixture, orderBy: { tick: 'asc' } }))
    .map((row) => replayFrameSchema.parse({ ...row, capturedAt: row.capturedAt.toISOString() }));
  try {
    const original = layoutSchema.parse(await read('/layout'));
    let result = await start();
    for (let i = 0; i < 150 && result.phase !== 'COMPLETED'; i++) result = await tick();
    assert.equal(result.phase, 'COMPLETED');
    const initial = await rows();
    assert.equal(initial.length, result.tick);
    assert.deepEqual(initial.filter((f) => f.anchor).map((f) => f.tick), [1, ...initial.filter((f) => f.tick % 20 === 0).map((f) => f.tick)]);
    const carrying = initial.find((f) => f.state.robots[0].carrying);
    assert.ok(carrying); assert.deepEqual(carrying.state.inventory, (await read('/inventory')).summary);
    const old = original.layoutVersion.id, replacement = randomUUID();
    const rename = await fetch(apiUrl + path, { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin' },
      body: JSON.stringify({ name: 'Day32 renamed after last tick', version: 0, reason: 'Day32 fixture' }) });
    assert.equal(rename.status, 200);
    const tail = historyPageSchema.parse(await read('/history?' + new URLSearchParams({
      from: initial.at(-1).capturedAt, to: new Date(Date.now() + 1000).toISOString(),
    })));
    assert.ok(tail.through > initial.at(-1).seq);
    assert.equal(tail.events.at(-1).kind, 'WAREHOUSE_RENAMED');
    await db.$transaction(async (tx) => {
      await lockWarehouseState(tx, fixture);
      const layout = await tx.layoutVersion.findUniqueOrThrow({ where: { id: old } });
      await tx.layoutVersion.create({ data: { ...layout, id: replacement, version: 2, status: 'DRAFT' } });
      const zones = new Map(), racks = new Map();
      for (const row of await tx.layoutZone.findMany({ where: { layoutId: old } })) {
        const id = randomUUID(); zones.set(row.id, id);
        await tx.layoutZone.create({ data: { ...row, id, layoutId: replacement } });
      }
      for (const row of await tx.rack.findMany({ where: { layoutId: old } })) {
        const id = randomUUID(); racks.set(row.id, id);
        await tx.rack.create({ data: { ...row, id, layoutId: replacement, zoneId: zones.get(row.zoneId) } });
      }
      for (const row of await tx.layoutLocation.findMany({ where: { layoutId: old } })) {
        await tx.layoutLocation.create({ data: { ...row, layoutId: replacement, zoneId: zones.get(row.zoneId), rackId: racks.get(row.rackId) ?? null } });
      }
      await tx.layoutVersion.update({ where: { id: replacement }, data: { status: 'PUBLISHED' } });
      await tx.warehouse.update({ where: { id: fixture.warehouseId }, data: { activeLayoutId: replacement } });
    });
    assert.equal((await read('/layout')).layoutVersion.id, replacement);
    assert.deepEqual(await read('/history/layouts/' + old), original);
    assert.equal((await request(path + '/history/layouts/' + replacement, cookie)).status, 404);
    await start(); await tick();
    const next = (await rows()).find((f) => f.layoutId === replacement);
    assert.ok(next?.anchor); assert.equal(next.layoutVersion, 2);
    const point = new URLSearchParams({ from: carrying.capturedAt, to: carrying.capturedAt });
    const page = historyPageSchema.parse(await read('/history?' + point));
    assert.ok(page.baseline.seq <= carrying.seq && page.through === carrying.seq);
    require('node:fs').writeFileSync('reports/day32-single-history.json', JSON.stringify({
      capturedAt: new Date().toISOString(), frameCount: initial.length, anchors: initial.filter((f) => f.anchor).map((f) => f.tick),
      carrying: { tick: carrying.tick, inventory: carrying.state.inventory }, replacementAnchor: next.tick, afterLastTick: tail.events.at(-1).kind,
    }));
  } finally { await service.onModuleDestroy(); }
});
