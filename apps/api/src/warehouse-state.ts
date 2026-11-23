import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@warehouse-twin/database';

export type WarehouseScope = { spaceId: string; warehouseId: string };
// Call after access locks, before domain locks. Retain the old warehouse lock for
// layout publication and compatibility, then acquire the shared runtime boundary.
export async function lockWarehouseState(tx: Prisma.TransactionClient, scope: WarehouseScope) {
  const { spaceId, warehouseId } = scope;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Warehouse"
    WHERE id=${warehouseId}::uuid AND "spaceId"=${spaceId}::uuid FOR UPDATE`;
  if (!rows.length) throw new NotFoundException('仓库不可访问');
  await tx.warehouseRuntime.upsert({ where: { warehouseId }, create: { spaceId, warehouseId }, update: {} });
  await tx.$queryRaw`SELECT "warehouseId" FROM "WarehouseRuntime" WHERE "warehouseId"=${warehouseId}::uuid FOR UPDATE`;
  return tx.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId } });
}

// No database sequence: the counter and append roll back together while the row
// lock serializes commit order. All callers must already hold lockWarehouseState.
export async function appendWarehouseEvent(tx: Prisma.TransactionClient, scope: WarehouseScope, kind: string, payload: Prisma.InputJsonValue) {
  const runtime = await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId },
    data: { seq: { increment: 1 }, version: { increment: 1 } } });
  await tx.warehouseEvent.create({ data: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, seq: runtime.seq,
    tick: runtime.tick, version: runtime.version, epoch: runtime.epoch, kind, payload } });
  return runtime.seq;
}

export async function databaseNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row!.now;
}
