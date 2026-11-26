import { Queue, Worker } from 'bullmq';
import { PrismaClient } from '@warehouse-twin/database';
import { setTimeout as delay } from 'node:timers/promises';
import { dispatchReportQueue, generateDispatchReport, relayDispatchReports, type DispatchReportMessage } from './dispatch-report';

async function run() {
  if (!process.env.DATABASE_URL || !process.env.REPORT_REDIS_HOST) throw new Error('Missing report worker configuration');
  const port = Number(process.env.REPORT_REDIS_PORT ?? 6379);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Redis port');
  const password = process.env.REPORT_REDIS_PASSWORD;
  const connection = { host: process.env.REPORT_REDIS_HOST, port, ...(password ? { password } : {}), connectTimeout: 1500 };
  const db = new PrismaClient();
  const queue = new Queue<DispatchReportMessage>(dispatchReportQueue, {
    connection: { ...connection, maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 1500 },
  });
  const worker = new Worker<DispatchReportMessage>(dispatchReportQueue,
    (job) => generateDispatchReport(db, job.name, job.data, job.id), { connection: { ...connection, maxRetriesPerRequest: null } });
  const controller = new AbortController();
  let relayFault = false, redisFault = false;
  const redisError = () => {
    if (!redisFault && !controller.signal.aborted) console.error('Report queue transport unavailable; pending intents stay in PostgreSQL');
    redisFault = true;
  };
  queue.on('error', redisError); worker.on('error', redisError);
  worker.on('ready', () => { redisFault = false; });
  worker.on('failed', (job) => console.error(`Dispatch report job failed: ${job?.id ?? 'unknown'}`));
  let timeout: NodeJS.Timeout | undefined;
  const stop = () => {
    controller.abort();
    timeout ??= setTimeout(() => process.exit(1), 5000).unref();
    void queue.disconnect().catch(() => undefined);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!controller.signal.aborted) {
      try {
        await relayDispatchReports(db, (name, data, jobId) => queue.add(name, data, { jobId, attempts: 1, removeOnComplete: true }));
        if (relayFault) console.log('Dispatch report relay recovered');
        relayFault = false;
      } catch {
        if (!relayFault && !controller.signal.aborted) console.error('Dispatch report relay deferred');
        relayFault = true;
      }
      await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  } finally {
    await worker.close();
    await db.$disconnect();
    clearTimeout(timeout);
  }
}

run().catch(() => { console.error('Report worker startup failed; check database and Redis configuration'); process.exitCode = 1; });
