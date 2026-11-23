import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type WarehouseRuntime } from '@warehouse-twin/database';
import { robotCheckpointSchema, type RobotSnapshot, type SimulationResponse } from '@warehouse-twin/contracts';
import { createRobotTask, createSimulation, findPath, stepRobotTask, type Cell, type RobotTask } from '@warehouse-twin/simulation';
import { DatabaseService } from '../database.service';
import { PutawayService } from '../transport/putaway.service';
import { TransportService } from '../transport/transport.service';
import { objectInput, textInput, uuidInput } from '../auth/input';
import { appendWarehouseEvent, databaseNow, lockWarehouseState } from '../warehouse-state';

type Scope = { actorId: string; spaceId: string; warehouseId: string };
type Checkpoint = { format: 1; actorId: string; taskId: string; kind: 'OUTBOUND' | 'PUTAWAY'; inboundOrderId: string | null; allocationId: string | null; stagingId: string;
  task: RobotTask; from: Cell; error: string | null; loaded: boolean };
export type PreparedTick = { scope: Scope; ownerId: string; epoch: number; expectedTick: number; expectedVersion: number;
  checkpoint: Checkpoint; proposal: ReturnType<typeof stepRobotTask> };
class FenceConflict extends ConflictException {}
const active = (checkpoint: Checkpoint) => !['COMPLETED', 'ERROR'].includes(checkpoint.task.phase);
const json = (value: object) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

@Injectable()
export class SimulationService implements OnModuleInit, OnModuleDestroy {
  readonly ownerId = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(TransportService) private readonly transport: TransportService,
    @Inject(PutawayService) private readonly putaway: PutawayService = new PutawayService()) {}
  onModuleInit() {
    if (!this.timer) this.timer = setInterval(() => { void this.advance().catch(() => { /* DB outage: UI becomes stale; no checkpoint advance. */ }); }, 250);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    await this.db.$executeRaw`UPDATE "WarehouseRuntime" SET "leaseUntil"=clock_timestamp() WHERE "ownerId"=${this.ownerId}::uuid`;
  }
  private decode(row: WarehouseRuntime): Checkpoint | null {
    if (row.checkpoint === null) return null;
    const parsed = robotCheckpointSchema.safeParse(row.checkpoint);
    if (!parsed.success || parsed.data.task.simulation.tick !== row.tick) throw new ConflictException('运行检查点损坏或版本未知，已停止');
    const run = parsed.data, s = run.task.simulation, robot = s.robot;
    const blocked = new Set(s.map.blocked.map((p) => `${p.x}:${p.z}`));
    const valid = (p: Cell) => p.x < s.map.width && p.z < s.map.depth && !blocked.has(`${p.x}:${p.z}`);
    const pathValid = (path: readonly Cell[]) => path.length > 0 && path.every((p, i) => valid(p)
      && (!i || Math.abs(p.x - path[i - 1]!.x) + Math.abs(p.z - path[i - 1]!.z) === 1));
    const prior = robot.path[robot.next - 1];
    if (!valid(robot.position) || !valid(run.from) || !pathValid(robot.path) || !pathValid(run.task.transportPath)
      || !prior || prior.x !== robot.position.x || prior.z !== robot.position.z
      || (robot.status === 'IDLE' && robot.next !== robot.path.length)
      || (['TRANSPORT', 'UNLOADING'].includes(run.task.phase) && !run.loaded)
      || (['APPROACH', 'LOADING', 'COMPLETED'].includes(run.task.phase) && run.loaded)) {
      throw new ConflictException('运行路径或载货检查点无效，已停止');
    }
    return parsed.data;
  }
  private async lockAccess(tx: Prisma.TransactionClient, scope: Scope) {
    await tx.$queryRaw`SELECT "userId" FROM "WarehouseAccess" WHERE "userId"=${scope.actorId}::uuid
      AND "spaceId"=${scope.spaceId}::uuid AND "warehouseId"=${scope.warehouseId}::uuid FOR SHARE`;
  }
  private async access(scope: Scope, write = false, tx: Prisma.TransactionClient = this.db) {
    for (const value of [scope.actorId, scope.spaceId, scope.warehouseId]) uuidInput(value);
    if (write) await this.lockAccess(tx, scope);
    const access = await tx.warehouseAccess.findUnique({
      where: { userId_spaceId_warehouseId: { userId: scope.actorId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } },
      include: { warehouse: { include: { activeLayout: { include: { racks: true, placements: { include: { location: true } } } } } } },
    });
    if (!access) throw new NotFoundException('仓库不可访问');
    if (write && access.role === 'VIEWER') throw new ForbiddenException('只读账户不能启动机器人');
    if (!access.warehouse.activeLayout) throw new ConflictException('仓库没有已发布布局');
    return access;
  }
  private snapshot(run: Checkpoint): RobotSnapshot {
    const { simulation: state, phase } = run.task;
    return { taskId: run.taskId, kind: run.kind, inboundOrderId: run.inboundOrderId, allocationId: run.allocationId, layoutId: state.map.layoutId, layoutVersion: state.map.version,
      phase, tick: state.tick, logicalTimeMs: state.logicalTimeMs, tickMs: 250,
      from: run.from, to: state.robot.position, direction: state.robot.direction, battery: state.robot.battery,
      route: [...state.robot.path], carrying: run.loaded, error: run.error ?? run.task.error };
  }
  async read(scope: Scope): Promise<SimulationResponse> {
    return this.db.$transaction(async (tx) => {
      const access = await this.access(scope, false, tx);
      const where = { spaceId: scope.spaceId, warehouseId: scope.warehouseId };
      const row = await tx.warehouseRuntime.findUnique({ where: { warehouseId: scope.warehouseId } });
      const run = row ? this.decode(row) : null;
      const allocations = await tx.allocation.findMany({ where: { ...where, order: { status: 'ALLOCATED' },
        OR: [{ task: null }, { task: { phase: 'READY' } }] },
        include: { task: true, balance: { include: { location: true } }, order: { include: { batch: true } } }, orderBy: { id: 'asc' }, take: 100 });
      const claimed = new Set((await tx.fleetClaim.findMany({ where: { ...where, active: true }, select: { taskId: true } })).map((c) => c.taskId));
      const receipts = await tx.inboundOrder.findMany({ where: { ...where, status: 'PASSED', putawayTask: null }, include: { batch: true }, orderBy: { id: 'asc' }, take: 100 });
      return { ...where, putawayReceipts: receipts.map((r) => ({ id: r.id, quantity: r.quantity, label: `${r.batch.code} · ${r.quantity} 件 · ${r.id.slice(0, 8)}` })),
        storage: access.warehouse.activeLayout!.placements.filter((p) => p.location.kind === 'STORAGE').map((p) => ({ id: p.locationId, code: p.location.code })), role: access.role, runtime: run ? this.snapshot(run) : null,
        watermark: row?.seq ?? 0, epoch: row?.epoch ?? 0, stateVersion: row?.version ?? 0,
        allocations: allocations.filter((a) => !a.task || !claimed.has(a.task.id)).map((a) => ({ id: a.id, quantity: a.quantity, label: `${a.order.batch.code} · ${a.balance.location.code} · ${a.quantity} 件` })),
        staging: access.warehouse.activeLayout!.placements.filter((p) => p.location.kind === 'OUTBOUND').map((p) => ({ id: p.locationId, code: p.location.code })) };
    }, { isolationLevel: 'RepeatableRead' });
  }
  async events(scope: Scope, after: number) {
    if (!Number.isSafeInteger(after) || after < 0 || after > 2147483647) throw new BadRequestException('事件游标无效');
    return this.db.$transaction(async (tx) => {
      await this.access(scope, false, tx);
      const row = await tx.warehouseRuntime.findUnique({ where: { warehouseId: scope.warehouseId } });
      const watermark = row?.seq ?? 0;
      if (after > watermark) throw new ConflictException('事件游标超出当前仓库水位');
      const events = await tx.warehouseEvent.findMany({ where: { spaceId: scope.spaceId, warehouseId: scope.warehouseId,
        seq: { gt: after, lte: watermark } }, orderBy: { seq: 'asc' }, take: 100 });
      return { spaceId: scope.spaceId, warehouseId: scope.warehouseId, after, watermark,
        events: events.map((e) => ({ seq: e.seq, version: e.version, epoch: e.epoch, tick: e.tick, kind: e.kind, payload: e.payload, createdAt: e.createdAt.toISOString() })),
        hasMore: (events.at(-1)?.seq ?? after) < watermark };
    }, { isolationLevel: 'RepeatableRead' });
  }
  private async lease(tx: Prisma.TransactionClient, row: WarehouseRuntime) {
    const now = await databaseNow(tx);
    if (row.ownerId !== this.ownerId && row.leaseUntil && row.leaseUntil > now) return null;
    return tx.warehouseRuntime.update({ where: { warehouseId: row.warehouseId }, data: {
      ownerId: this.ownerId, epoch: row.ownerId === this.ownerId && row.leaseUntil && row.leaseUntil > now ? row.epoch : row.epoch + 1,
      leaseUntil: new Date(now.getTime() + 5000),
    } });
  }
  async start(scope: Scope, value: unknown) {
    const candidate = objectInput(value, ['kind', 'allocationId', 'stagingLocationId', 'inboundOrderId', 'targetLocationId', 'reason']);
    const kind = candidate.kind ?? 'OUTBOUND';
    if (kind !== 'OUTBOUND' && kind !== 'PUTAWAY') throw new BadRequestException('任务类型无效');
    const body = objectInput(value, kind === 'OUTBOUND' ? ['kind', 'allocationId', 'stagingLocationId', 'reason'] : ['kind', 'inboundOrderId', 'targetLocationId', 'reason']);
    const allocationId = kind === 'OUTBOUND' ? uuidInput(body.allocationId) : null;
    const inboundOrderId = kind === 'PUTAWAY' ? uuidInput(body.inboundOrderId) : null;
    const stagingId = uuidInput(kind === 'OUTBOUND' ? body.stagingLocationId : body.targetLocationId);
    const reason = textInput(body.reason, 1, 200);
    const access = await this.access(scope, true);
    const old = await this.db.warehouseRuntime.findUnique({ where: { warehouseId: scope.warehouseId } });
    const previous = old ? this.decode(old) : null;
    const layout = access.warehouse.activeLayout!;
    // Geometry and A* are outside the write transaction; version is rechecked on commit.
    const allocation = allocationId ? await this.db.allocation.findFirst({ where: { id: allocationId, spaceId: scope.spaceId, warehouseId: scope.warehouseId }, include: { task: true, order: true } }) : null;
    const receipt = inboundOrderId ? await this.db.inboundOrder.findFirst({ where: { id: inboundOrderId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } }) : null;
    if (kind === 'PUTAWAY' ? receipt?.status !== 'PASSED' : !allocation || allocation.order.status !== 'ALLOCATED') throw new ConflictException('入库单或出库分配不可执行');
    const source = layout.placements.find((p) => p.locationId === (allocation?.locationId ?? receipt?.qcLocationId));
    const destination = layout.placements.find((p) => p.locationId === stagingId && p.location.kind === (kind === 'PUTAWAY' ? 'STORAGE' : 'OUTBOUND'));
    if (!source || !destination) throw new ConflictException('取放货位不在当前布局');
    const blocked = layout.racks.flatMap((rack) => Array.from({ length: rack.sizeX * rack.sizeZ }, (_, i) => ({ x: rack.gridX + i % rack.sizeX, z: rack.gridZ + Math.floor(i / rack.sizeX) })));
    const map = { layoutId: layout.id, version: layout.version, width: layout.width, depth: layout.depth, blocked };
    const parking = layout.placements.find((p) => p.location.kind === 'CHARGING') ?? source;
    const position = previous?.task.simulation.map.layoutId === layout.id ? previous.task.simulation.robot.position : { x: parking.serviceX, z: parking.serviceZ };
    const initial = createSimulation({ map, seed: 42, position, battery: previous?.task.simulation.robot.battery ?? 10000 });
    const simulation = { ...initial, tick: old?.tick ?? 0, logicalTimeMs: (old?.tick ?? 0) * 250 };
    const walls = new Set(blocked.map((p) => `${p.x}:${p.z}`));
    const grid = { ...map, walkable: (p: Cell) => Number.isInteger(p.x) && Number.isInteger(p.z) && p.x >= 0 && p.z >= 0 && p.x < map.width && p.z < map.depth && !walls.has(`${p.x}:${p.z}`) };
    const pickup = { x: source.serviceX, z: source.serviceZ }, target = { x: destination.serviceX, z: destination.serviceZ };
    const approach = findPath(grid, position, pickup), carrying = findPath(grid, pickup, target);
    if (approach.status !== 'found' || carrying.status !== 'found') throw new ConflictException('取放货路径不可达或超过搜索预算');
    const task = createRobotTask(simulation, approach.path, carrying.path);
    return this.db.$transaction(async (tx) => {
      await this.access(scope, true, tx);
      const row = await lockWarehouseState(tx, scope);
      if (row.fleet !== null) throw new ConflictException('仓库已进入多车模式，请使用多车分配');
      const current = this.decode(row);
      if (current && current.kind === kind && current.allocationId === allocationId && current.inboundOrderId === inboundOrderId) {
        if (current.stagingId !== stagingId || current.task.phase === 'ERROR') throw new ConflictException('任务目标冲突或已停止');
        return this.snapshot(current);
      }
      if (current && current.task.phase !== 'COMPLETED') throw new ConflictException('仓库已有活动或异常任务');
      if (row.version !== (old?.version ?? 0)) throw new ConflictException('计算期间仓库状态已变化，请重试');
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
      if (warehouse.activeLayoutId !== layout.id) throw new ConflictException('计算期间布局已变化');
      if (approach.cost! + carrying.cost! >= simulation.robot.battery) throw new ConflictException('电量不足');
      const owned = await this.lease(tx, row);
      if (!owned) throw new ConflictException('其他 runner 仍持有租约');
      const ledger = kind === 'PUTAWAY' ? await this.putaway.createInTransaction(tx, scope, inboundOrderId!, stagingId, reason)
        : await this.transport.createInTransaction(tx, scope, allocationId!, stagingId, reason);
      if (ledger.phase !== 'READY') throw new ConflictException('运输阶段已变化');
      const checkpoint: Checkpoint = { format: 1, actorId: scope.actorId, taskId: ledger.id, kind, inboundOrderId, allocationId, stagingId, task, from: position, error: null, loaded: false };
      await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { checkpoint: json(checkpoint) } });
      await appendWarehouseEvent(tx, scope, 'SIM_STARTED', json(this.snapshot(checkpoint)));
      await this.renew(tx, owned);
      return this.snapshot(checkpoint);
    }, { timeout: 15000 });
  }
  // Internal/test entry. The DB lease, not a process-local flag, establishes ownership.
  async prepare(warehouseId: string): Promise<PreparedTick | null> {
    if (this.stopped) return null;
    const candidate = await this.db.warehouseRuntime.findUnique({ where: { warehouseId } });
    if (!candidate) return null;
    const run = this.decode(candidate);
    if (!run || !active(run) || run.task.simulation.paused) return null;
    const scope = { actorId: run.actorId, spaceId: candidate.spaceId, warehouseId };
    const row = await this.db.$transaction(async (tx) => this.lease(tx, await lockWarehouseState(tx, scope)));
    if (!row) return null;
    const checkpoint = this.decode(row)!;
    if (!active(checkpoint)) return null;
    return { scope, ownerId: this.ownerId, epoch: row.epoch, expectedTick: row.tick, expectedVersion: row.version,
      checkpoint, proposal: stepRobotTask(checkpoint.task) };
  }
  private async fence(tx: Prisma.TransactionClient, prepared: PreparedTick) {
    const row = await lockWarehouseState(tx, prepared.scope), now = await databaseNow(tx);
    if (prepared.ownerId !== this.ownerId || row.ownerId !== this.ownerId || row.epoch !== prepared.epoch
      || row.tick !== prepared.expectedTick || row.version !== prepared.expectedVersion || !row.leaseUntil || row.leaseUntil <= now) {
      throw new FenceConflict('runner、租约、tick 或状态版本已变化');
    }
    return row;
  }
  private async renew(tx: Prisma.TransactionClient, row: WarehouseRuntime) {
    const now = await databaseNow(tx);
    // A transaction that outlives its lease must roll back, even if it held the row lock.
    if (!row.leaseUntil || row.leaseUntil <= now) throw new FenceConflict('事务执行期间租约已过期');
    await tx.warehouseRuntime.update({ where: { warehouseId: row.warehouseId }, data: { leaseUntil: new Date(now.getTime() + 5000) } });
  }
  async commit(prepared: PreparedTick, error?: string) {
    return this.db.$transaction(async (tx) => {
      await this.lockAccess(tx, prepared.scope);
      const row = await this.fence(tx, prepared);
      const { scope, checkpoint } = prepared;
      if (prepared.proposal.task.simulation.tick !== prepared.expectedTick + 1) throw new FenceConflict('下一 tick 不连续');
      const access = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId: scope.actorId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } } });
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
      const ledger = checkpoint.kind === 'PUTAWAY' ? await tx.putawayTask.findUniqueOrThrow({ where: { id: checkpoint.taskId } })
        : await tx.transportTask.findUniqueOrThrow({ where: { id: checkpoint.taskId } });
      const expected = checkpoint.loaded ? 'IN_TRANSIT' : 'READY';
      const failure = error ?? (!access || access.role === 'VIEWER' ? '权限已撤销' : warehouse.activeLayoutId !== checkpoint.task.simulation.map.layoutId
        ? '布局已变化' : ledger.phase !== expected ? '账本阶段已变化' : null);
      const next: Checkpoint = failure
        ? { ...checkpoint, task: { ...checkpoint.task, phase: 'ERROR' }, from: checkpoint.task.simulation.robot.position, error: failure }
        : { ...checkpoint, task: prepared.proposal.task, from: checkpoint.task.simulation.robot.position,
          loaded: prepared.proposal.effect ? prepared.proposal.effect === 'take' : checkpoint.loaded };
      if (!failure && prepared.proposal.effect) await (checkpoint.kind === 'PUTAWAY' ? this.putaway : this.transport).moveInTransaction(tx, scope, checkpoint.taskId, prepared.proposal.effect, '软件机器人阶段过账');
      await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { tick: next.task.simulation.tick, checkpoint: json(next) } });
      await appendWarehouseEvent(tx, scope, failure ? 'SIM_ERROR' : 'SIM_TICK', json(this.snapshot(next)));
      await this.renew(tx, row);
      return this.snapshot(next);
    }, { timeout: 15000 });
  }
  advance(): Promise<void> {
    if (this.pending || this.stopped) return this.pending ?? Promise.resolve();
    const run = async () => {
      const rows = await this.db.warehouseRuntime.findMany({ where: { checkpoint: { not: Prisma.DbNull } } });
      for (const row of rows) {
        let prepared: PreparedTick | null = null;
        try { prepared = await this.prepare(row.warehouseId); if (prepared) await this.commit(prepared); }
        catch (error) {
          if (prepared && !(error instanceof FenceConflict)) await this.commit(prepared, '过账异常，任务已停止，请检查后台记录').catch(() => { /* Lost fence or DB outage: no speculative state. */ });
        }
      }
    };
    this.pending = run().finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
