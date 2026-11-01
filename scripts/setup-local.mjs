import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(path)) throw new Error('.env already exists; refusing to overwrite');
const dbPassword = randomBytes(24).toString('hex');
const demoPassword = randomBytes(16).toString('hex');
writeFileSync(path, `API_HOST=127.0.0.1\nAPI_PORT=3000\nAPI_PROXY_TARGET=http://127.0.0.1:3000\nDATABASE_URL=postgresql://warehouse:${dbPassword}@127.0.0.1:5432/warehouse_twin\nPOSTGRES_PASSWORD=${dbPassword}\nDEMO_PASSWORD=${demoPassword}\nSESSION_TTL_SECONDS=3600\nSESSION_SECURE=false\nWEB_ORIGINS=http://127.0.0.1:5173,http://localhost:5173\n`, { flag: 'wx', mode: 0o600 });
console.log('Created ignored root .env. Read DEMO_PASSWORD locally to sign in; do not publish it.');
