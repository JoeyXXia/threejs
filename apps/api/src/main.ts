import 'reflect-metadata';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configure } from './configure';

async function bootstrap() {
  // Both workspace dev and package start run with apps/api as cwd.
  const envPath = resolve(__dirname, '../../../.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const port = Number(process.env.API_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT must be an integer between 1 and 65535');
  }
  const app = await NestFactory.create(AppModule);
  configure(app);
  app.enableShutdownHooks();
  await app.listen(port, process.env.API_HOST ?? '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  // Avoid printing errors that may contain connection strings or credentials.
  console.error(error instanceof Error && error.message === 'API_PORT must be an integer between 1 and 65535'
    ? error.message : 'API startup failed; check configuration and database connectivity');
  process.exitCode = 1;
});
