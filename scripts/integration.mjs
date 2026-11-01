import { createPostgres } from './portable-postgres.mjs';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import database from '../packages/database/index.cjs';
import ledger from '../packages/database/reconcile.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Always create our own cluster/database; never use or reset DATABASE_URL/.env.
const password = randomBytes(24).toString('hex');
const databaseUrl = `postgresql://warehouse:${password}@127.0.0.1:15432/warehouse_twin_test`;
const env = { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl,
  DEMO_PASSWORD: randomBytes(16).toString('hex'), NODE_ENV: 'test', SESSION_TTL_SECONDS: '3600', SESSION_SECURE: 'false',
  WEB_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173' };
mkdirSync(`${root}/.local`, { recursive: true });
mkdirSync(`${root}/reports`, { recursive: true });
const pg = await createPostgres({
  databaseDir: mkdtempSync(join(tmpdir(), 'warehouse-twin-test-')), user: 'warehouse', password, port: 15432,
  persistent: true, authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => {}, onError: () => {},
});
async function run(args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Command failed (${code})`)));
  });
}
let started = false;
try {
  await pg.initialise();
  await pg.start(); started = true;
  await pg.createDatabase('warehouse_twin_test');
  const client = pg.getPgClient(); await client.connect();
  const result = await client.query('SELECT version()'); await client.end();
  writeFileSync(`${root}/reports/day-03-environment.json`, JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, postgres: result.rows[0].version }, null, 2));
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], `${root}/packages/database`);
  await run(['seed.cjs'], `${root}/packages/database`);
  await run(['seed.cjs'], `${root}/packages/database`);
  await run(['node_modules/jest/bin/jest.js', '--config', 'tests/integration/jest.config.cjs', '--runInBand', '--json', '--outputFile', 'reports/day-03-jest.json']);
  // Verify persisted rows after a real database restart, once all HTTP test processes have closed.
  await pg.stop(); await pg.start();
  const db = new database.PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const evidence = await db.$transaction(async (tx) => {
      const mismatches = await ledger.reconcile(tx);
      const warehouses = await tx.warehouse.findMany({ include: { activeLayout: true }, orderBy: { id: 'asc' } });
      const samples = [];
      for (const warehouse of warehouses) {
        const where = { spaceId: warehouse.spaceId, warehouseId: warehouse.id };
        const totals = await tx.inventoryBalance.aggregate({ where, _sum: { onHand: true, reserved: true } });
        samples.push({ ...where, layoutId: warehouse.activeLayoutId, layoutVersion: warehouse.activeLayout?.version,
          zones: await tx.layoutZone.count({ where: { layoutId: warehouse.activeLayoutId } }),
          racks: await tx.rack.count({ where: { layoutId: warehouse.activeLayoutId } }),
          locations: await tx.location.count({ where }), balances: await tx.inventoryBalance.count({ where }),
          movements: await tx.inventoryMovement.count({ where }), skus: await tx.sku.count({ where }), batches: await tx.batch.count({ where }),
          onHand: totals._sum.onHand, reserved: totals._sum.reserved });
      }
      return { capturedAt: new Date().toISOString(), databaseRestarted: true, consistent: mismatches.length === 0, mismatches, warehouses: samples };
    }, { isolationLevel: 'RepeatableRead' });
    writeFileSync(`${root}/reports/day-03-inventory.json`, JSON.stringify(evidence, null, 2));
    if (!evidence.consistent) throw new Error('Post-restart inventory reconciliation failed');
    console.log('PASS: database restart and full balance/ledger reconciliation');
  } finally { await db.$disconnect(); }
} finally {
  if (started) await pg.stop();
}
