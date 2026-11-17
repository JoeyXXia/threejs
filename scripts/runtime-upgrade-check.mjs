import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import seeds from '../packages/database/seed.cjs';

const url = process.env.UPGRADE_TEST_DATABASE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/warehouse_twin_upgrade_test') throw new Error('Isolated upgrade DB required');
const require = createRequire(import.meta.resolve('embedded-postgres'));
const { Client } = require('pg');
const client = new Client({ connectionString: url });
const root = fileURLToPath(new URL('../', import.meta.url));
const migrationRoot = `${root}/packages/database/prisma/migrations`;
const target = '202611130001_runtime_events';
await client.connect();
try {
  const migrations = readdirSync(migrationRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of migrations.filter((name) => name < target)) await client.query(readFileSync(`${migrationRoot}/${name}/migration.sql`, 'utf8'));
  await seeds.seed(url, process.env.DEMO_PASSWORD);
  async function existing() {
    const snapshot = {};
    for (const table of ['User', 'Warehouse', 'InventoryBalance', 'InventoryMovement', 'Batch', 'WarehouseAccess']) {
      snapshot[table] = (await client.query(`SELECT * FROM "${table}" ORDER BY 1,2`)).rows;
    }
    return snapshot;
  }
  const before = await existing();
  await client.query(readFileSync(`${migrationRoot}/${target}/migration.sql`, 'utf8'));
  assert.deepEqual(await existing(), before, 'upgrade must not alter existing business rows or password hashes');
  const rows = (await client.query('SELECT * FROM "WarehouseRuntime" ORDER BY "warehouseId"')).rows;
  assert.equal(rows.length, before.Warehouse.length);
  assert.ok(rows.every((r) => r.seq === 0 && r.tick === 0 && r.epoch === 0 && r.checkpoint === null && r.ownerId === null));
  writeFileSync(`${root}/reports/day19-upgrade.json`, JSON.stringify({ capturedAt: new Date().toISOString(),
    unchanged: true, users: before.User.length, warehouses: before.Warehouse.length, balances: before.InventoryBalance.length,
    movements: before.InventoryMovement.length, runtimesBackfilled: rows.length, initialWatermark: 0 }, null, 2));
  for (const name of migrations.filter((name) => name > target)) await client.query(readFileSync(`${migrationRoot}/${name}/migration.sql`, 'utf8'));
  assert.deepEqual(await existing(), before, 'later migrations must preserve existing business rows and credentials');
  writeFileSync(`${root}/reports/day20-upgrade.json`, JSON.stringify({ capturedAt: new Date().toISOString(),
    unchanged: true, latestMigration: migrations.at(-1), warehouses: before.Warehouse.length,
    balances: before.InventoryBalance.length, movements: before.InventoryMovement.length,
    putawayTasks: Number((await client.query('SELECT count(*) FROM "PutawayTask"')).rows[0].count) }, null, 2));
  console.log('PASS: Day 18 schema/seed upgrades without changing business rows or credentials; runtime backfilled at seq 0');
} finally { await client.end(); }
