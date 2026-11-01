import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(`${root}/.env`)) process.loadEnvFile(`${root}/.env`);
const commands = {
  generate: ['node_modules/prisma/build/index.js', 'generate'],
  migrate: ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  seed: ['seed.cjs'],
};
const args = commands[process.argv[2]];
if (!args) throw new Error('Expected generate, migrate or seed');
const result = spawnSync(process.execPath, args, { cwd: `${root}/packages/database`, env: process.env, stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
