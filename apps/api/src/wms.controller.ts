import { BadRequestException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { MovementKind, Prisma, reconcileWarehouse } from '@warehouse-twin/database';
import type { WmsReconciliation, WmsResponse } from '@warehouse-twin/contracts';
import { AuthGuard, AuthRequest } from './auth/auth.guard';
import { objectInput, uuidInput } from './auth/input';
import { DatabaseService } from './database.service';

const pageSize = 25;
const expiresSoon = 7 * 24 * 60 * 60 * 1000;
const descending = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
const batchWithSku = { sku: { select: { code: true } } } as const;
type Batch = Prisma.BatchGetPayload<{ include: typeof batchWithSku }>;
type Scope = { spaceId: string; warehouseId: string };
type Cursor = { id: string; createdAt: Date };

function batchView(batch: Batch) {
  return { id: batch.id, code: batch.code, skuCode: batch.sku.code, expiresAt: batch.expiresAt?.toISOString() ?? null };
}

function pageBoundary(anchor: Cursor | null) {
  return anchor ? { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] } : {};
}

function page<T extends { id: string }>(rows: T[]) {
  const items = rows.slice(0, pageSize);
  return { items, before: rows.length > pageSize ? items.at(-1)!.id : null };
}

@Controller('spaces/:spaceId/warehouses/:warehouseId/wms')
@UseGuards(AuthGuard)
export class WmsController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  private snapshot<T>(req: AuthRequest, scope: Scope, read: (tx: Prisma.TransactionClient, asOf: Date) => Promise<T>) {
    return this.db.$transaction(async (tx) => {
      const access = await tx.warehouseAccess.findUnique({
        where: { userId_spaceId_warehouseId: { ...scope, userId: req.identity.userId } },
      });
      if (!access) throw new NotFoundException('仓库不可访问');
      if (access.role === 'VIEWER') throw new ForbiddenException('台账与对账限仓库管理员和操作员');
      return read(tx, new Date());
    }, { isolationLevel: 'RepeatableRead' });
  }

  @Get()
  list(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string,
    @Query() raw: unknown): Promise<WmsResponse> {
    const scope = { spaceId: uuidInput(spaceId), warehouseId: uuidInput(warehouseId) };
    return this.snapshot(req, scope, async (tx, asOf) => {
      const input = objectInput(raw, ['kind', 'batchId', 'movementBefore', 'auditBefore']);
      const kind = input.kind;
      if (kind !== undefined && (typeof kind !== 'string' || !Object.values(MovementKind).some((value) => value === kind))) {
        throw new BadRequestException('无效的流水类型');
      }
      const batchId = input.batchId === undefined ? null : uuidInput(input.batchId);
      const movementId = input.movementBefore === undefined ? null : uuidInput(input.movementBefore);
      const auditId = input.auditBefore === undefined ? null : uuidInput(input.auditBefore);
      const movementScope = { ...scope, ...(kind ? { kind: kind as MovementKind } : {}), ...(batchId ? { batchId } : {}) };
      const [selected, movementAnchor, auditAnchor] = await Promise.all([
        batchId ? tx.batch.findFirst({ where: { ...scope, id: batchId }, include: batchWithSku }) : null,
        movementId ? tx.inventoryMovement.findFirst({ where: { ...movementScope, id: movementId }, select: { id: true, createdAt: true } }) : null,
        auditId ? tx.auditLog.findFirst({ where: { ...scope, id: auditId }, select: { id: true, createdAt: true } }) : null,
      ]);
      if (batchId && !selected) throw new NotFoundException('批次不可访问');
      if ((movementId && !movementAnchor) || (auditId && !auditAnchor)) throw new BadRequestException('游标不属于当前仓库或筛选条件');
      const [batches, balances, alertRows, movementRows, auditRows] = await Promise.all([
        tx.batch.findMany({ where: scope, include: batchWithSku, orderBy: [{ skuId: 'asc' }, { code: 'asc' }] }),
        selected ? tx.inventoryBalance.findMany({ where: { ...scope, batchId: selected.id },
          include: { location: { select: { code: true } } }, orderBy: [{ locationId: 'asc' }, { id: 'asc' }] }) : [],
        tx.inventoryBalance.groupBy({ by: ['batchId', 'quality'], where: { ...scope, onHand: { gt: 0 }, OR: [
          { quality: 'HOLD' }, { batch: { expiresAt: { lte: new Date(asOf.getTime() + expiresSoon) } } },
        ] }, _sum: { onHand: true } }),
        tx.inventoryMovement.findMany({
          where: { ...movementScope, ...pageBoundary(movementAnchor) }, orderBy: descending, take: pageSize + 1,
          include: { batch: { include: batchWithSku }, source: { select: { code: true } }, destination: { select: { code: true } } },
        }),
        tx.auditLog.findMany({
          where: { ...scope, ...pageBoundary(auditAnchor) }, orderBy: descending, take: pageSize + 1,
          include: { actor: { select: { email: true } } },
        }),
      ]);
      const batchOptions = batches.map(batchView);
      const warningTotals = new Map<string, { total: number; hold: number }>();
      for (const row of alertRows) {
        const entry = warningTotals.get(row.batchId) ?? { total: 0, hold: 0 };
        const quantity = row._sum.onHand ?? 0;
        entry.total += quantity;
        if (row.quality === 'HOLD') entry.hold += quantity;
        warningTotals.set(row.batchId, entry);
      }
      const warnings: WmsResponse['warnings'] = [];
      for (const batch of batchOptions) {
        const total = warningTotals.get(batch.id);
        if (!total) continue;
        const expiry = batch.expiresAt ? Date.parse(batch.expiresAt) : Infinity;
        if (expiry <= asOf.getTime() + expiresSoon) {
          warnings.push({ batch, type: expiry <= asOf.getTime() ? 'EXPIRED' : 'EXPIRING', quantity: total.total });
        }
        if (total.hold > 0) warnings.push({ batch, type: 'HOLD', quantity: total.hold });
      }
      const movements = page(movementRows);
      const audits = page(auditRows);
      return {
        ...scope, asOf: asOf.toISOString(), batches: batchOptions, warnings,
        batch: selected ? { ...batchView(selected), producedAt: selected.producedAt?.toISOString() ?? null,
          balances: balances.map((row) => ({ id: row.id, locationCode: row.location.code, quality: row.quality, onHand: row.onHand, reserved: row.reserved })),
        } : null,
        movements: movements.items.map((row) => ({
          id: row.id, kind: row.kind, batch: batchView(row.batch), quantity: row.quantity, reason: row.reason,
          reference: row.reference, createdAt: row.createdAt.toISOString(),
          source: row.source && row.sourceQuality ? { code: row.source.code, quality: row.sourceQuality } : null,
          destination: row.destination && row.destinationQuality ? { code: row.destination.code, quality: row.destinationQuality } : null,
        })),
        audits: audits.items.map((row) => ({
          id: row.id, action: row.action, actor: row.actor.email, reason: row.reason, correlationId: row.correlationId, createdAt: row.createdAt.toISOString(),
        })),
        movementBefore: movements.before, auditBefore: audits.before,
      };
    });
  }

  @Get('reconcile')
  reconcile(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string): Promise<WmsReconciliation> {
    const scope = { spaceId: uuidInput(spaceId), warehouseId: uuidInput(warehouseId) };
    return this.snapshot(req, scope, async (tx, asOf) => ({
      ...scope, asOf: asOf.toISOString(), ...await reconcileWarehouse(tx, scope),
    }));
  }
}
