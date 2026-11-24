import { BadRequestException, ConflictException } from '@nestjs/common';
import { replayFrameSchema, type HistoryPage, type ReplayFrame } from '@warehouse-twin/contracts';
import type { Prisma, WarehouseReplayFrame } from '@warehouse-twin/database';
import type { WarehouseScope } from './warehouse-state';

type Definition = NonNullable<ReplayFrame['state']['definition']>;
type RecordInput = Pick<ReplayFrame, 'seq' | 'tick' | 'layoutId' | 'layoutVersion' | 'mode'> & {
  robots: ReplayFrame['state']['robots']; definition: Definition;
};

// Called only by the fenced tick writers, after ledger and event writes in the same transaction.
export async function recordReplayFrame(tx: Prisma.TransactionClient, scope: WarehouseScope, input: RecordInput) {
  const { robots, definition, ...meta } = input;
  const last = await tx.warehouseReplayFrame.findFirst({
    where: scope, orderBy: { seq: 'desc' }, select: { layoutId: true, mode: true },
  });
  const anchor = meta.tick % 20 === 0 || last?.layoutId !== meta.layoutId || last.mode !== meta.mode;
  const [totals] = await tx.$queryRaw<{ onHand: bigint; reserved: bigint; available: bigint; hold: bigint }[]>`
    SELECT COALESCE(SUM(b."onHand"), 0) AS "onHand", COALESCE(SUM(b.reserved), 0) AS reserved,
      COALESCE(SUM(CASE WHEN b.quality = 'RELEASED' AND (lot."expiresAt" IS NULL OR lot."expiresAt" > transaction_timestamp())
        THEN b."onHand" - b.reserved ELSE 0 END), 0) AS available,
      COALESCE(SUM(CASE WHEN b.quality = 'HOLD' THEN b."onHand" ELSE 0 END), 0) AS hold
    FROM "InventoryBalance" b JOIN "Batch" lot ON lot.id = b."batchId"
    WHERE b."spaceId" = ${scope.spaceId}::uuid AND b."warehouseId" = ${scope.warehouseId}::uuid
  `;
  const inventory = { onHand: Number(totals!.onHand), reserved: Number(totals!.reserved),
    available: Number(totals!.available), hold: Number(totals!.hold) };
  const state = { format: 1, robots, inventory, owners: definition.resources.map(({ id, ownerId }) => ({ id, ownerId })),
    ...(anchor ? { definition } : {}) };
  await tx.warehouseReplayFrame.create({ data: { ...scope, ...meta, anchor, state } });
}

function iso(raw: unknown) {
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(raw)) throw new BadRequestException('需要 UTC ISO 时间');
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== (raw.length === 20 ? raw.replace('Z', '.000Z') : raw)) {
    throw new BadRequestException('历史时间无效');
  }
  return date;
}
function integer(raw: unknown, min: number, max: number) {
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new BadRequestException('历史分页参数无效');
  return Number(raw);
}

export function replayQuery(input: Record<string, unknown>) {
  if (Object.keys(input).some((key) => !['from', 'to', 'after', 'through', 'limit'].includes(key))) throw new BadRequestException('未知历史参数');
  const from = iso(input.from), to = iso(input.to);
  if (to < from || to.getTime() - from.getTime() > 86_400_000) throw new BadRequestException('历史范围最多 24 小时');
  if ((input.after === undefined) !== (input.through === undefined)) throw new BadRequestException('续页须同时提供 after 和 through');
  return { from, to, limit: input.limit === undefined ? 50 : integer(input.limit, 1, 100),
    after: input.after === undefined ? undefined : integer(input.after, 0, 2147483647),
    through: input.through === undefined ? undefined : integer(input.through, 1, 2147483647) };
}

function project(row: WarehouseReplayFrame): ReplayFrame {
  const frame = replayFrameSchema.safeParse({ ...row, capturedAt: row.capturedAt.toISOString() });
  if (!frame.success) throw new ConflictException('历史帧损坏或版本不支持');
  return frame.data;
}

export async function readHistory(tx: Prisma.TransactionClient, scope: WarehouseScope, query: ReturnType<typeof replayQuery>): Promise<HistoryPage> {
  const range = { ...scope, ...(query.through === undefined ? {} : { seq: { lte: query.through } }) };
  const first = await tx.warehouseReplayFrame.findFirst({
    where: { ...range, capturedAt: { lte: query.from } }, orderBy: { seq: 'desc' }, select: { seq: true },
  }) ?? await tx.warehouseReplayFrame.findFirst({
    where: { ...range, capturedAt: { gte: query.from, lte: query.to } }, orderBy: { seq: 'asc' }, select: { seq: true },
  });
  if (!first) {
    if (query.after !== undefined) throw new ConflictException('历史分页窗口已不可用');
    return { ...scope, first: null, through: null, baseline: null, events: [], frames: [], nextAfter: null };
  }
  const last = await tx.warehouseEvent.findFirst({
    where: { ...scope, createdAt: { lte: query.to }, ...(query.through === undefined ? {} : { seq: query.through }) },
    orderBy: { seq: 'desc' }, select: { seq: true },
  });
  const base = await tx.warehouseReplayFrame.findFirst({
    where: { ...scope, anchor: true, seq: { lte: first.seq } }, orderBy: { seq: 'desc' },
  });
  if (!base || !last || last.seq < first.seq) throw new ConflictException('历史缺少基线或分页水位无效');
  const after = query.after ?? base.seq;
  if (after < base.seq || after > last.seq) throw new BadRequestException('历史游标超出窗口');
  const events = await tx.warehouseEvent.findMany({ where: { ...scope, seq: { gt: after, lte: last.seq } },
    orderBy: { seq: 'asc' }, take: query.limit });
  if (events.length < Math.min(last.seq - after, query.limit) || events.some((e, index) => e.seq !== after + index + 1)) {
    throw new ConflictException('历史事件段不连续');
  }
  const end = events.at(-1)?.seq ?? after;
  const frames = (await tx.warehouseReplayFrame.findMany({
    where: { ...scope, seq: { gt: after, lte: end } }, orderBy: { seq: 'asc' },
  })).map(project);
  const ticks = new Map(frames.map((f) => [f.seq, f.tick]));
  const isTick = (e: { kind: string }) => e.kind === 'FLEET_TICK' || e.kind === 'SIM_TICK';
  if (events.some((e) => isTick(e) && ticks.get(e.seq) !== e.tick) || frames.length !== events.filter(isTick).length) {
    throw new ConflictException('历史轨迹段不完整');
  }
  return { ...scope, first: first.seq, through: last.seq, baseline: project(base), frames,
    events: events.map((e) => ({ seq: e.seq, tick: e.tick, version: e.version, epoch: e.epoch, kind: e.kind,
      createdAt: e.createdAt.toISOString(), payload: isTick(e) ? null : e.payload })),
    nextAfter: end < last.seq ? end : null };
}
