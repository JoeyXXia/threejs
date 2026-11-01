import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const withAuth = process.argv.includes('--with-auth');
if (withAuth && existsSync(`${root}/.env`)) process.loadEnvFile(`${root}/.env`);
const children = [];
let logs = '';

async function requireFreePort(port) {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
}

function start(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => { logs = (logs + data.toString()).slice(-12000); });
  }
  child.on('error', (error) => { logs += error.message; });
  children.push(child);
}

async function ready(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch { /* Startup may still be in progress. */ }
    if (children.some((child) => child.exitCode !== null)) throw new Error(`Server exited early: ${logs}`);
    await delay(250);
  }
  throw new Error(`Startup timed out: ${url}\n${logs}`);
}

try {
  await requireFreePort(13000);
  await requireFreePort(15173);
  const apiArgs = process.argv.includes('--dev-api')
    ? ['--import', './apps/api/node_modules/tsx/dist/loader.mjs', 'apps/api/src/main.ts']
    : ['apps/api/dist/main.js'];
  start(apiArgs, {
    API_PORT: '13000',
    API_HOST: '127.0.0.1',
    TSX_TSCONFIG_PATH: 'apps/api/tsconfig.json',
    WEB_ORIGINS: 'http://127.0.0.1:15173',
  });
  start(['apps/web/node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', '15173', '--strictPort'], {
    API_PROXY_TARGET: 'http://127.0.0.1:13000',
  });
  const expected = { status: 'ok', service: 'warehouse-twin-api', devices: 'simulated' };
  assert.deepEqual(await (await ready('http://127.0.0.1:13000/health')).json(), expected);
  const html = await (await ready('http://127.0.0.1:15173')).text();
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /WarehouseTwin/);
  const module = await fetch('http://127.0.0.1:15173/src/App.tsx');
  assert.equal(module.status, 200);
  assert.match(await module.text(), /parseSession/);
  assert.deepEqual(await (await ready('http://127.0.0.1:15173/api/health')).json(), expected);
  const anonymous = await fetch('http://127.0.0.1:15173/api/auth/me');
  assert.equal(anonymous.status, 401);
  if (withAuth) {
    if (!process.env.DEMO_PASSWORD) throw new Error('DEMO_PASSWORD is required for auth smoke');
    const login = await fetch('http://127.0.0.1:15173/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin', Origin: 'http://127.0.0.1:15173' },
      body: JSON.stringify({ email: 'admin@demo.local', password: process.env.DEMO_PASSWORD }),
    });
    assert.equal(login.status, 201);
    const token = login.headers.getSetCookie()[0]?.split(';')[0];
    assert.ok(token);
    const me = await fetch('http://127.0.0.1:15173/api/auth/me', { headers: { Cookie: token } });
    assert.equal(me.status, 200);
    const identity = await me.json();
    assert.equal(identity.user.email, 'admin@demo.local');
    assert.equal(identity.warehouses.length, 1);
    const logout = await fetch('http://127.0.0.1:15173/api/auth/logout', {
      method: 'POST', headers: { Cookie: token, 'X-Requested-With': 'WarehouseTwin', Origin: 'http://127.0.0.1:15173' },
    });
    assert.equal(logout.status, 201);
    assert.equal((await fetch('http://127.0.0.1:15173/api/auth/me', { headers: { Cookie: token } })).status, 401);
    console.log('PASS: login, scoped identity, logout and revoked cookie through Vite proxy');
  }
  const missing = await fetch('http://127.0.0.1:13000/missing');
  assert.equal(missing.status, 404);
  console.log('PASS: API health, 404, web HTML, React module transform, Vite API proxy');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }));
}
