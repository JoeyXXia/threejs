import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@warehouse-twin/database';
import { appendWarehouseEvent } from '../warehouse-state';

type Scope = { spaceId: string; warehouseId: string; actorId: string };
type Tx = Prisma.TransactionClient;

@Injectable()
export class PutawayService {
  // Internal composition only: caller owns ACL SHARE + warehouse/runtime locks.
  async createInTransaction(tx: Tx, scope: Scope, inboundOrderId: string, targetLocationId: string, reason: string) {
    const { spaceId, warehouseId } = scope;
    const receipt = await tx.inboundOrder.findFirst({ where: { id: inboundOrderId, spaceId, warehouseId }, include: { batch: true, putawayTask: true } });
    if (!receipt) throw new NotFoundException('入库单不可访问');
    if (receipt.putawayTask) {
      if (receipt.putawayTask.targetLocationId !== targetLocationId) throw new ConflictException('入库单已有其他上架目标');
      return receipt.putawayTask;
    }
    if (receipt.status !== 'PASSED' || (receipt.batch.expiresAt && receipt.batch.expiresAt <= new Date())) throw new ConflictException('仅允许已放行且未过期的整单上架');
    const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: warehouseId } });
    if (!warehouse.activeLayoutId) throw new ConflictException('仓库没有已发布布局');
    const placements = await tx.layoutLocation.findMany({ where: { layoutId: warehouse.activeLayoutId, spaceId, warehouseId }, include: { location: true } });
    const target = placements.find((p) => p.locationId === targetLocationId && p.location.kind === 'STORAGE');
    if (!target || !placements.some((p) => p.locationId === receipt.qcLocationId && p.location.kind === 'QC')) throw new ConflictException('上架端点不在当前布局');
    const [state] = await tx.$queryRaw<{ used: bigint; frozen: boolean; mixed: boolean }[]>`SELECT
      staging_reserved(${targetLocationId}::uuid) + (SELECT coalesce(sum("onHand"),0) FROM "InventoryBalance" WHERE "locationId"=${targetLocationId}::uuid) AS used,
      count_location_frozen(${targetLocationId}::uuid) AS frozen,
      EXISTS(SELECT 1 FROM "InventoryBalance" WHERE "locationId"=${targetLocationId}::uuid AND "onHand">0 AND ("skuId"<>${receipt.skuId}::uuid OR "batchId"<>${receipt.batchId}::uuid))
      OR EXISTS(SELECT 1 FROM "PutawayTask" t JOIN "InboundOrder" r ON r.id=t."inboundOrderId" WHERE t."targetLocationId"=${targetLocationId}::uuid AND t.phase IN ('READY','IN_TRANSIT') AND (r."skuId"<>${receipt.skuId}::uuid OR r."batchId"<>${receipt.batchId}::uuid)) AS mixed`;
    if (!state || state.frozen || state.mixed || state.used + BigInt(receipt.quantity) > BigInt(target.capacity)) throw new ConflictException('目标冻结、批次不兼容或容量不足');
    const source = await tx.inventoryBalance.findFirst({ where: { spaceId, warehouseId, locationId: receipt.qcLocationId, skuId: receipt.skuId, batchId: receipt.batchId, quality: 'RELEASED' } });
    if (!source || source.onHand - source.reserved < receipt.quantity) throw new ConflictException('QC 可用余额不足');
    await tx.inventoryBalance.update({ where: { id: source.id }, data: { reserved: { increment: receipt.quantity }, version: { increment: 1 } } });
    const id = randomUUID();
    const transit = await tx.location.create({ data: { id: randomUUID(), spaceId, warehouseId, kind: 'TRANSIT', code: `PUTAWAY-${id}` } });
    const task = await tx.putawayTask.create({ data: { id, spaceId, warehouseId, inboundOrderId, targetLocationId, transitLocationId: transit.id } });
    await this.audit(tx, scope, 'PUTAWAY_CREATED', task.id, reason);
    return task;
  }

  async moveInTransaction(tx: Tx, scope: Scope, taskId: string, stage: 'take' | 'drop', reason: string) {
    const task = await tx.putawayTask.findFirst({ where: { id: taskId, spaceId: scope.spaceId, warehouseId: scope.warehouseId }, include: { receipt: true } });
    if (!task) throw new NotFoundException('上架任务不可访问');
    const taking = stage === 'take';
    if (task.phase === 'STAGED' || (taking && task.phase === 'IN_TRANSIT')) return task;
    if (!taking && task.phase !== 'IN_TRANSIT') throw new ConflictException('尚未取货');
    const r = task.receipt;
    const sourceLocationId = taking ? r.qcLocationId : task.transitLocationId;
    const destinationLocationId = taking ? task.transitLocationId : task.targetLocationId;
    const changed = await tx.inventoryBalance.updateMany({ where: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, skuId: r.skuId, batchId: r.batchId, locationId: sourceLocationId, quality: 'RELEASED', onHand: { gte: r.quantity }, reserved: { gte: r.quantity } },
      data: { onHand: { decrement: r.quantity }, reserved: { decrement: r.quantity }, version: { increment: 1 } } });
    if (changed.count !== 1) throw new ConflictException('阶段预占余额不足');
    const updated = await tx.putawayTask.update({ where: { id: taskId }, data: { phase: taking ? 'IN_TRANSIT' : 'STAGED' } });
    const identity = { spaceId: scope.spaceId, warehouseId: scope.warehouseId, skuId: r.skuId, batchId: r.batchId, locationId: destinationLocationId, quality: 'RELEASED' as const };
    await tx.inventoryBalance.upsert({ where: { spaceId_warehouseId_locationId_skuId_batchId_quality: identity }, create: { ...identity, onHand: r.quantity, reserved: taking ? r.quantity : 0 }, update: { onHand: { increment: r.quantity }, reserved: { increment: taking ? r.quantity : 0 }, version: { increment: 1 } } });
    await tx.inventoryMovement.create({ data: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, skuId: r.skuId, batchId: r.batchId, quantity: r.quantity, kind: 'TRANSFER', sourceLocationId, destinationLocationId, sourceQuality: 'RELEASED', destinationQuality: 'RELEASED', businessKey: `putaway:${taskId}:${stage}`, reference: taskId, actorType: 'USER', actorId: scope.actorId, reason } });
    await this.audit(tx, scope, taking ? 'PUTAWAY_TAKEN' : 'PUTAWAY_DROPPED', taskId, reason);
    return updated;
  }

  private async audit(tx: Tx, scope: Scope, action: string, correlationId: string, reason: string) {
    await tx.auditLog.create({ data: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, actorId: scope.actorId, action, correlationId, reason, requestId: randomUUID(), before: {}, after: { taskId: correlationId } } });
    await appendWarehouseEvent(tx, scope, action, { actorId: scope.actorId, taskId: correlationId });
  }
}
