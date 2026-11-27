// Test-only child: exit after the actual PostgreSQL commit and before BullMQ can acknowledge it.
const { PrismaClient } = require('../../packages/database');
const { Worker } = require('../../apps/api/node_modules/bullmq');
const { dispatchReportQueue, generateDispatchReport } = require('../../apps/api/dist/jobs/dispatch-report');

const { DATABASE_URL, REPORT_REDIS_PORT, TEST_REPORT_JOB_ID } = process.env;
const url = new URL(DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/warehouse_twin_inbound_test' || !TEST_REPORT_JOB_ID) {
  throw new Error('Isolated test DB and exact expected job required');
}
const db = new PrismaClient();
const worker = new Worker(dispatchReportQueue, async (job) => {
  if (job.id !== TEST_REPORT_JOB_ID) process.exit(74);
  await generateDispatchReport(db, job.name, job.data, job.id);
  process.exit(73);
}, { connection: { host: '127.0.0.1', port: Number(REPORT_REDIS_PORT), maxRetriesPerRequest: null }, prefix: 'day37-crash', lockDuration: 1200, stalledInterval: 500 });
worker.on('error', () => process.exit(75));
worker.on('failed', () => process.exit(76));
