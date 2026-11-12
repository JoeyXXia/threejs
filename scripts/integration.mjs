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
const inboundDatabaseUrl = `postgresql://warehouse:${password}@127.0.0.1:15432/warehouse_twin_inbound_test`;
const env = { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, INBOUND_TEST_DATABASE_URL: inboundDatabaseUrl,
  DEMO_PASSWORD: randomBytes(16).toString('hex'), NODE_ENV: 'test', SESSION_TTL_SECONDS: '3600', SESSION_SECURE: 'false',
  WEB_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173' };
mkdirSync(`${root}/.local`, { recursive: true });
mkdirSync(`${root}/reports`, { recursive: true });
const pg = await createPostgres({
  databaseDir: mkdtempSync(join(tmpdir(), 'warehouse-twin-test-')), user: 'warehouse', password, port: 15432,
  persistent: true, authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => {}, onError: () => {},
});
async function run(args, cwd = root, commandEnv = env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: commandEnv, stdio: 'inherit', windowsHide: true });
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
  writeFileSync(`${root}/reports/integration-environment.json`, JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, postgres: result.rows[0].version }, null, 2));
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], `${root}/packages/database`);
  await run(['seed.cjs'], `${root}/packages/database`);
  await run(['seed.cjs'], `${root}/packages/database`);
  // Keep the original 44 regression assertions intact: Day 8 uses another DB in this same cluster.
  await pg.createDatabase('warehouse_twin_inbound_test');
  const inboundEnv = { ...env, DATABASE_URL: inboundDatabaseUrl };
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], `${root}/packages/database`, inboundEnv);
  await run(['seed.cjs'], `${root}/packages/database`, inboundEnv);
  // Use Node's normal module loader for direct imports of the Nest domain services.
  await run(['--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', '--test-reporter-destination=reports/integration-transport.tap', 'tests/transport/transport.test.cjs', 'tests/transport/simulation.test.cjs']);
  await run(['node_modules/jest/bin/jest.js', '--config', 'tests/integration/jest.config.cjs', '--runInBand', '--json', '--outputFile', 'reports/integration-jest.json']);
  // Verify persisted rows after a real database restart, once all HTTP test processes have closed.
  await pg.stop(); await pg.start();
  const results = [];
  for (const datasourceUrl of [databaseUrl, inboundDatabaseUrl]) {
  const db = new database.PrismaClient({ datasourceUrl });
  try {
    const evidence = await db.$transaction(async (tx) => {
      const mismatches = await ledger.reconcile(tx);
      const reservationMismatches = await ledger.reconcileReservations(tx);
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
      return { capturedAt: new Date().toISOString(), databaseRestarted: true, consistent: mismatches.length === 0 && reservationMismatches.length === 0, mismatches, reservationMismatches, warehouses: samples };
    }, { isolationLevel: 'RepeatableRead' });
    results.push({ database: new URL(datasourceUrl).pathname.slice(1), ...evidence });
    if (!evidence.consistent) throw new Error('Post-restart inventory reconciliation failed');
    console.log('PASS: database restart, physical ledger, reservation/order, transit and staging reconciliation');
  } finally { await db.$disconnect(); }
  }
  writeFileSync(`${root}/reports/integration-inventory.json`, JSON.stringify({ capturedAt: new Date().toISOString(), databaseRestarted: true,
    consistent: results.every((result) => result.consistent), mismatches: results.flatMap((result) => result.mismatches),
    reservationMismatches: results.flatMap((result) => result.reservationMismatches), databases: results }, null, 2));
} finally {
  if (started) await pg.stop();
}
