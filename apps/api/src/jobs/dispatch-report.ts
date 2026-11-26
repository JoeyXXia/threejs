import type { PrismaClient } from '@warehouse-twin/database';
import { dispatchEventKind, dispatchReportFormat } from '../warehouse-state';

export const dispatchReportQueue = 'warehouse-dispatch-reports-v1';
export type DispatchReportMessage = { intentId: string };
const redisId = (id: string) => `report-${id}`;

export async function relayDispatchReports(db: PrismaClient, publish: (name: string, data: DispatchReportMessage, jobId: string) => Promise<unknown>) {
  const due = await db.dispatchReportJob.findMany({ where: { completedAt: null, nextRelayAt: { lte: new Date() } },
    orderBy: [{ nextRelayAt: 'asc' }, { id: 'asc' }], take: 16, select: { id: true } });
  for (const { id } of due) {
    await publish(dispatchReportQueue, { intentId: id }, redisId(id));
    // This is only a relay throttle, not a delivery acknowledgement. Lost Redis jobs can be added again.
    await db.dispatchReportJob.updateMany({ where: { id, completedAt: null }, data: { nextRelayAt: new Date(Date.now() + 10_000) } });
  }
}

export async function generateDispatchReport(db: PrismaClient, name: string, message: DispatchReportMessage, jobId: string | undefined) {
  if (name !== dispatchReportQueue || !message || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(message.intentId)
    || jobId !== redisId(message.intentId)) throw new Error('Invalid dispatch report message');
  await db.$transaction(async (tx) => {
    const intent = await tx.dispatchReportJob.findUniqueOrThrow({ where: { id: message.intentId }, include: { source: true } });
    if (intent.format !== dispatchReportFormat || intent.source.kind !== dispatchEventKind) throw new Error('Unsupported dispatch report source');
    if (intent.completedAt) return;
    const { spaceId, warehouseId, createdAt } = intent.source;
    const utcDay = createdAt.toISOString().slice(0, 10);
    const start = new Date(`${utcDay}T00:00:00.000Z`), end = new Date(start.getTime() + 86_400_000);
    const dispatchedOrders = await tx.warehouseEvent.count({ where: { spaceId, warehouseId, kind: dispatchEventKind,
      createdAt: { gte: start, lt: end }, seq: { lte: intent.sourceSeq } } });
    await tx.dispatchReportJob.updateMany({ where: { id: intent.id, completedAt: null }, data: {
      completedAt: new Date(), result: { format: intent.format, spaceId, warehouseId, utcDay, throughSeq: intent.sourceSeq, dispatchedOrders },
    } });
  });
}
