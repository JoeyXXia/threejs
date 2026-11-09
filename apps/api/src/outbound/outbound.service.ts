import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@warehouse-twin/database';
import type { OutboundListResponse, OutboundOrderResponse } from '@warehouse-twin/contracts';
import { DatabaseService } from '../database.service';
import { objectInput, textInput, uuidInput } from '../auth/input';

type Scope = { actorId: string; spaceId: string; warehouseId: string };
const include = { batch: { include: { sku: true } }, allocations: { include: { balance: { include: { location: true } } }, orderBy: { balanceId: 'asc' as const } } } as const;
type Order = Prisma.OutboundOrderGetPayload<{ include: typeof include }>;
const view = (order: Order): OutboundOrderResponse => ({
  id: order.id, spaceId: order.spaceId, warehouseId: order.warehouseId, skuId: order.skuId, skuCode: order.batch.sku.code,
  batchId: order.batchId, batchCode: order.batch.code, expiresAt: order.batch.expiresAt?.toISOString() ?? null,
  quantity: order.quantity, status: order.status, version: order.version, reason: order.reason, allocationReason: order.allocationReason,
  createdById: order.createdById, allocatedById: order.allocatedById, createdAt: order.createdAt.toISOString(), allocatedAt: order.allocatedAt?.toISOString() ?? null,
  allocations: order.allocations.map((row) => ({ id: row.id, balanceId: row.balanceId, locationId: row.locationId, locationCode: row.balance.location.code, quantity: row.quantity })),
});

@Injectable()
export class OutboundService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  scope(actorId: string, spaceId: string, warehouseId: string): Scope { uuidInput(spaceId); uuidInput(warehouseId); return { actorId, spaceId, warehouseId }; }
  private async access(tx: Prisma.TransactionClient, scope: Scope, write = false) {
    const { actorId: userId, spaceId, warehouseId } = scope;
    if (write) await tx.$queryRaw`SELECT "userId" FROM "WarehouseAccess" WHERE "userId"=${userId}::uuid AND "spaceId"=${spaceId}::uuid AND "warehouseId"=${warehouseId}::uuid FOR SHARE`;
    const access = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId, spaceId, warehouseId } } });
    if (!access) throw new NotFoundException('仓库不可访问');
    if (write && access.role === 'VIEWER') throw new ForbiddenException('只读账户不能创建或预占出库单');
    return access;
  }
  private async eligible(tx: Prisma.TransactionClient, scope: Scope, now: Date, batchId?: string) {
    const { spaceId, warehouseId } = scope;
    const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: warehouseId } });
    const placements = warehouse.activeLayoutId ? await tx.layoutLocation.findMany({
      where: { layoutId: warehouse.activeLayoutId, location: { kind: 'STORAGE',
        countOrders: { none: { status: { in: ['OPEN', 'SUBMITTED'] } } } } },
      select: { locationId: true },
    }) : [];
    return tx.inventoryBalance.findMany({ where: { spaceId, warehouseId, ...(batchId ? { batchId } : {}),
      locationId: { in: placements.map((row) => row.locationId) }, quality: 'RELEASED', onHand: { gt: 0 },
      batch: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
      include: { batch: true }, orderBy: [{ locationId: 'asc' }, { id: 'asc' }] });
  }
  async list(scope: Scope): Promise<OutboundListResponse> {
    return this.db.$transaction(async (tx) => {
      const access = await this.access(tx, scope); const now = new Date();
      const totals = new Map<string, OutboundListResponse['recommendations'][number]>();
      for (const row of await this.eligible(tx, scope, now)) {
        const available = row.onHand - row.reserved;
        if (!available) continue;
        const previous = totals.get(row.batchId);
        if (previous) previous.available += available;
        else totals.set(row.batchId, { skuId: row.skuId, batchId: row.batchId, batchCode: row.batch.code, expiresAt: row.batch.expiresAt?.toISOString() ?? null, available });
      }
      const recommendations = [...totals.values()].sort((a, b) => a.skuId.localeCompare(b.skuId)
        || (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) || a.batchId.localeCompare(b.batchId));
      const where = { spaceId: scope.spaceId, warehouseId: scope.warehouseId };
      const orders = await tx.outboundOrder.findMany({ where, include, take: 101, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      return { ...where, role: access.role, asOf: now.toISOString(), recommendations,
        skus: await tx.sku.findMany({ where, select: { id: true, code: true }, orderBy: { code: 'asc' } }),
        orders: orders.slice(0, 100).map(view), hasMore: orders.length > 100 };
    }, { isolationLevel: 'RepeatableRead' });
  }
  private async command(scope: Scope, operation: string, key: string, payload: object, work: (tx: Prisma.TransactionClient) => Promise<OutboundOrderResponse>) {
    const { spaceId, warehouseId, actorId } = scope;
    const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    try {
      return await this.db.$transaction(async (tx) => {
        await this.access(tx, scope, true);
        await tx.$queryRaw`SELECT id FROM "Warehouse" WHERE id=${warehouseId}::uuid AND "spaceId"=${spaceId}::uuid FOR UPDATE`;
        const identity = { spaceId, warehouseId, actorId, operation, key };
        const old = await tx.idempotencyRecord.findUnique({ where: { spaceId_warehouseId_actorId_operation_key: identity } });
        if (old) {
          if (old.requestHash !== requestHash || old.status !== 'COMPLETED' || !old.response) throw new ConflictException('请求键已用于不同参数');
          return old.response as unknown as OutboundOrderResponse;
        }
        const result = await work(tx);
        await tx.idempotencyRecord.create({ data: { ...identity, requestHash, status: 'COMPLETED', response: result as unknown as Prisma.InputJsonValue } });
        return result;
      }, { timeout: 15000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('该单据分配阶段已存在，请刷新确认');
      throw error;
    }
  }
  private async audit(tx: Prisma.TransactionClient, scope: Scope, action: string, reason: string, before: Prisma.InputJsonValue, after: OutboundOrderResponse) {
    await tx.auditLog.create({ data: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, actorId: scope.actorId,
      action, reason, requestId: randomUUID(), correlationId: after.id, before, after: after as unknown as Prisma.InputJsonValue } });
  }
  async create(scope: Scope, body: unknown) {
    const data = objectInput(body, ['key', 'skuId', 'batchId', 'quantity', 'reason']);
    uuidInput(data.skuId); uuidInput(data.batchId);
    if (!Number.isInteger(data.quantity) || (data.quantity as number) < 1 || (data.quantity as number) > 1000000) throw new BadRequestException('数量须为 1-1000000 的整数件');
    const key = textInput(data.key, 8, 100);
    const payload = { skuId: data.skuId as string, batchId: data.batchId as string, quantity: data.quantity as number, reason: textInput(data.reason, 1, 200) };
    return this.command(scope, 'OUTBOUND_CREATE', key, payload, async (tx) => {
      if (!await tx.batch.findFirst({ where: { id: payload.batchId, skuId: payload.skuId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } })) throw new NotFoundException('SKU 或批次不可访问');
      const result = view(await tx.outboundOrder.create({ data: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, ...payload, createdById: scope.actorId }, include }));
      await this.audit(tx, scope, 'OUTBOUND_CREATED', payload.reason, {}, result); return result;
    });
  }
  async allocate(scope: Scope, orderId: string, body: unknown) {
    uuidInput(orderId); const data = objectInput(body, ['key', 'reason']);
    const key = textInput(data.key, 8, 100), reason = textInput(data.reason, 1, 200);
    return this.command(scope, 'OUTBOUND_ALLOCATE', key, { orderId, reason }, async (tx) => {
      const { spaceId, warehouseId, actorId } = scope;
      await tx.$queryRaw`SELECT id FROM "OutboundOrder" WHERE id=${orderId}::uuid AND "spaceId"=${spaceId}::uuid AND "warehouseId"=${warehouseId}::uuid FOR UPDATE`;
      const order = await tx.outboundOrder.findFirst({ where: { id: orderId, spaceId, warehouseId }, include });
      if (!order) throw new NotFoundException('出库单不可访问');
      if (order.status !== 'CREATED') throw new ConflictException('出库单已预占，不能重复分配');
      // A batch date cannot change while it is being checked and allocated.
      await tx.$queryRaw`SELECT id FROM "Batch" WHERE id=${order.batchId}::uuid FOR SHARE`;
      const batch = await tx.batch.findUniqueOrThrow({ where: { id: order.batchId } });
      if (batch.expiresAt && batch.expiresAt <= new Date()) throw new ConflictException('过期批次不可预占');
      const rows = await this.eligible(tx, scope, new Date(), order.batchId);
      if (rows.reduce((sum, row) => sum + row.onHand - row.reserved, 0) < order.quantity) throw new ConflictException('所选批次储存区可分配量不足，请减少数量或拆单选择其他批次；不会自动跨批');
      for (const locationId of [...new Set(rows.map((row) => row.locationId))].sort()) await tx.$queryRaw`SELECT id FROM "Location" WHERE id=${locationId}::uuid FOR UPDATE`;
      for (const row of rows) await tx.$queryRaw`SELECT id FROM "InventoryBalance" WHERE id=${row.id}::uuid FOR UPDATE`;
      let remaining = order.quantity;
      for (const row of rows) {
        const quantity = Math.min(remaining, row.onHand - row.reserved);
        if (!quantity) continue;
        const updated = await tx.$executeRaw`UPDATE "InventoryBalance" SET reserved=reserved+${quantity}, version=version+1, "updatedAt"=CURRENT_TIMESTAMP
          WHERE id=${row.id}::uuid AND version=${row.version} AND quality='RELEASED' AND reserved+${quantity} <= "onHand"`;
        if (updated !== 1) throw new ConflictException('库存已变化，未完成预占，请刷新重试');
        await tx.allocation.create({ data: { spaceId, warehouseId, orderId, balanceId: row.id, locationId: row.locationId,
          skuId: order.skuId, batchId: order.batchId, quantity } });
        remaining -= quantity;
        if (!remaining) break;
      }
      if (remaining || (batch.expiresAt && batch.expiresAt <= new Date())) throw new ConflictException('库存或批次日期已变化，整单预占已回滚');
      const result = view(await tx.outboundOrder.update({ where: { id: orderId }, include, data: {
        status: 'ALLOCATED', allocatedAt: new Date(), allocatedById: actorId, allocationReason: reason, version: { increment: 1 },
      } }));
      await this.audit(tx, scope, 'OUTBOUND_ALLOCATED', reason, view(order) as unknown as Prisma.InputJsonValue, result); return result;
    });
  }
}
