import EmbeddedPostgres from 'embedded-postgres';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

// PostgreSQL Windows initdb also embeds its executable/library path in UTF8.
// Copy the npm-distributed native tree to an ASCII temp path, without changing dependencies.
export async function createPostgres(options) {
  if (process.platform !== 'win32') return new EmbeddedPostgres(options);
  const require = createRequire(import.meta.resolve('embedded-postgres'));
  const binaries = await import(pathToFileURL(require.resolve('@embedded-postgres/windows-x64')));
  const native = join(tmpdir(), 'warehouse-twin-pg-18.6.0-beta.19');
  if ([...native].some((character) => character.charCodeAt(0) > 127)) throw new Error('Windows PostgreSQL requires an ASCII TEMP directory');
  if (!existsSync(join(native, '.ready'))) {
    cpSync(dirname(dirname(binaries.postgres)), native, { recursive: true });
    writeFileSync(join(native, '.ready'), 'npm binary cache');
  }
  async function command(binary, args) {
    await new Promise((resolve, reject) => {
      const child = spawn(join(native, 'bin', binary), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => { output += data.toString(); });
      child.stderr.on('data', (data) => { output += data.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${binary} failed (${code}): ${output}`)));
    });
  }
  class WindowsPostgres extends EmbeddedPostgres {
    running = false;
    async initialise() {
      mkdirSync(options.databaseDir, { recursive: true });
      const passwordFile = `${options.databaseDir}.init-password`;
      writeFileSync(passwordFile, options.password, { mode: 0o600, flag: 'wx' });
      try {
        await command('initdb.exe', ['-D', options.databaseDir, '-U', options.user, '--pwfile', passwordFile,
          '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
      } finally { unlinkSync(passwordFile); }
    }
    async start() {
      await command('pg_ctl.exe', ['-D', options.databaseDir, '-l', join(options.databaseDir, 'server.log'),
        '-o', `-h 127.0.0.1 -p ${options.port}`, '-w', 'start']);
      this.running = true;
    }
    async stop() {
      if (!this.running) return;
      await command('pg_ctl.exe', ['-D', options.databaseDir, '-m', 'fast', '-w', 'stop']);
      this.running = false;
    }
    async createDatabase(name) {
      if (!this.running || !/^[a-z_]+$/.test(name)) throw new Error('Invalid local database name or state');
      const client = this.getPgClient();
      await client.connect();
      try { await client.query(`CREATE DATABASE "${name}"`); }
      finally { await client.end(); }
    }
  }
  return new WindowsPostgres(options);
}
