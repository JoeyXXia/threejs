import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@warehouse-twin/database';
import type { CreateInboundInput, InboundListResponse, InboundOrderResponse } from '@warehouse-twin/contracts';
import { DatabaseService } from '../database.service';
import { objectInput, textInput, uuidInput } from '../auth/input';

type Scope = { spaceId: string; warehouseId: string; actorId: string };
const include = { batch: { include: { sku: true } }, qcLocation: true } as const;
type Order = Prisma.InboundOrderGetPayload<{ include: typeof include }>;
const view = (order: Order): InboundOrderResponse => ({
  id: order.id, spaceId: order.spaceId, warehouseId: order.warehouseId, skuId: order.skuId, skuCode: order.batch.sku.code,
  batchId: order.batchId, batchCode: order.batch.code, qcLocationId: order.qcLocationId, qcCode: order.qcLocation.code,
  quantity: order.quantity, status: order.status, version: order.version,
  producedAt: order.batch.producedAt?.toISOString() ?? null, expiresAt: order.batch.expiresAt?.toISOString() ?? null,
  createdById: order.createdById, receivedById: order.receivedById, inspectedById: order.inspectedById,
  reason: order.reason, receiptReason: order.receiptReason, inspectionReason: order.inspectionReason,
  createdAt: order.createdAt.toISOString(), receivedAt: order.receivedAt?.toISOString() ?? null, inspectedAt: order.inspectedAt?.toISOString() ?? null,
});
function dateInput(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) throw new BadRequestException('日期须为 UTC ISO 时间');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) throw new BadRequestException('日期无效');
  return date.toISOString();
}

@Injectable()
export class InboundService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  scope(actorId: string, spaceId: string, warehouseId: string): Scope {
    uuidInput(spaceId); uuidInput(warehouseId); return { actorId, spaceId, warehouseId };
  }
  private async access(tx: Prisma.TransactionClient, scope: Scope, write = false) {
    const { actorId: userId, spaceId, warehouseId } = scope;
    if (write) await tx.$queryRaw`SELECT "userId" FROM "WarehouseAccess" WHERE "userId"=${userId}::uuid AND "spaceId"=${spaceId}::uuid AND "warehouseId"=${warehouseId}::uuid FOR SHARE`;
    const access = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId, spaceId, warehouseId } } });
    if (!access) throw new NotFoundException('仓库不可访问');
    if (write && access.role === 'VIEWER') throw new ForbiddenException('只读账户不能收货或质检');
    return access;
  }
  async list(scope: Scope): Promise<InboundListResponse> {
    return this.db.$transaction(async (tx) => {
      const access = await this.access(tx, scope);
      const { spaceId, warehouseId } = scope;
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: warehouseId } });
      const orders = await tx.inboundOrder.findMany({ where: { spaceId, warehouseId }, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 101 });
      const placements = warehouse.activeLayoutId ? await tx.layoutLocation.findMany({ where: { layoutId: warehouse.activeLayoutId, location: { kind: 'QC' } }, include: { location: true } }) : [];
      return { spaceId, warehouseId, role: access.role,
        skus: await tx.sku.findMany({ where: { spaceId, warehouseId }, select: { id: true, code: true }, orderBy: { code: 'asc' } }),
        qcLocations: placements.map(({ location }) => ({ id: location.id, code: location.code })),
        orders: orders.slice(0, 100).map(view), hasMore: orders.length > 100 };
    }, { isolationLevel: 'RepeatableRead' });
  }
  private async command(scope: Scope, operation: string, key: string, payload: object,
    work: (tx: Prisma.TransactionClient) => Promise<InboundOrderResponse>) {
    const { actorId, spaceId, warehouseId } = scope;
    const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    try {
      return await this.db.$transaction(async (tx) => {
        await this.access(tx, scope, true); // Check authorization before returning any stored result.
        await tx.$queryRaw`SELECT id FROM "Warehouse" WHERE id=${warehouseId}::uuid AND "spaceId"=${spaceId}::uuid FOR UPDATE`;
        const identity = { spaceId, warehouseId, actorId, operation, key };
        const old = await tx.idempotencyRecord.findUnique({ where: { spaceId_warehouseId_actorId_operation_key: identity } });
        if (old) {
          if (old.requestHash !== requestHash || old.status !== 'COMPLETED' || !old.response) throw new ConflictException('请求键已用于不同参数');
          return old.response as unknown as InboundOrderResponse;
        }
        const result = await work(tx);
        await tx.idempotencyRecord.create({ data: { ...identity, requestHash, status: 'COMPLETED', response: result as unknown as Prisma.InputJsonValue } });
        return result;
      }, { timeout: 15000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('业务阶段或批次已存在，请刷新确认');
      throw error;
    }
  }
  private async qc(tx: Prisma.TransactionClient, scope: Scope, qcLocationId: string) {
    const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
    const placement = warehouse.activeLayoutId ? await tx.layoutLocation.findFirst({
      where: { layoutId: warehouse.activeLayoutId, locationId: qcLocationId, spaceId: scope.spaceId, warehouseId: scope.warehouseId, location: { kind: 'QC' } },
    }) : null;
    if (!placement) throw new ConflictException('目标必须是当前布局中的 QC 货位');
    await tx.$queryRaw`SELECT id FROM "Location" WHERE id=${qcLocationId}::uuid FOR UPDATE`;
    return placement;
  }
  private async audit(tx: Prisma.TransactionClient, scope: Scope, action: string, reason: string, before: Prisma.InputJsonValue, after: InboundOrderResponse) {
    await tx.auditLog.create({ data: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, actorId: scope.actorId,
      action, reason, requestId: randomUUID(), correlationId: after.id, before, after: after as unknown as Prisma.InputJsonValue } });
  }
  async create(scope: Scope, body: unknown) {
    const data = objectInput(body, ['key', 'skuId', 'batchCode', 'qcLocationId', 'quantity', 'producedAt', 'expiresAt', 'reason']);
    uuidInput(data.skuId); uuidInput(data.qcLocationId);
    if (!Number.isInteger(data.quantity) || (data.quantity as number) < 1 || (data.quantity as number) > 1000000) throw new BadRequestException('数量须为 1-1000000 的整数件');
    const input: CreateInboundInput = { key: textInput(data.key, 8, 100), skuId: data.skuId as string,
      batchCode: textInput(data.batchCode, 1, 80), qcLocationId: data.qcLocationId as string, quantity: data.quantity as number,
      producedAt: dateInput(data.producedAt), expiresAt: dateInput(data.expiresAt), reason: textInput(data.reason, 1, 200) };
    if (input.producedAt && (Date.parse(input.producedAt) > Date.now() || (input.expiresAt && input.producedAt >= input.expiresAt))) throw new BadRequestException('生产日期不能在未来，且须早于到期时间');
    return this.command(scope, 'INBOUND_CREATE', input.key, input, async (tx) => {
      const { spaceId, warehouseId, actorId } = scope;
      if (!await tx.sku.findFirst({ where: { id: input.skuId, spaceId, warehouseId } })) throw new NotFoundException('SKU 不可访问');
      await this.qc(tx, scope, input.qcLocationId);
      let batch = await tx.batch.findUnique({ where: { spaceId_warehouseId_skuId_code: { spaceId, warehouseId, skuId: input.skuId, code: input.batchCode } } });
      if (batch && (batch.producedAt?.toISOString() !== (input.producedAt ?? undefined) || batch.expiresAt?.toISOString() !== (input.expiresAt ?? undefined))) throw new ConflictException('已有批次的生产/到期日期不同，不允许覆盖');
      if (!batch) batch = await tx.batch.create({ data: { id: randomUUID(), spaceId, warehouseId, skuId: input.skuId, code: input.batchCode,
        producedAt: input.producedAt ? new Date(input.producedAt) : null, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } });
      const result = view(await tx.inboundOrder.create({ data: { spaceId, warehouseId, skuId: input.skuId, batchId: batch.id,
        qcLocationId: input.qcLocationId, quantity: input.quantity, createdById: actorId, reason: input.reason }, include }));
      await this.audit(tx, scope, 'INBOUND_CREATED', input.reason, {}, result); return result;
    });
  }
  async phase(scope: Scope, orderId: string, phase: 'receive' | 'inspect', body: unknown) {
    uuidInput(orderId);
    const data = objectInput(body, phase === 'receive' ? ['key', 'reason'] : ['key', 'reason', 'decision']);
    const key = textInput(data.key, 8, 100), reason = textInput(data.reason, 1, 200);
    const decision = phase === 'receive' ? null : data.decision;
    if (phase === 'inspect' && decision !== 'PASS' && decision !== 'REJECT') throw new BadRequestException('质检结果须为 PASS 或 REJECT');
    const payload = { orderId, reason, decision };
    return this.command(scope, phase === 'receive' ? 'INBOUND_RECEIVE' : 'INBOUND_INSPECT', key, payload, async (tx) => {
      const { spaceId, warehouseId, actorId } = scope;
      await tx.$queryRaw`SELECT id FROM "InboundOrder" WHERE id=${orderId}::uuid AND "spaceId"=${spaceId}::uuid AND "warehouseId"=${warehouseId}::uuid FOR UPDATE`;
      const order = await tx.inboundOrder.findFirst({ where: { id: orderId, spaceId, warehouseId }, include });
      if (!order) throw new NotFoundException('入库单不可访问');
      if (order.status !== (phase === 'receive' ? 'CREATED' : 'RECEIVED')) throw new ConflictException('入库单阶段已改变，不可重复收货或质检');
      const placement = await this.qc(tx, scope, order.qcLocationId);
      const stock = { spaceId, warehouseId, locationId: order.qcLocationId, skuId: order.skuId, batchId: order.batchId };
      const holdKey = { ...stock, quality: 'HOLD' as const };
      const now = new Date();
      if (phase === 'receive') {
        const occupied = await tx.inventoryBalance.aggregate({ where: { spaceId, warehouseId, locationId: order.qcLocationId }, _sum: { onHand: true } });
        if ((occupied._sum.onHand ?? 0) + order.quantity > placement.capacity) throw new ConflictException('QC 货位容量不足');
        await tx.inventoryBalance.upsert({ where: { spaceId_warehouseId_locationId_skuId_batchId_quality: holdKey },
          create: { ...holdKey, onHand: order.quantity }, update: { onHand: { increment: order.quantity }, version: { increment: 1 } } });
        await tx.inventoryMovement.create({ data: { spaceId, warehouseId, skuId: order.skuId, batchId: order.batchId,
          kind: 'RECEIPT', destinationLocationId: order.qcLocationId, destinationQuality: 'HOLD', quantity: order.quantity,
          businessKey: `inbound:${order.id}:receipt`, actorType: 'USER', actorId, reason, reference: order.id } });
      } else if (decision === 'PASS') {
        if (order.batch.expiresAt && order.batch.expiresAt <= now) throw new ConflictException('过期批次不能放行，库存保持 HOLD');
        const hold = await tx.inventoryBalance.findUnique({ where: { spaceId_warehouseId_locationId_skuId_batchId_quality: holdKey } });
        if (!hold || hold.onHand - hold.reserved < order.quantity) throw new ConflictException('该单 HOLD 库存不足，不能放行');
        // Reduce HOLD first so the capacity trigger never sees a transient overfill.
        await tx.inventoryBalance.update({ where: { id: hold.id }, data: { onHand: { decrement: order.quantity }, version: { increment: 1 } } });
        const releasedKey = { ...stock, quality: 'RELEASED' as const };
        await tx.inventoryBalance.upsert({ where: { spaceId_warehouseId_locationId_skuId_batchId_quality: releasedKey },
          create: { ...releasedKey, onHand: order.quantity }, update: { onHand: { increment: order.quantity }, version: { increment: 1 } } });
        await tx.inventoryMovement.create({ data: { spaceId, warehouseId, skuId: order.skuId, batchId: order.batchId,
          kind: 'TRANSFER', sourceLocationId: order.qcLocationId, sourceQuality: 'HOLD', destinationLocationId: order.qcLocationId,
          destinationQuality: 'RELEASED', quantity: order.quantity, businessKey: `inbound:${order.id}:release`, actorType: 'USER', actorId, reason, reference: order.id } });
      }
      const result = view(await tx.inboundOrder.update({ where: { id: order.id }, include, data: phase === 'receive'
        ? { status: 'RECEIVED', receivedAt: now, receivedById: actorId, receiptReason: reason, version: { increment: 1 } }
        : { status: decision === 'PASS' ? 'PASSED' : 'REJECTED', inspectedAt: now, inspectedById: actorId, inspectionReason: reason, version: { increment: 1 } } }));
      await this.audit(tx, scope, phase === 'receive' ? 'INBOUND_RECEIVED' : `INBOUND_${result.status}`, reason, view(order) as unknown as Prisma.InputJsonValue, result);
      return result;
    });
  }
}
