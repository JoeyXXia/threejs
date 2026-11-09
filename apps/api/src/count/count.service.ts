import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { CountListResponse, CountOrderResponse } from '@warehouse-twin/contracts';
import { Prisma } from '@warehouse-twin/database';
import { objectInput, textInput, uuidInput } from '../auth/input';
import { DatabaseService } from '../database.service';

type Scope = { spaceId: string; warehouseId: string; actorId: string };
type Tx = Prisma.TransactionClient;
type Action = 'submit' | 'approve' | 'reject';
const include = { location: true, lines: { orderBy: { balanceId: 'asc' } } } as const;
const active = ['OPEN', 'SUBMITTED'] as const;
const countable = ['STORAGE', 'OUTBOUND'] as const;
type Order = Prisma.CountOrderGetPayload<{ include: typeof include }>;

function view(order: Order): CountOrderResponse {
  return {
    id: order.id, spaceId: order.spaceId, warehouseId: order.warehouseId, locationId: order.locationId,
    locationCode: order.location.code, createdAt: order.createdAt.toISOString(), status: order.status,
    submissionNote: order.submissionNote,
    lines: order.lines.map(({ balanceId, skuCode, batchCode, quality, expected, balanceVersion, actual }) => ({
      balanceId, skuCode, batchCode, quality, expected, balanceVersion, actual,
    })),
  };
}

function actualsInput(value: unknown) {
  if (!Array.isArray(value)) throw new BadRequestException('请提交完整盘点明细');
  const rows = value.map((entry) => {
    const row = objectInput(entry, ['balanceId', 'actual']);
    if (typeof row.actual !== 'number' || !Number.isInteger(row.actual) || row.actual < 0 || row.actual > 2147483647) {
      throw new BadRequestException('实数须为非负整数且在数据库范围内');
    }
    return { balanceId: uuidInput(row.balanceId).toLowerCase(), actual: row.actual };
  }).sort((a, b) => a.balanceId.localeCompare(b.balanceId));
  if (new Set(rows.map((row) => row.balanceId)).size !== rows.length) throw new BadRequestException('盘点明细不能重复');
  return rows;
}

@Injectable()
export class CountService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  scope(actorId: string, spaceId: string, warehouseId: string): Scope {
    return { actorId, spaceId: uuidInput(spaceId), warehouseId: uuidInput(warehouseId) };
  }

  private async access(tx: Tx, { actorId: userId, spaceId, warehouseId }: Scope, operation?: string) {
    if (operation) {
      await tx.$queryRaw`SELECT "userId" FROM "WarehouseAccess" WHERE "spaceId"=${spaceId}::uuid
        AND "warehouseId"=${warehouseId}::uuid AND "userId"=${userId}::uuid FOR SHARE`;
    }
    const access = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId, spaceId, warehouseId } } });
    if (!access) throw new NotFoundException('仓库不可访问');
    if (operation && access.role === 'VIEWER') throw new ForbiddenException('只读账户不能执行盘点');
    if ((operation === 'COUNT_APPROVE' || operation === 'COUNT_REJECT') && access.role !== 'ADMIN') {
      throw new ForbiddenException('只有仓库管理员可以处理审批');
    }
    return access;
  }

  async list(scope: Scope): Promise<CountListResponse> {
    return this.db.$transaction(async (tx) => {
      const { role } = await this.access(tx, scope);
      const where = { spaceId: scope.spaceId, warehouseId: scope.warehouseId };
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
      const placements = warehouse.activeLayoutId ? await tx.layoutLocation.findMany({
        where: { ...where, layoutId: warehouse.activeLayoutId, location: { kind: { in: [...countable] } } },
        include: { location: { include: { countOrders: { where: { status: { in: [...active] } }, select: { id: true } } } } },
        orderBy: { location: { code: 'asc' } },
      }) : [];
      const [open, recent] = await Promise.all([
        tx.countOrder.findMany({ where: { ...where, status: { in: [...active] } }, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
        tx.countOrder.findMany({ where: { ...where, status: { notIn: [...active] } }, include,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 }),
      ]);
      return { ...where, role, locations: placements.map(({ location }) => ({
        id: location.id, code: location.code, frozen: location.countOrders.length > 0,
      })), orders: [...open, ...recent].map(view) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  private async command(scope: Scope, operation: string, key: string, payload: object,
    work: (tx: Tx) => Promise<CountOrderResponse>) {
    const { spaceId, warehouseId, actorId } = scope;
    const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    try {
      return await this.db.$transaction(async (tx) => {
        await this.access(tx, scope, operation);
        await tx.$queryRaw`SELECT id FROM "Warehouse" WHERE id=${warehouseId}::uuid AND "spaceId"=${spaceId}::uuid FOR UPDATE`;
        const identity = { spaceId, warehouseId, actorId, operation, key };
        const previous = await tx.idempotencyRecord.findUnique({ where: { spaceId_warehouseId_actorId_operation_key: identity } });
        if (previous) {
          if (previous.requestHash !== requestHash || previous.status !== 'COMPLETED' || !previous.response) {
            throw new ConflictException('请求键已用于不同参数');
          }
          return previous.response as unknown as CountOrderResponse;
        }
        const result = await work(tx);
        await tx.idempotencyRecord.create({ data: { ...identity, requestHash, status: 'COMPLETED', response: result as Prisma.InputJsonObject } });
        return result;
      }, { timeout: 15000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('盘点单或调整流水已存在，请刷新确认');
      }
      throw error;
    }
  }

  private async placement(tx: Tx, { spaceId, warehouseId }: Scope, locationId: string) {
    const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: warehouseId } });
    const placement = warehouse.activeLayoutId ? await tx.layoutLocation.findFirst({
      where: { spaceId, warehouseId, layoutId: warehouse.activeLayoutId, locationId, location: { kind: { in: [...countable] } } },
      include: { location: true },
    }) : null;
    if (!placement) throw new ConflictException('货位须是当前布局中的储位或出库暂存位');
    return placement;
  }

  async create(scope: Scope, body: unknown) {
    const input = objectInput(body, ['key', 'locationId', 'reason']);
    const locationId = uuidInput(input.locationId).toLowerCase();
    const reason = textInput(input.reason, 1, 200);
    return this.command(scope, 'COUNT_CREATE', textInput(input.key, 8, 100), { locationId, reason }, async (tx) => {
      const { spaceId, warehouseId } = scope;
      const location = { spaceId, warehouseId, locationId };
      const placement = await this.placement(tx, scope, locationId);
      const [existing, task, balances] = await Promise.all([
        tx.countOrder.findFirst({ where: { ...location, status: { in: [...active] } }, select: { id: true } }),
        tx.transportTask.findFirst({
          where: { spaceId, warehouseId, phase: { in: ['READY', 'IN_TRANSIT'] },
            OR: [{ stagingLocationId: locationId }, { allocation: { locationId } }] },
          select: { id: true },
        }),
        tx.inventoryBalance.findMany({ where: location, include: { batch: { include: { sku: true } } } }),
      ]);
      if (existing) throw new ConflictException('该货位已有活动盘点');
      if (task || balances.some((balance) => balance.reserved > 0)) {
        throw new ConflictException('该货位仍有预占或活动运输');
      }
      const order = await tx.countOrder.create({
        data: { ...location, layoutId: placement.layoutId, lines: { create: balances.map((row) => ({
          balanceId: row.id, skuId: row.skuId, batchId: row.batchId, skuCode: row.batch.sku.code, batchCode: row.batch.code,
          quality: row.quality, expected: row.onHand, balanceVersion: row.version,
        })) } },
        include,
      });
      const result = view(order);
      await this.audit(tx, scope, 'COUNT_CREATED', reason, null, result);
      return result;
    });
  }

  async phase(scope: Scope, id: string, action: Action, body: unknown) {
    id = uuidInput(id).toLowerCase();
    const input = objectInput(body, action === 'submit' ? ['key', 'reason', 'lines'] : ['key', 'reason']);
    const reason = textInput(input.reason, 1, 200);
    const rows = action === 'submit' ? actualsInput(input.lines) : [];
    const operation = `COUNT_${action.toUpperCase()}`;
    return this.command(scope, operation, textInput(input.key, 8, 100), { id, reason, rows }, async (tx) => {
      const order = await tx.countOrder.findFirst({ where: { id, spaceId: scope.spaceId, warehouseId: scope.warehouseId }, include });
      if (!order) throw new NotFoundException('盘点单不可访问');
      const before = view(order);
      if (action === 'submit') {
        if (order.status !== 'OPEN') throw new ConflictException('盘点单已提交或关闭');
        const counts = new Map(rows.map((row) => [row.balanceId, row.actual]));
        if (rows.length !== order.lines.length || order.lines.some((line) => !counts.has(line.balanceId))) {
          throw new BadRequestException('实数必须逐项对应开盘快照');
        }
        for (const { balanceId, actual } of rows) {
          await tx.countLine.update({ where: { countId_balanceId: { countId: id, balanceId } }, data: { actual } });
        }
      } else if (action === 'approve' ? order.status !== 'SUBMITTED' : order.status !== 'OPEN' && order.status !== 'SUBMITTED') {
        throw new ConflictException('盘点单当前阶段不能执行该操作');
      }

      const changes = action === 'approve' ? await this.approvalChanges(tx, scope, order) : [];
      // The warehouse lock remains held after this status change. Only this transaction can see the released freeze.
      const result = view(await tx.countOrder.update({ where: { id }, include, data: action === 'submit'
        ? { status: 'SUBMITTED', submissionNote: reason }
        : { status: action === 'approve' ? 'APPROVED' : 'REJECTED' } }));
      for (const change of changes) {
        const { line, actual, delta } = change;
        const updated = await tx.inventoryBalance.updateMany({
          where: { id: line.balanceId, version: line.balanceVersion, onHand: line.expected, reserved: 0 },
          data: { onHand: actual, version: { increment: 1 } },
        });
        if (updated.count !== 1) throw new ConflictException('库存快照已变化，请重新盘点');
        await tx.inventoryMovement.create({ data: {
          spaceId: scope.spaceId, warehouseId: scope.warehouseId, skuId: line.skuId, batchId: line.batchId,
          kind: 'COUNT_ADJUSTMENT', quantity: Math.abs(delta), businessKey: `count:${id}:${line.balanceId}`,
          sourceLocationId: delta < 0 ? order.locationId : null, sourceQuality: delta < 0 ? line.quality : null,
          destinationLocationId: delta > 0 ? order.locationId : null, destinationQuality: delta > 0 ? line.quality : null,
          actorType: 'USER', actorId: scope.actorId, reason, reference: id,
        } });
      }
      await this.audit(tx, scope, `COUNT_${result.status}`, reason, before, result);
      return result;
    });
  }

  private async approvalChanges(tx: Tx, scope: Scope, order: Order) {
    const placement = await this.placement(tx, scope, order.locationId);
    if (placement.layoutId !== order.layoutId) throw new ConflictException('布局已变化，请拒绝此单并重新盘点');
    const balances = await tx.inventoryBalance.findMany({
      where: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, locationId: order.locationId },
    });
    const current = new Map(balances.map((row) => [row.id, row]));
    if (balances.length !== order.lines.length) throw new ConflictException('货位余额集合已变化，请重新盘点');
    const changes = order.lines.map((line) => {
      const row = current.get(line.balanceId);
      if (!row || row.reserved !== 0 || row.onHand !== line.expected || row.version !== line.balanceVersion
        || row.skuId !== line.skuId || row.batchId !== line.batchId || row.quality !== line.quality || line.actual === null) {
        throw new ConflictException('库存快照已变化或实数不完整，请重新盘点');
      }
      return { line, actual: line.actual, delta: line.actual - line.expected };
    });
    if (changes.reduce((sum, row) => sum + row.actual, 0) > placement.capacity) throw new ConflictException('盘点实数超过当前货位容量');
    if (placement.location.kind === 'STORAGE'
      && new Set(changes.filter((row) => row.actual > 0).map(({ line }) => line.batchId)).size > 1) {
      throw new ConflictException('储位盘点结果不能混放 SKU 或批次');
    }
    return changes.filter((change) => change.delta !== 0).sort((a, b) => a.delta - b.delta);
  }

  private audit(tx: Tx, scope: Scope, action: string, reason: string, before: CountOrderResponse | null, after: CountOrderResponse) {
    return tx.auditLog.create({ data: {
      ...scope, action, reason, requestId: randomUUID(), correlationId: after.id,
      before: before ? before as Prisma.InputJsonObject : {}, after: after as Prisma.InputJsonObject,
    } });
  }
}
