// Disposable QA environment: fixed *test-only* login credential, never loads root .env.
import { createPostgres } from './portable-postgres.mjs';
import database from '../packages/database/index.cjs';
import seeds from '../packages/database/seed.cjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = `postgresql://warehouse:${randomBytes(24).toString('hex')}@127.0.0.1:15434/warehouse_twin_browser`;
const env = { ...process.env, DATABASE_URL: url, DEMO_PASSWORD: 'browser-fixture-only-2026',
  NODE_ENV: 'test', API_PORT: '13004', API_HOST: '127.0.0.1', SESSION_TTL_SECONDS: '3600', SESSION_SECURE: 'false',
  WEB_ORIGINS: 'http://127.0.0.1:15174', API_PROXY_TARGET: 'http://127.0.0.1:13004' };
const db = new database.PrismaClient({ datasourceUrl: url });
const pg = await createPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'warehouse-twin-browser-')), user: 'warehouse',
  password: new URL(url).password, port: 15434, persistent: true, onLog: () => {}, onError: () => {},
  authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'listen_addresses=127.0.0.1'] });
const children = [];
function child(args, cwd = root) {
  const process = spawn(globalThis.process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.on('data', (data) => { console.log(data.toString().trim()); });
  process.stderr.on('data', (data) => { console.error(data.toString().trim()); });
  children.push(process); return process;
}
async function run(args, cwd) { const process = child(args, cwd); const [code] = await once(process, 'exit'); if (code !== 0) throw new Error('QA setup command failed'); }
async function ready(url) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ } await delay(150); }
  throw new Error('QA server did not become ready');
}
async function cloneLayout(tx, warehouseId, version, shiftRack = false, emptyWarehouse = false) {
  const original = await tx.warehouse.findUniqueOrThrow({ where: { id: seeds.ids.warehouseA } });
  const old = await tx.layoutVersion.findUniqueOrThrow({ where: { id: original.activeLayoutId } });
  const layoutId = randomUUID(), scope = { spaceId: seeds.ids.spaceA, warehouseId };
  await tx.layoutVersion.create({ data: { ...scope, id: layoutId, version, width: old.width, depth: old.depth } });
  const zones = new Map(), racks = new Map();
  for (const zone of await tx.layoutZone.findMany({ where: { layoutId: old.id } })) {
    const id = randomUUID(); zones.set(zone.id, id); await tx.layoutZone.create({ data: { ...zone, ...scope, id, layoutId } });
  }
  for (const rack of await tx.rack.findMany({ where: { layoutId: old.id } })) {
    const id = randomUUID(); racks.set(rack.id, id);
    await tx.rack.create({ data: { ...rack, ...scope, id, layoutId, zoneId: zones.get(rack.zoneId), gridX: rack.gridX + (shiftRack && rack.code === 'R01' ? 2 : 0) } });
  }
  const locations = await tx.layoutLocation.findMany({ where: { layoutId: old.id }, include: { location: true, rack: true } });
  for (const { location, rack, ...placement } of locations) {
    const locationId = emptyWarehouse ? randomUUID() : placement.locationId;
    if (emptyWarehouse) await tx.location.create({ data: { ...scope, id: locationId, code: location.code, kind: location.kind } });
    const shift = shiftRack && rack?.code === 'R01' ? 2 : 0;
    await tx.layoutLocation.create({ data: { ...placement, ...scope, layoutId, locationId, zoneId: zones.get(placement.zoneId),
      rackId: racks.get(placement.rackId) ?? null, gridX: placement.gridX + shift, serviceX: placement.serviceX + shift } });
  }
  await tx.layoutVersion.update({ where: { id: layoutId }, data: { status: 'PUBLISHED' } });
  await tx.warehouse.update({ where: { id: warehouseId }, data: { activeLayoutId: layoutId } });
}
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  for (const process of children) if (process.exitCode === null && process.signalCode === null) { const closed = once(process, 'close'); process.kill(); await closed; }
  await db.$disconnect(); await pg.stop();
}
try {
  mkdirSync(`${root}/output/playwright/day-04`, { recursive: true });
  await pg.initialise(); await pg.start(); await pg.createDatabase('warehouse_twin_browser');
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], `${root}/packages/database`);
  await run(['seed.cjs'], `${root}/packages/database`);
  const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
  const emptyId = '20000000-0000-4000-8000-000000000003';
  await db.$transaction(async (tx) => {
    await tx.warehouseAccess.create({ data: { userId: admin.id, spaceId: seeds.ids.spaceB, warehouseId: seeds.ids.warehouseB, role: 'VIEWER' } });
    await tx.warehouse.create({ data: { id: emptyId, spaceId: seeds.ids.spaceA, name: 'QA 空库存仓库' } });
    await cloneLayout(tx, emptyId, 1, false, true);
    await tx.warehouseAccess.create({ data: { userId: admin.id, spaceId: seeds.ids.spaceA, warehouseId: emptyId, role: 'VIEWER' } });
  }, { timeout: 15000 });
  child(['apps/api/dist/main.js']);
  child(['apps/web/node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', '15174', '--strictPort']);
  await ready('http://127.0.0.1:13004/health'); await ready('http://127.0.0.1:15174');
  console.log('QA READY http://127.0.0.1:15174 — test account admin@demo.local. Commands: layout-v2, reserve, expire, stop');
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line.trim() === 'layout-v2') { await db.$transaction((tx) => cloneLayout(tx, seeds.ids.warehouseA, 2, true), { timeout: 15000 }); console.log('QA: layout v2 published; R01 moved two grid cells'); }
    if (line.trim() === 'reserve') {
      const balance = await db.inventoryBalance.findFirstOrThrow({ where: { warehouseId: seeds.ids.warehouseA, quality: 'RELEASED', onHand: { gte: 3 } }, orderBy: { onHand: 'desc' } });
      await db.inventoryBalance.update({ where: { id: balance.id }, data: { reserved: 2 } });
      console.log('QA: two units reserved in fixture only; no production reservation command is implied');
    }
    if (line.trim() === 'expire') { await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } }); console.log('QA: all fixture sessions expired'); }
    if (line.trim() === 'stop') { input.close(); break; }
  }
} finally { await stop(); }
