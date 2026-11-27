import type { Prisma, PrismaClient } from '@warehouse-twin/database';
import { dispatchEventKind, dispatchReportFormat } from '../warehouse-state';

export const dispatchReportQueue = 'warehouse-dispatch-reports-v1';
export const reportAttempts = 3;
export const reportBackoffMs = 500;
export type DispatchReportMessage = { intentId: string; generation?: number };
export const reportJobId = (id: string, generation: number) => `report-${id}${generation === 0 ? '' : `-g${generation}`}`;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function active(db: Prisma.TransactionClient) {
  return { completedAt: null, OR: [{ lastFailedGeneration: null }, { lastFailedGeneration: { lt: db.dispatchReportJob.fields.generation } }] };
}

function delivery(name: string, message: DispatchReportMessage, jobId: string | undefined) {
  const generation = message?.generation === undefined ? 0 : message.generation; // Accept Day36's generation-zero messages.
  if (name !== dispatchReportQueue || !message || typeof message.intentId !== 'string' || !uuid.test(message.intentId)
    || !Number.isInteger(generation) || generation < 0 || generation > 2147483647
    || jobId !== reportJobId(message.intentId, generation)) throw new Error('Invalid dispatch report message');
  return { id: message.intentId, generation };
}

export async function recordDispatchFailure(db: PrismaClient, message: DispatchReportMessage, jobId: string | undefined, attempts: number) {
  const key = delivery(dispatchReportQueue, message, jobId);
  await db.dispatchReportJob.updateMany({ where: { ...key, ...active(db) }, data: {
    lastFailedGeneration: key.generation, lastFailureAt: new Date(), lastFailureAttempts: attempts,
  } });
}

export async function relayDispatchReports(db: PrismaClient, publish: (name: string, data: DispatchReportMessage, jobId: string) => Promise<number | undefined>) {
  const due = await db.dispatchReportJob.findMany({ where: { ...active(db), nextRelayAt: { lte: new Date() } },
    orderBy: [{ nextRelayAt: 'asc' }, { id: 'asc' }], take: 16, select: { id: true, generation: true } });
  for (const { id, generation } of due) {
    const data = { intentId: id, generation }, jobId = reportJobId(id, generation);
    const failedAttempts = await publish(dispatchReportQueue, data, jobId);
    if (failedAttempts !== undefined) { await recordDispatchFailure(db, data, jobId, failedAttempts); continue; }
    // This is only a relay throttle, not a delivery acknowledgement. Lost Redis jobs can be added again.
    await db.dispatchReportJob.updateMany({ where: { id, generation, ...active(db) }, data: { nextRelayAt: new Date(Date.now() + 10_000) } });
  }
}

export async function generateDispatchReport(db: PrismaClient, name: string, message: DispatchReportMessage, jobId: string | undefined) {
  const key = delivery(name, message, jobId);
  await db.$transaction(async (tx) => {
    const intent = await tx.dispatchReportJob.findFirst({ where: { ...key, ...active(tx) }, include: { source: true } });
    if (!intent) return;
    if (intent.format !== dispatchReportFormat || intent.source.kind !== dispatchEventKind) throw new Error('Unsupported dispatch report source');
    const { spaceId, warehouseId, createdAt } = intent.source;
    const utcDay = createdAt.toISOString().slice(0, 10);
    const start = new Date(`${utcDay}T00:00:00.000Z`), end = new Date(start.getTime() + 86_400_000);
    const dispatchedOrders = await tx.warehouseEvent.count({ where: { spaceId, warehouseId, kind: dispatchEventKind,
      createdAt: { gte: start, lt: end }, seq: { lte: intent.sourceSeq } } });
    await tx.dispatchReportJob.updateMany({ where: { ...key, ...active(tx) }, data: {
      completedAt: new Date(), result: { format: intent.format, spaceId, warehouseId, utcDay, throughSeq: intent.sourceSeq, dispatchedOrders },
    } });
  });
}

export async function retryDispatchReport(db: PrismaClient, id: string, generation: number) {
  if (!uuid.test(id) || !Number.isInteger(generation) || generation < 0 || generation >= 2147483647) throw new Error('Invalid retry target');
  const result = await db.dispatchReportJob.updateMany({ where: { id, generation, lastFailedGeneration: generation, completedAt: null },
    data: { generation: { increment: 1 }, nextRelayAt: new Date() } });
  return result.count === 1;
}
