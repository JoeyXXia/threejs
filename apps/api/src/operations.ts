import type { OperationsResponse } from '@warehouse-twin/contracts';
import type { Prisma } from '@warehouse-twin/database';
import type { WarehouseScope } from './warehouse-state';

const tickLimit = 240;
const completed = ['TRANSPORT_DROPPED', 'PUTAWAY_DROPPED'];
const cancelled = ['TRANSPORT_CANCELLED', 'PUTAWAY_CANCELLED'];
const congestion = new Set(['OCCUPIED', 'EDGE_SWAP', 'TARGET_CONFLICT', 'RESOURCE_BUSY']);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function waitHeat(events: readonly { seq: number; tick: number; payload: unknown }[], layout: { id: string; width: number; depth: number }) {
  const cells = new Map<string, { x: number; z: number; ms: number }>();
  const ticks = new Set<number>();
  const seqs: number[] = [];
  for (const event of events.slice(0, tickLimit)) {
    const payload = record(event.payload);
    if (!payload || payload.layoutId !== layout.id || payload.tickMs !== 250 || !Array.isArray(payload.robots) || ticks.has(event.tick)) continue;
    ticks.add(event.tick); seqs.push(event.seq);
    const robots = new Set<string>();
    for (const item of payload.robots as unknown[]) {
      const robot = record(item), cell = record(robot?.cell);
      if (!robot || !cell || typeof robot.id !== 'string' || robots.has(robot.id)) continue;
      robots.add(robot.id);
      const { x, z } = cell;
      if (typeof robot.waitReason !== 'string' || !congestion.has(robot.waitReason)
        || typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= layout.width
        || typeof z !== 'number' || !Number.isInteger(z) || z < 0 || z >= layout.depth) continue;
      const key = `${x}:${z}`;
      const previous = cells.get(key);
      cells.set(key, { x, z, ms: (previous?.ms ?? 0) + payload.tickMs });
    }
  }
  return { limit: tickLimit, sampledTicks: ticks.size,
    firstSeq: seqs.length ? Math.min(...seqs) : null, lastSeq: seqs.length ? Math.max(...seqs) : null,
    cells: [...cells.values()].sort((a, b) => a.z - b.z || a.x - b.x) } as const;
}

export async function readOperations(tx: Prisma.TransactionClient, scope: WarehouseScope, layoutId: string): Promise<OperationsResponse> {
  const [clock] = await tx.$queryRaw<{ through: Date }[]>`SELECT transaction_timestamp() AS through`;
  const through = clock!.through;
  const from = new Date(through.getTime() - 60 * 60 * 1000);
  const layout = await tx.layoutVersion.findUniqueOrThrow({ where: { id: layoutId }, select: { id: true, width: true, depth: true } });
  const watermark = (await tx.warehouseRuntime.findUnique({ where: { spaceId_warehouseId: scope }, select: { seq: true } }))?.seq ?? 0;
  const [inbound, outbound, count, putaway, transport, terminal, events] = await Promise.all([
    tx.inboundOrder.count({ where: { ...scope, status: { in: ['CREATED', 'RECEIVED'] } } }),
    tx.outboundOrder.count({ where: { ...scope, status: { in: ['CREATED', 'ALLOCATED'] } } }),
    tx.countOrder.count({ where: { ...scope, status: { in: ['OPEN', 'SUBMITTED'] } } }),
    tx.putawayTask.groupBy({ by: ['phase'], where: { ...scope, phase: { in: ['READY', 'IN_TRANSIT'] } }, _count: { _all: true } }),
    tx.transportTask.groupBy({ by: ['phase'], where: { ...scope, phase: { in: ['READY', 'IN_TRANSIT'] } }, _count: { _all: true } }),
    tx.warehouseEvent.groupBy({ by: ['kind'], where: {
      ...scope, seq: { lte: watermark }, createdAt: { gte: from, lte: through }, kind: { in: [...completed, ...cancelled] },
    }, _count: { _all: true } }),
    tx.warehouseEvent.findMany({ where: { ...scope, kind: 'FLEET_TICK', seq: { lte: watermark }, payload: { path: ['layoutId'], equals: layoutId } },
      select: { seq: true, tick: true, payload: true }, orderBy: { seq: 'desc' }, take: tickLimit }),
  ]);
  const taskCounts = [...putaway, ...transport];
  const byPhase = (phase: string) => taskCounts.filter((row) => row.phase === phase).reduce((n, row) => n + row._count._all, 0);
  const byKind = (kinds: string[]) => terminal.filter((row) => kinds.includes(row.kind)).reduce((n, row) => n + row._count._all, 0);
  const wait = waitHeat(events, layout);
  return { ...scope, layoutId, watermark, pending: { inbound, outbound, count },
    queue: { ready: byPhase('READY'), inTransit: byPhase('IN_TRANSIT') },
    terminal: { from: from.toISOString(), through: through.toISOString(), completed: byKind(completed), cancelled: byKind(cancelled) },
    wait: { ...wait, cells: [...wait.cells] } };
}
