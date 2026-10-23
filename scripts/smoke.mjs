import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
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
  assert.match(await module.text(), /checkHealth/);
  assert.deepEqual(await (await ready('http://127.0.0.1:15173/api/health')).json(), expected);
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
