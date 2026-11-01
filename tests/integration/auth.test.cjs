const { PrismaClient } = require('../../packages/database');
const { seed, ids } = require('../../packages/database/seed.cjs');
const request = require('supertest');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { resolve } = require('node:path');

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || new URL(testUrl).pathname !== '/warehouse_twin_test' || new URL(testUrl).hostname !== '127.0.0.1') {
  throw new Error('Integration suite only accepts local /warehouse_twin_test');
}
process.env.DATABASE_URL = testUrl;
const db = new PrismaClient({ datasourceUrl: testUrl });
const pathA = `/spaces/${ids.spaceA}/warehouses/${ids.warehouseA}`;
const pathB = `/spaces/${ids.spaceB}/warehouses/${ids.warehouseB}`;
let server;
const http = 'http://127.0.0.1:13001';
const csrf = (req) => req.set('X-Requested-With', 'WarehouseTwin');
const login = (role = 'admin', password = process.env.DEMO_PASSWORD) => csrf(request(http).post('/auth/login')).send({ email: `${role}@demo.local`, password });
const cookie = (response) => response.headers['set-cookie'][0].split(';')[0];
const patch = (token, path, body) => csrf(request(http).patch(path)).set('Cookie', token).send(body);

beforeEach(async () => {
  await db.session.deleteMany();
  server = spawn(process.execPath, ['apps/api/dist/main.js'], {
    cwd: resolve(__dirname, '../..'), windowsHide: true,
    env: { ...process.env, API_PORT: '13001', API_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (data) => { output += data.toString(); });
  server.stderr.on('data', (data) => { output += data.toString(); });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`API exited: ${output}`);
    try { if ((await fetch(`${http}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error(`API startup timed out: ${output}`);
});
afterEach(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'close'); server.kill(); await closed;
  }
});
afterAll(async () => { await db.$disconnect(); });

test('seed is repeatable and preserves credentials and warehouse state', async () => {
  const before = await db.user.findMany({ orderBy: { email: 'asc' } });
  await seed(testUrl, process.env.DEMO_PASSWORD);
  const after = await db.user.findMany({ orderBy: { email: 'asc' } });
  expect(after).toEqual(before);
  expect(after).toHaveLength(4);
  expect(await db.space.count()).toBe(2);
  expect(await db.warehouse.count()).toBe(2);
  expect(await db.warehouseAccess.count()).toBe(4);
});

test('unauthenticated reads and writes return 401', async () => {
  await request(http).get('/auth/me').expect(401);
  await request(http).get(pathA).expect(401);
  await csrf(request(http).patch(pathA)).send({ name: 'x', version: 0, reason: 'test' }).expect(401);
});

test('wrong password and unknown email have the same failure; malformed fields are rejected', async () => {
  const wrong = await login('admin', 'incorrect');
  const missing = await login('missing', 'incorrect');
  expect(wrong.status).toBe(401); expect(missing.status).toBe(401);
  expect(wrong.body).toEqual(missing.body);
  await csrf(request(http).post('/auth/login')).send({ email: 'admin@demo.local', password: process.env.DEMO_PASSWORD, role: 'ADMIN' }).expect(400);
  await csrf(request(http).post('/auth/login')).send({ email: [], password: 'wrong' }).expect(400);
  expect(await db.session.count()).toBe(0);
});

test('login cookie is HttpOnly/SameSite; only the SHA256 token digest is stored', async () => {
  const result = await login(); expect(result.status).toBe(201);
  expect(result.headers['set-cookie'][0]).toMatch(/HttpOnly; SameSite=Strict; Max-Age=3600/);
  expect(result.headers['cache-control']).toBe('no-store');
  const raw = cookie(result).split('=')[1];
  const session = await db.session.findFirst();
  expect(session.tokenHash).toBe(createHash('sha256').update(raw).digest('hex'));
  expect(JSON.stringify(result.body)).not.toContain(raw);
  expect(result.body.user.passwordHash).toBeUndefined();
});

test('viewer can read only its authorized warehouse', async () => {
  const token = cookie(await login('viewer'));
  const me = await request(http).get('/auth/me').set('Cookie', token).expect(200);
  expect(me.body.warehouses).toHaveLength(1);
  expect(me.body.warehouses[0]).toMatchObject({ id: ids.warehouseA, spaceId: ids.spaceA, role: 'VIEWER' });
  await request(http).get(pathA).set('Cookie', token).expect(200);
  expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|tokenHash/);
});

test('viewer write is forbidden with no database side effects', async () => {
  const token = cookie(await login('viewer'));
  const before = await db.warehouse.findUnique({ where: { id: ids.warehouseA } });
  const count = await db.auditLog.count();
  await patch(token, pathA, { name: 'forbidden', reason: 'test', version: before.version }).expect(403);
  expect(await db.warehouse.findUnique({ where: { id: ids.warehouseA } })).toEqual(before);
  expect(await db.auditLog.count()).toBe(count);
});

test.each(['admin', 'operator'])('%s can rename; audit derives actor from session', async (role) => {
  const token = cookie(await login(role));
  const before = await db.warehouse.findUnique({ where: { id: ids.warehouseA } });
  const count = await db.auditLog.count();
  await patch(token, pathA, { name: `${role} updated`, reason: 'integration verification', version: before.version }).expect(200);
  const audit = await db.auditLog.findFirst({ orderBy: { createdAt: 'desc' } });
  const user = await db.user.findUnique({ where: { email: `${role}@demo.local` } });
  expect(audit).toMatchObject({ actorId: user.id, spaceId: ids.spaceA, warehouseId: ids.warehouseA, action: 'WAREHOUSE_RENAMED' });
  expect(audit.before).toEqual({ name: before.name, version: before.version });
  expect(audit.after).toEqual({ name: `${role} updated`, version: before.version + 1 });
  expect(await db.auditLog.count()).toBe(count + 1);
});

test('cross-space reads/writes and mismatched IDs all return 404', async () => {
  const token = cookie(await login());
  const before = await db.warehouse.findUnique({ where: { id: ids.warehouseB } });
  for (const path of [pathB, `/spaces/${ids.spaceA}/warehouses/${ids.warehouseB}`, `/spaces/${ids.spaceB}/warehouses/${ids.warehouseA}`]) {
    await request(http).get(path).set('Cookie', token).expect(404);
    await patch(token, path, { name: 'attack', version: 0, reason: 'attack' }).expect(404);
  }
  expect(await db.warehouse.findUnique({ where: { id: ids.warehouseB } })).toEqual(before);
});

test('actor and scope cannot be injected through request body', async () => {
  const token = cookie(await login());
  const before = await db.warehouse.findUnique({ where: { id: ids.warehouseA } });
  for (const extra of [{ actorId: 'fake' }, { spaceId: ids.spaceB }, { role: 'ADMIN' }]) {
    await patch(token, pathA, { name: 'attack', reason: 'attack', version: before.version, ...extra }).expect(400);
  }
  await request(http).get('/spaces/invalid/warehouses/invalid').set('Cookie', token).expect(400);
});

test('database composite FK rejects a warehouse belonging to another space', async () => {
  const user = await db.user.findUnique({ where: { email: 'other@demo.local' } });
  await expect(db.warehouseAccess.create({ data: { userId: user.id, spaceId: ids.spaceA, warehouseId: ids.warehouseB, role: 'ADMIN' } }))
    .rejects.toMatchObject({ code: 'P2003' });
});

test('expired, forged and logged-out session tokens are rejected', async () => {
  const token = cookie(await login());
  await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
  await request(http).get('/auth/me').set('Cookie', token).expect(401);
  await request(http).get('/auth/me').set('Cookie', `wt_session=${'a'.repeat(64)}`).expect(401);
  const fresh = cookie(await login());
  const logout = await csrf(request(http).post('/auth/logout')).set('Cookie', fresh).expect(201);
  expect(logout.headers['set-cookie'][0]).toContain('Max-Age=0');
  await request(http).get('/auth/me').set('Cookie', fresh).expect(401);
});

test('role downgrade and access revocation take effect without relogin', async () => {
  const token = cookie(await login('operator'));
  const user = await db.user.findUnique({ where: { email: 'operator@demo.local' } });
  const key = { userId: user.id, spaceId: ids.spaceA, warehouseId: ids.warehouseA };
  try {
    await db.warehouseAccess.update({ where: { userId_spaceId_warehouseId: key }, data: { role: 'VIEWER' } });
    await patch(token, pathA, { name: 'blocked', version: 0, reason: 'test' }).expect(403);
    await db.warehouseAccess.delete({ where: { userId_spaceId_warehouseId: key } });
    await request(http).get(pathA).set('Cookie', token).expect(404);
    const me = await request(http).get('/auth/me').set('Cookie', token).expect(200);
    expect(me.body.warehouses).toHaveLength(0);
  } finally {
    await db.warehouseAccess.upsert({ where: { userId_spaceId_warehouseId: key }, update: { role: 'OPERATOR' }, create: { ...key, role: 'OPERATOR' } });
  }
});

test('two concurrent writes with the same version commit once and audit once', async () => {
  const token = cookie(await login());
  const before = await db.warehouse.findUnique({ where: { id: ids.warehouseA } });
  const count = await db.auditLog.count();
  const results = await Promise.all(['one', 'two'].map((name) => patch(token, pathA, { name, reason: 'concurrency', version: before.version })));
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await db.auditLog.count()).toBe(count + 1);
});

test('audit failure rolls back warehouse write without exposing database errors', async () => {
  const token = cookie(await login());
  const before = await db.warehouse.findUnique({ where: { id: ids.warehouseA } });
  await db.$executeRawUnsafe(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END; $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER fail_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_audit()`);
  try {
    const result = await patch(token, pathA, { name: 'must rollback', reason: 'failure injection', version: before.version }).expect(500);
    expect(result.body).toEqual({ message: 'Internal server error' });
    expect(await db.warehouse.findUnique({ where: { id: ids.warehouseA } })).toEqual(before);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER fail_audit ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION reject_audit()`);
  }
});

test('idempotency foundation enforces the scoped operation key', async () => {
  const user = await db.user.findUnique({ where: { email: 'admin@demo.local' } });
  const data = { actorId: user.id, spaceId: ids.spaceA, warehouseId: ids.warehouseA, operation: 'FOUNDATION_TEST', key: 'same', requestHash: 'hash', status: 'PENDING' };
  await db.idempotencyRecord.create({ data });
  await expect(db.idempotencyRecord.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  await db.idempotencyRecord.create({ data: { ...data, operation: 'OTHER_OPERATION' } });
});

test('unsafe requests require custom header and an allowed browser origin', async () => {
  await request(http).post('/auth/login').send({}).expect(403);
  await csrf(request(http).post('/auth/login')).set('Origin', 'https://untrusted.example').send({}).expect(403);
  await csrf(request(http).post('/auth/login')).set('Origin', 'http://127.0.0.1:5173').send({}).expect(400);
});

test('single-process login throttle rejects the eleventh attempt', async () => {
  for (let i = 0; i < 10; i++) expect((await login('missing', 'wrong')).status).toBe(401);
  expect((await login('missing', 'wrong')).status).toBe(429);
});
