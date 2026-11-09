import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@warehouse-twin/database';
import { textInput, uuidInput } from '../auth/input';
import { DatabaseService } from '../database.service';

type Scope = { spaceId: string; warehouseId: string; actorId: string };
type Tx = Prisma.TransactionClient;
type Stock = { spaceId: string; warehouseId: string; skuId: string; batchId: string; quantity: number };
type Stage = 'take' | 'drop';

@Injectable()
export class TransportService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  // Internal entry points. The caller supplies an authenticated operator, never a request body.
  private command<T>(scope: Scope, reason: string, work: (tx: Tx, reason: string) => Promise<T>) {
    const { spaceId, warehouseId, actorId: userId } = scope;
    for (const id of [spaceId, warehouseId, userId]) uuidInput(id);
    const normalizedReason = textInput(reason, 1, 200);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "userId" FROM "WarehouseAccess" WHERE "spaceId"=${spaceId}::uuid
        AND "warehouseId"=${warehouseId}::uuid AND "userId"=${userId}::uuid FOR SHARE`;
      const access = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId, spaceId, warehouseId } } });
      if (!access) throw new NotFoundException('仓库不可访问');
      if (access.role === 'VIEWER') throw new ForbiddenException('只读账户不能过账');
      await tx.$queryRaw`SELECT id FROM "Warehouse" WHERE id=${warehouseId}::uuid FOR UPDATE`;
      return work(tx, normalizedReason);
    }, { timeout: 15000 });
  }

  create(scope: Scope, allocationId: string, stagingLocationId: string, reason: string) {
    uuidInput(allocationId);
    uuidInput(stagingLocationId);
    const { spaceId, warehouseId } = scope;
    return this.command(scope, reason, async (tx, note) => {
      const allocation = await tx.allocation.findFirst({
        where: { id: allocationId, spaceId, warehouseId }, include: { task: true, order: true },
      });
      if (!allocation) throw new NotFoundException('分配不可访问');
      if (allocation.task) {
        if (allocation.task.stagingLocationId !== stagingLocationId) throw new ConflictException('该分配已有其他暂存目标');
        return allocation.task;
      }
      if (allocation.order.status !== 'ALLOCATED') throw new ConflictException('订单未处于预占阶段');
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: warehouseId } });
      if (!warehouse.activeLayoutId) throw new NotFoundException('仓库未发布布局');
      const staging = await tx.layoutLocation.findFirst({
        where: { layoutId: warehouse.activeLayoutId, spaceId, warehouseId, locationId: stagingLocationId,
          location: { kind: 'OUTBOUND' } },
      });
      if (!staging) throw new NotFoundException('暂存位不在当前仓库布局');
      const [freeze] = await tx.$queryRaw<{ frozen: boolean }[]>`SELECT count_location_frozen(${stagingLocationId}::uuid) AS frozen`;
      if (freeze?.frozen) throw new ConflictException('暂存位正在盘点，不能创建运输任务');
      const [capacity] = await tx.$queryRaw<{ used: bigint }[]>`SELECT staging_reserved(${stagingLocationId}::uuid)
        + coalesce(sum("onHand"), 0) AS used FROM "InventoryBalance" WHERE "locationId"=${stagingLocationId}::uuid`;
      if (!capacity || capacity.used + BigInt(allocation.quantity) > BigInt(staging.capacity)) {
        throw new ConflictException('暂存位剩余容量不足');
      }
      const id = randomUUID();
      const transit = await tx.location.create({ data: { id: randomUUID(), spaceId, warehouseId, kind: 'TRANSIT', code: `TRANSIT-${id}` } });
      const task = await tx.transportTask.create({
        data: { id, spaceId, warehouseId, allocationId, transitLocationId: transit.id, stagingLocationId },
      });
      await this.audit(tx, scope, 'TRANSPORT_CREATED', id, note, {}, task);
      return task;
    });
  }

  take(scope: Scope, taskId: string, reason: string) {
    return this.move(scope, taskId, 'take', reason);
  }

  drop(scope: Scope, taskId: string, reason: string) {
    return this.move(scope, taskId, 'drop', reason);
  }

  private move(scope: Scope, taskId: string, stage: Stage, reason: string) {
    uuidInput(taskId);
    return this.command(scope, reason, async (tx, note) => {
      const task = await tx.transportTask.findFirst({
        where: { id: taskId, spaceId: scope.spaceId, warehouseId: scope.warehouseId }, include: { allocation: true },
      });
      if (!task) throw new NotFoundException('运输任务不可访问');
      const taking = stage === 'take';
      if (task.phase === 'STAGED' || (taking && task.phase === 'IN_TRANSIT')) return task;
      if (!taking && task.phase !== 'IN_TRANSIT') throw new ConflictException('尚未取货');
      const { allocation } = task;
      const source = taking ? allocation.locationId : task.transitLocationId;
      const destination = taking ? task.transitLocationId : task.stagingLocationId;
      await this.debit(tx, allocation, source);
      // The phase makes transit credit valid, or converts staging reserved capacity into occupancy.
      const updated = await tx.transportTask.update({
        where: { id: taskId }, data: { phase: taking ? 'IN_TRANSIT' : 'STAGED' }, include: { allocation: true },
      });
      const { spaceId, warehouseId, skuId, batchId, quantity } = allocation;
      const identity = { spaceId, warehouseId, skuId, batchId, locationId: destination, quality: 'RELEASED' } as const;
      await tx.inventoryBalance.upsert({
        where: { spaceId_warehouseId_locationId_skuId_batchId_quality: identity },
        create: { ...identity, onHand: quantity, reserved: quantity },
        update: { onHand: { increment: quantity }, reserved: { increment: quantity }, version: { increment: 1 } },
      });
      await this.post(tx, scope, allocation, source, destination, `transport:${taskId}:${stage}`, taskId, note);
      await this.audit(tx, scope, taking ? 'TRANSPORT_TAKEN' : 'TRANSPORT_DROPPED', taskId, note,
        { phase: task.phase }, { phase: updated.phase, source, destination, quantity });
      return updated;
    });
  }

  dispatch(scope: Scope, orderId: string, reason: string) {
    uuidInput(orderId);
    return this.command(scope, reason, async (tx, note) => {
      const order = await tx.outboundOrder.findFirst({
        where: { id: orderId, spaceId: scope.spaceId, warehouseId: scope.warehouseId },
        include: { allocations: { include: { task: true }, orderBy: { id: 'asc' } } },
      });
      if (!order) throw new NotFoundException('出库单不可访问');
      if (order.status === 'DISPATCHED') return { id: orderId, status: order.status };
      if (order.status !== 'ALLOCATED' || order.allocations.some((row) => row.task?.phase !== 'STAGED')
        || order.allocations.reduce((sum, row) => sum + row.quantity, 0) !== order.quantity) {
        throw new ConflictException('整单货物未到齐暂存区');
      }
      for (const allocation of order.allocations) {
        const task = allocation.task!;
        await this.debit(tx, allocation, task.stagingLocationId);
        await this.post(tx, scope, allocation, task.stagingLocationId, null, `transport:${task.id}:dispatch`, orderId, note);
      }
      const updated = await tx.outboundOrder.update({
        where: { id: orderId }, data: { status: 'DISPATCHED', version: { increment: 1 } },
        select: { id: true, status: true },
      });
      await this.audit(tx, scope, 'OUTBOUND_DISPATCHED', orderId, note, { status: order.status }, updated);
      return updated;
    });
  }

  private async debit(tx: Tx, { spaceId, warehouseId, skuId, batchId, quantity }: Stock, locationId: string) {
    const changed = await tx.inventoryBalance.updateMany({
      where: { spaceId, warehouseId, skuId, batchId, locationId, quality: 'RELEASED',
        onHand: { gte: quantity }, reserved: { gte: quantity } },
      data: { onHand: { decrement: quantity }, reserved: { decrement: quantity }, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw new ConflictException('该阶段的预占余额不足');
  }

  private post(tx: Tx, scope: Scope, stock: Stock, sourceLocationId: string, destinationLocationId: string | null,
    businessKey: string, reference: string, reason: string) {
    return tx.inventoryMovement.create({ data: {
      spaceId: scope.spaceId, warehouseId: scope.warehouseId, actorId: scope.actorId, actorType: 'USER',
      skuId: stock.skuId, batchId: stock.batchId, quantity: stock.quantity, kind: destinationLocationId ? 'TRANSFER' : 'DISPATCH',
      sourceLocationId, sourceQuality: 'RELEASED', destinationLocationId, destinationQuality: destinationLocationId ? 'RELEASED' : null,
      businessKey, reference, reason,
    } });
  }

  private audit(tx: Tx, { spaceId, warehouseId, actorId }: Scope, action: string, correlationId: string,
    reason: string, before: Prisma.InputJsonObject, after: Prisma.InputJsonObject) {
    return tx.auditLog.create({ data: { spaceId, warehouseId, actorId, action, correlationId, requestId: randomUUID(), reason, before, after } });
  }
}
