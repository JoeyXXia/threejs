import { createPostgres } from './portable-postgres.mjs';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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
  writeFileSync(`${root}/reports/day-02-environment.json`, JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, postgres: result.rows[0].version }, null, 2));
  await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], `${root}/packages/database`);
  await run(['seed.cjs'], `${root}/packages/database`);
  await run(['seed.cjs'], `${root}/packages/database`);
  await run(['node_modules/jest/bin/jest.js', '--config', 'tests/integration/jest.config.cjs', '--runInBand', '--json', '--outputFile', 'reports/day-02-jest.json']);
} finally {
  if (started) await pg.stop();
}
