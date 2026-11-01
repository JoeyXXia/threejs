import { createPostgres } from './portable-postgres.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
process.loadEnvFile(`${root}/.env`);
const url = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/warehouse_twin') {
  throw new Error('Local runner requires localhost /warehouse_twin');
}
const dir = process.platform === 'win32' ? join(tmpdir(), 'warehouse-twin-dev-day02') : `${root}/.local/postgres-dev`;
mkdirSync(`${root}/.local`, { recursive: true });
const pg = await createPostgres({
  databaseDir: dir, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  port: Number(url.port || 5432), persistent: true, authMethod: 'scram-sha-256',
  initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
  onLog: () => {}, onError: () => {},
});
if (!existsSync(`${dir}/PG_VERSION`)) await pg.initialise();
await pg.start();
const client = pg.getPgClient();
await client.connect();
const databases = await client.query("SELECT 1 FROM pg_database WHERE datname = 'warehouse_twin'");
if (!databases.rowCount) await pg.createDatabase('warehouse_twin');
console.log(`Local PostgreSQL ready on 127.0.0.1:${url.port || 5432}; data directory: ${dir}`);
await client.end();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await pg.stop();
  process.exit(0);
});
