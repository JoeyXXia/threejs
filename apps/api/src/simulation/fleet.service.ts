import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type WarehouseRuntime } from '@warehouse-twin/database';
import { fleetEnvelopeSchema, resourceDefinitionSchema, robotCheckpointSchema, type FleetResponse } from '@warehouse-twin/contracts';
import { assignFleetTask, changeNavigation, chargeCommand, chargePath, configureResources, controlRobot, createFleet, findPath, fleetAlerts, navigationOf, stepFleet, taskEnergy, type FleetState, type Cell } from '@warehouse-twin/simulation';
import { DatabaseService } from '../database.service';
import { TransportService } from '../transport/transport.service';
import { PutawayService } from '../transport/putaway.service';
import { objectInput, textInput, uuidInput } from '../auth/input';
import { appendWarehouseEvent, databaseNow, lockWarehouseState } from '../warehouse-state';
import { recordReplayFrame } from '../replay';

type Scope = { spaceId: string; warehouseId: string; actorId: string };
type Envelope = { format: 1; state: FleetState; from: readonly Cell[] };
type Boundary = { spaceId: string; warehouseId: string };
export type FleetPrepared = { scope: Boundary; ownerId: string; epoch: number; tick: number; version: number; envelope: Envelope; proposal: ReturnType<typeof stepFleet> };
const json = (v: object) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonObject;
const active = (s: FleetState) => s.robots.some((r) => r.charge || (r.work && !['COMPLETED', 'ERROR'].includes(r.work.phase)));
const defaultDock = (placements: { serviceX: number; serviceZ: number; location: { kind: string } }[]) => {
  const dock = placements.find((p) => p.location.kind === 'CHARGING');
  return dock && { x: dock.serviceX, z: dock.serviceZ };
};
class FleetFenceConflict extends ConflictException {}

@Injectable()
export class FleetService implements OnModuleInit, OnModuleDestroy {
  readonly ownerId = randomUUID();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(TransportService) private readonly transport: TransportService = new TransportService(db),
    @Inject(PutawayService) private readonly putaway: PutawayService = new PutawayService()) {}
  onModuleInit() { this.timer = setInterval(() => { void this.advance().catch(() => {}); }, 250); this.timer.unref(); }
  async onModuleDestroy() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.pending;
    await this.db.$executeRaw`UPDATE "WarehouseRuntime" SET "leaseUntil"=clock_timestamp() WHERE "ownerId"=${this.ownerId}::uuid`; }
  private decode(row: WarehouseRuntime): Envelope | null {
    if (row.fleet === null) return null;
    const parsed = fleetEnvelopeSchema.safeParse(row.fleet);
    if (!parsed.success || parsed.data.state.tick !== row.tick || parsed.data.from.length !== parsed.data.state.robots.length) throw new ConflictException('多车检查点损坏');
    const e = parsed.data;
    try {
      stepFleet(e.state); // Validation only: proposal is discarded; never advances durable state.
      if (navigationOf(e.state).closed.some((p) => e.from.some((c) => c.x === p.x && c.z === p.z))) throw new Error('closed confirmed segment');
      for (const [i, r] of e.state.robots.entries()) {
        const s = r.simulation, walls = new Set(s.map.blocked.map((p) => `${p.x}:${p.z}`));
        if (JSON.stringify(s.map) !== JSON.stringify(e.state.robots[0]!.simulation.map) || s.map.width * s.map.depth > 65536
          || s.map.blocked.some((p) => p.x >= s.map.width || p.z >= s.map.depth)) throw new Error('map');
        const valid = (p: Cell) => p.x >= 0 && p.z >= 0 && p.x < s.map.width && p.z < s.map.depth && !walls.has(`${p.x}:${p.z}`);
        if (s.tickMs !== 250 || !valid(s.robot.position) || !valid(e.from[i]!)
          || Math.abs(s.robot.position.x - e.from[i]!.x) + Math.abs(s.robot.position.z - e.from[i]!.z) > 1) throw new Error('pose');
        if (r.work || r.charge) {
          for (const path of [s.robot.path, ...(r.work ? [r.work.transportPath] : [])]) if (!path.length || path.some((p, j) => !valid(p)
            || (j > 0 && Math.abs(p.x - path[j - 1]!.x) + Math.abs(p.z - path[j - 1]!.z) !== 1))) throw new Error('path');
          if (JSON.stringify(s.robot.path[s.robot.next - 1]) !== JSON.stringify(s.robot.position)) throw new Error('cursor');
        }
      }
    } catch { throw new ConflictException('多车路径、归属或时钟无效，停止推进'); }
    return e;
  }
  private async auth(tx: Prisma.TransactionClient, scope: Scope, write = false) {
    for (const id of [scope.spaceId, scope.warehouseId, scope.actorId]) uuidInput(id);
    if (write) await this.aclLock(tx, scope);
    const a = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId: scope.actorId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } },
      include: { warehouse: { include: { activeLayout: { include: { racks: true, placements: { include: { location: true } } } } } } } });
    if (!a) throw new NotFoundException('仓库不可访问');
    if (write && a.role === 'VIEWER') throw new ForbiddenException('只读账户不能分配多车任务');
    if (!a.warehouse.activeLayout) throw new ConflictException('仓库没有已发布布局');
    return a;
  }
  private aclLock(tx: Prisma.TransactionClient, scope: Scope) {
    return tx.$queryRaw`SELECT "userId" FROM "WarehouseAccess" WHERE "userId"=${scope.actorId}::uuid AND "spaceId"=${scope.spaceId}::uuid AND "warehouseId"=${scope.warehouseId}::uuid FOR SHARE`;
  }
  async read(scope: Scope): Promise<FleetResponse> {
    return this.db.$transaction((tx) => this.readInTransaction(tx, scope), { isolationLevel: 'RepeatableRead' });
  }

  async readInTransaction(tx: Prisma.TransactionClient, scope: Scope): Promise<FleetResponse> {
    const a = await this.auth(tx, scope), row = await tx.warehouseRuntime.findUnique({ where: { warehouseId: scope.warehouseId } });
    const e = row ? this.decode(row) : null;
    const claims = await tx.fleetClaim.findMany({ where: { spaceId: scope.spaceId, warehouseId: scope.warehouseId } });
    return { spaceId: scope.spaceId, warehouseId: scope.warehouseId, role: a.role, enabled: !!e, tick: row?.tick ?? 0,
      watermark: row?.seq ?? 0, epoch: row?.epoch ?? 0, stateVersion: row?.version ?? 0,
      layoutId: e?.state.robots[0]?.simulation.map.layoutId ?? null, layoutVersion: e?.state.robots[0]?.simulation.map.version ?? null,
      resources: (e?.state.resources ?? []).map((r) => ({ ...r, cells: [...r.cells] })),
      navigation: e ? { ...navigationOf(e.state), closed: [...navigationOf(e.state).closed] } : { revision: 0, closed: [] },
      alerts: e ? fleetAlerts(e.state) : [],
      robots: e?.state.robots.map((r, i) => { const claim = claims.find((c) => c.id === r.work?.taskId);
        if (r.work && (!claim || claim.robotId !== r.id || claim.active === (r.work.phase === 'COMPLETED')
          || (['APPROACH', 'LOADING', 'COMPLETED'].includes(r.work.phase) && claim.loaded)
          || (['TRANSPORT', 'UNLOADING'].includes(r.work.phase) && !claim.loaded))) throw new ConflictException('持久任务归属或载荷与检查点不一致');
        return { id: r.id, taskId: r.work?.taskId ?? null, ledgerTaskId: claim?.taskId ?? null, phase: r.work?.phase ?? 'IDLE',
          from: e.from[i]!, to: r.simulation.robot.position, battery: r.simulation.robot.battery, carrying: claim?.loaded ?? false,
          route: [...r.simulation.robot.path.slice(Math.max(0, r.simulation.robot.next - 1))], waitTicks: r.waitTicks, totalWaitTicks: r.totalWaitTicks,
          waitReason: r.waitReason, blockerId: r.blockerId, resourceWaitId: r.resourceWaitId ?? null, navigationIssue: r.navigationIssue ?? null,
          charge: r.charge ?? null, deviceFault: r.deviceFault ?? null, recoveryStatus: r.deviceFault ? (claim?.loaded ? 'NEEDS_RECOVERY' : 'PAUSED') : null, error: r.work?.error ?? null }; }) ?? [] };
  }
  async charge(scope: Scope, value: unknown) {
    const body = objectInput(value, ['robotId', 'action', 'reason']);
    const robotId = textInput(body.robotId, 1, 64), reason = textInput(body.reason, 1, 200), action = body.action;
    if (action !== 'START' && action !== 'STOP') throw new BadRequestException('充电操作无效');
    const a = await this.auth(this.db, scope, true), layout = a.warehouse.activeLayout!;
    const row = await this.db.warehouseRuntime.findUnique({ where: { warehouseId: scope.warehouseId } }), e = row && this.decode(row);
    const r = e?.state.robots.find((b) => b.id === robotId);
    if (!row || !e || !r) throw new ConflictException('请先选择车队中的车辆');
    const path = action === 'START' ? chargePath(e.state, r.simulation.robot.position, defaultDock(layout.placements)) : null;
    if (action === 'START' && !path) throw new ConflictException('充电位不可达或规划超预算');
    let state: FleetState;
    try { state = chargeCommand(e.state, robotId, path); } catch { throw new ConflictException('有任务、故障、电量不足、满电或充电状态已改变'); }
    await this.db.$transaction(async (tx) => {
      const access = await this.auth(tx, scope, true);
      const current = await lockWarehouseState(tx, scope);
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
      if (current.tick !== row.tick || current.version !== row.version ||
        (action === 'START' && (warehouse.activeLayoutId !== r.simulation.map.layoutId || access.warehouse.activeLayoutId !== warehouse.activeLayoutId)))
        throw new ConflictException('车队状态或布局已变化，请刷新');
      await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { fleet: json({ ...e, state }) } });
      await appendWarehouseEvent(tx, scope, 'FLEET_CHARGE', { tick: row.tick, robotId, action, actorId: scope.actorId, reason,
        dock: action === 'START' ? path!.at(-1)! : r.charge!.dock });
    }, { timeout: 15000 });
    return this.read(scope);
  }
  async control(scope: Scope, value: unknown) {
    const body = objectInput(value, ['robotId', 'action', 'expectedTaskId', 'reason']);
    const robotId = textInput(body.robotId, 1, 64), reason = textInput(body.reason, 1, 200);
    const taskId = body.expectedTaskId === null ? null : uuidInput(body.expectedTaskId), action = body.action;
    if (action !== 'FAULT' && action !== 'REPAIR' && action !== 'CANCEL') throw new BadRequestException('恢复操作无效');
    await this.db.$transaction(async (tx) => {
      // Same ACL -> warehouse/runtime lock order as assignment and tick commit.
      await this.auth(tx, scope, true);
      const row = await lockWarehouseState(tx, scope), e = this.decode(row), r = e?.state.robots.find((r) => r.id === robotId);
      if (!e || !r || (r.work?.taskId ?? null) !== taskId) throw new ConflictException('任务归属已变化，请重读');
      const claim = taskId ? await tx.fleetClaim.findFirst({ where: { id: taskId, ...{ spaceId: scope.spaceId, warehouseId: scope.warehouseId }, robotId, active: true } }) : null;
      if (taskId && !claim) throw new ConflictException('任务不是活动归属');
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
      if (warehouse.activeLayoutId !== r.simulation.map.layoutId) throw new ConflictException('布局已变化，不能盲目恢复');
      if (action === 'REPAIR' && claim) {
        const owner = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId: claim.actorId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } } });
        if (!owner || owner.role === 'VIEWER') throw new ConflictException('原任务授权已撤销，不能恢复');
      }
      if (claim) {
        const ledger = claim.kind === 'OUTBOUND' ? await tx.transportTask.findUnique({ where: { id: claim.taskId } }) : await tx.putawayTask.findUnique({ where: { id: claim.taskId } });
        if (ledger?.phase !== (claim.loaded ? 'IN_TRANSIT' : 'READY')) throw new ConflictException('领域阶段不一致，不能操作');
      }
      let state: FleetState;
      try { state = controlRobot(e.state, robotId, action, reason); } catch { throw new ConflictException('仅模拟故障可维修；仅取货前可取消，载货必须保留原任务恢复'); }
      if (action === 'CANCEL') {
        if (!claim || claim.loaded) throw new ConflictException('载货或无活动任务，禁止取消');
        await (claim.kind === 'OUTBOUND' ? this.transport : this.putaway).cancelInTransaction(tx, scope, claim.taskId, reason);
        await tx.fleetClaim.update({ where: { id: claim.id }, data: { active: false } });
      }
      await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { fleet: json({ ...e, state }) } });
      const payload = { tick: row.tick, robotId, taskId, action, reason, actorId: scope.actorId, carrying: claim?.loaded ?? false,
        phase: r.work?.phase ?? null, deviceFault: state.robots.find((b) => b.id === robotId)!.deviceFault ?? null };
      await tx.auditLog.create({ data: { spaceId: scope.spaceId, warehouseId: scope.warehouseId, actorId: scope.actorId,
        action: `FLEET_${action}`, reason, requestId: randomUUID(), correlationId: taskId, before: json({ robot: r }), after: json(payload) } });
      await appendWarehouseEvent(tx, scope, `FLEET_${action}`, payload);
    }, { timeout: 15000 });
    return this.read(scope);
  }
  async changeMap(scope: Scope, value: unknown) {
    const body = objectInput(value, ['cells', 'closed', 'expectedRevision', 'reason']), reason = textInput(body.reason, 1, 200);
    const parsed = resourceDefinitionSchema.shape.cells.max(128).safeParse(body.cells);
    if (!parsed.success || typeof body.closed !== 'boolean' || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new BadRequestException('封锁命令格式无效');
    const closed = body.closed;
    await this.auth(this.db, scope, true);
    const row = await this.db.warehouseRuntime.findUnique({ where: { warehouseId: scope.warehouseId } }), e = row ? this.decode(row) : null;
    if (!row || !e) throw new ConflictException('请先初始化车队');
    // Calculate bounded paths outside the write transaction; tick/version fence rejects stale work.
    let state: FleetState;
    try { state = changeNavigation(e.state, parsed.data, closed, Number(body.expectedRevision), e.from); }
    catch { throw new ConflictException('地图版本过期、格非法或已被车辆/确认运动段占用'); }
    await this.db.$transaction(async (tx) => {
      await this.auth(tx, scope, true);
      const current = await lockWarehouseState(tx, scope), warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
      if (current.tick !== row.tick || current.version !== row.version || warehouse.activeLayoutId !== e.state.robots[0]!.simulation.map.layoutId) throw new ConflictException('重规划期间状态/布局变化，请重新读取后重试');
      if (state === e.state) return;
      await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { fleet: json({ ...e, state }) } });
      await appendWarehouseEvent(tx, scope, 'FLEET_NAVIGATION_CHANGED', { tick: row.tick, actorId: scope.actorId, reason, cells: parsed.data, closed,
        navigation: navigationOf(state), robots: state.robots.map((r) => ({ id: r.id, issue: r.navigationIssue ?? null })) });
    }, { timeout: 15000 });
    return this.read(scope);
  }
  async configure(scope: Scope, value: unknown) {
    const body = objectInput(value, ['resources', 'reason']), reason = textInput(body.reason, 1, 200);
    const definitions = resourceDefinitionSchema.array().min(1).max(32).safeParse(body.resources);
    if (!definitions.success) throw new BadRequestException('资源配置格式无效');
    await this.db.$transaction(async (tx) => {
      await this.auth(tx, scope, true);
      const row = await lockWarehouseState(tx, scope), e = this.decode(row);
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
      if (!e || e.state.robots[0]!.simulation.map.layoutId !== warehouse.activeLayoutId) throw new ConflictException('需要当前布局的车队');
      let state: FleetState;
      try { state = configureResources(e.state, definitions.data); } catch { throw new ConflictException('资源须连通、可走、不重叠且单容量；仅首次无活动任务时配置，不能重置许可'); }
      if (state === e.state) return;
      await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { fleet: json({ ...e, state }) } });
      await appendWarehouseEvent(tx, scope, 'FLEET_RESOURCES_CONFIGURED', { tick: row.tick, actorId: scope.actorId, reason, resources: state.resources });
    }, { timeout: 15000 });
    return this.read(scope);
  }
  async initialize(scope: Scope, value: unknown) {
    const body = objectInput(value, ['count', 'reason']), count = body.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 3 || count > 5) throw new BadRequestException('车数须为 3–5');
    const reason = textInput(body.reason, 1, 200);
    await this.db.$transaction(async (tx) => {
      const a = await this.auth(tx, scope, true), row = await lockWarehouseState(tx, scope), old = this.decode(row);
      if (old) { if (old.state.robots.length !== count) throw new ConflictException('已有车队，不支持重置或改变车数'); return; }
      const prior = row.checkpoint === null ? null : robotCheckpointSchema.safeParse(row.checkpoint);
      if (prior && (!prior.success || prior.data.task.phase !== 'COMPLETED' || prior.data.loaded || prior.data.task.simulation.tick !== row.tick)) throw new ConflictException('单车仍有任务或异常，禁止切换');
      const layout = a.warehouse.activeLayout!;
      if (prior && prior.success && prior.data.task.simulation.map.layoutId !== layout.id) throw new ConflictException('旧车布局不同，禁止重置位置或电量');
      const blocked = layout.racks.flatMap((r) => Array.from({ length: r.sizeX * r.sizeZ }, (_, i) => ({ x: r.gridX + i % r.sizeX, z: r.gridZ + Math.floor(i / r.sizeX) })));
      const walls = new Set(blocked.map((p) => `${p.x}:${p.z}`));
      const station = layout.placements.find((p) => p.location.kind === 'CHARGING');
      if (!station) throw new ConflictException('布局缺少初始停车参考点');
      const cells = Array.from({ length: layout.width * layout.depth }, (_, i) => ({ x: i % layout.width, z: Math.floor(i / layout.width) }))
        .filter((p) => !walls.has(`${p.x}:${p.z}`)).sort((p, q) => Math.abs(p.x - station.serviceX) + Math.abs(p.z - station.serviceZ) - Math.abs(q.x - station.serviceX) - Math.abs(q.z - station.serviceZ) || p.z - q.z || p.x - q.x);
      const last = prior && prior.success && prior.data.task.simulation.map.layoutId === layout.id ? prior.data.task.simulation : null;
      if (last) { const i = cells.findIndex((p) => p.x === last.robot.position.x && p.z === last.robot.position.z); if (i < 0) throw new ConflictException('旧车位置在新布局不可用'); cells.unshift(...cells.splice(i, 1)); }
      if (cells.length < count) throw new ConflictException('停车格不足');
      const parking: Cell[] = [];
      for (const point of cells) { if (parking.every((p) => Math.abs(p.x - point.x) + Math.abs(p.z - point.z) >= 2)) parking.push(point); if (parking.length === count) break; }
      if (parking.length !== count) throw new ConflictException('不相邻停车格不足');
      const created = createFleet({ map: { layoutId: layout.id, version: layout.version, width: layout.width, depth: layout.depth, blocked }, seed: 42,
        robots: parking.map((position, i) => ({ id: `robot-${i + 1}`, position, battery: i === 0 && last ? last.robot.battery : 10000 })) });
      const state: FleetState = { ...created, tick: row.tick, robots: created.robots.map((r) => ({ ...r, simulation: { ...r.simulation, tick: row.tick, logicalTimeMs: row.tick * 250 } })) };
      await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { checkpoint: Prisma.DbNull, fleet: json({ format: 1, state, from: state.robots.map((r) => r.simulation.robot.position) }) } });
      await appendWarehouseEvent(tx, scope, 'FLEET_INITIALIZED', { count, actorId: scope.actorId, reason, tick: row.tick });
    }, { timeout: 15000 });
    return this.read(scope);
  }
  async assign(scope: Scope, value: unknown) {
    const raw = objectInput(value, ['robotId', 'kind', 'allocationId', 'stagingLocationId', 'inboundOrderId', 'targetLocationId', 'reason']);
    const kind = raw.kind ?? 'OUTBOUND';
    if (kind !== 'OUTBOUND' && kind !== 'PUTAWAY') throw new BadRequestException('任务类型无效');
    const body = objectInput(value, kind === 'OUTBOUND' ? ['robotId', 'kind', 'allocationId', 'stagingLocationId', 'reason'] : ['robotId', 'kind', 'inboundOrderId', 'targetLocationId', 'reason']);
    const robotId = textInput(body.robotId, 1, 64), sourceId = uuidInput(kind === 'OUTBOUND' ? body.allocationId : body.inboundOrderId), targetId = uuidInput(kind === 'OUTBOUND' ? body.stagingLocationId : body.targetLocationId), reason = textInput(body.reason, 1, 200);
    const a = await this.auth(this.db, scope, true), row = await this.db.warehouseRuntime.findUniqueOrThrow({ where: { warehouseId: scope.warehouseId } }), e = this.decode(row);
    const robot = e?.state.robots.find((r) => r.id === robotId);
    if (!e || !robot) throw new ConflictException('请先初始化车队并选择有效车辆');
    const item = kind === 'OUTBOUND' ? await this.db.allocation.findFirst({ where: { id: sourceId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } })
      : await this.db.inboundOrder.findFirst({ where: { id: sourceId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } });
    if (!item) throw new NotFoundException('来源不可访问');
    const locationId = 'qcLocationId' in item ? item.qcLocationId : item.locationId, layout = a.warehouse.activeLayout!;
    const source = layout.placements.find((p) => p.locationId === locationId), target = layout.placements.find((p) => p.locationId === targetId);
    const map = robot.simulation.map, walls = new Set([...map.blocked, ...navigationOf(e.state).closed].map((p) => `${p.x}:${p.z}`));
    if (!source || !target || map.layoutId !== layout.id) throw new ConflictException('布局或端点已变化');
    // Plan around known parked cells and other tasks' final poses; endpoints may still queue.
    // These are planning obstacles only, not permanent map walls or Day23 resource permits.
    const occupied = new Set(e.state.robots.filter((r) => r.id !== robotId).flatMap((r) => [r.simulation.robot.position, ...(r.work ? [r.work.transportPath.at(-1)!] : [])]).map((p) => `${p.x}:${p.z}`));
    const endpoint = (p: Cell) => (p.x === source.serviceX && p.z === source.serviceZ) || (p.x === target.serviceX && p.z === target.serviceZ)
      || (p.x === robot.simulation.robot.position.x && p.z === robot.simulation.robot.position.z);
    const grid = { ...map, walkable: (p: Cell) => p.x >= 0 && p.z >= 0 && p.x < map.width && p.z < map.depth && !walls.has(`${p.x}:${p.z}`) && (!occupied.has(`${p.x}:${p.z}`) || endpoint(p)) };
    const approach = findPath(grid, robot.simulation.robot.position, { x: source.serviceX, z: source.serviceZ }), carrying = findPath(grid, { x: source.serviceX, z: source.serviceZ }, { x: target.serviceX, z: target.serviceZ });
    if (approach.status !== 'found' || carrying.status !== 'found') throw new ConflictException('路径不可达或超预算');
    const returnPath = chargePath(e.state, { x: target.serviceX, z: target.serviceZ }, defaultDock(layout.placements));
    const requiredBattery = returnPath ? taskEnergy(approach.cost!, carrying.cost!, returnPath.length - 1) : null;
    try { return await this.db.$transaction(async (tx) => {
      await this.auth(tx, scope, true); const current = await lockWarehouseState(tx, scope), saved = this.decode(current);
      if (!saved) throw new ConflictException('车队未初始化');
      const ledger = kind === 'OUTBOUND' ? await this.transport.createInTransaction(tx, scope, sourceId, targetId, reason) : await this.putaway.createInTransaction(tx, scope, sourceId, targetId, reason);
      if (ledger.phase === 'CANCELLED') throw new ConflictException('已取消运输保留历史，不可重新领取');
      const existing = await tx.fleetClaim.findUnique({ where: { warehouseId_kind_taskId: { warehouseId: scope.warehouseId, kind, taskId: ledger.id } } });
      if (existing) { if (existing.robotId !== robotId) throw new ConflictException('任务已由其他车辆领取'); return existing; }
      if (current.version !== row.version || current.tick !== row.tick || ledger.phase !== 'READY') throw new ConflictException('计算期间状态或阶段已变化，请重试');
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: scope.warehouseId } });
      if (warehouse.activeLayoutId !== layout.id || requiredBattery === null || requiredBattery > robot.simulation.robot.battery)
        throw new ConflictException('电量不足或卸货后无可达充电位；未创建运输');
      const claim = await tx.fleetClaim.create({ data: { id: randomUUID(), spaceId: scope.spaceId, warehouseId: scope.warehouseId, kind, taskId: ledger.id, robotId, actorId: scope.actorId } });
      let state: FleetState;
      try { state = assignFleetTask(saved.state, robotId, claim.id, approach.path, carrying.path); } catch { throw new ConflictException('车辆已有活动/异常任务'); }
      await tx.warehouseRuntime.update({ where: { warehouseId: scope.warehouseId }, data: { fleet: json({ ...saved, state }) } });
      await appendWarehouseEvent(tx, scope, 'FLEET_ASSIGNED', { claimId: claim.id, robotId, taskId: ledger.id, actorId: scope.actorId, reason, tick: current.tick, requiredBattery });
      return claim;
    }, { timeout: 15000 }); } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('车辆或任务已被分配'); throw error;
    }
  }
  async prepare(warehouseId: string): Promise<FleetPrepared | null> {
    if (this.stopped) return null;
    const row = await this.db.$transaction(async (tx) => {
      const initial = await tx.warehouseRuntime.findUnique({ where: { warehouseId } });
      if (!initial || !this.decode(initial) || !active(this.decode(initial)!.state)) return null;
      const locked = await lockWarehouseState(tx, initial), now = await databaseNow(tx);
      if (locked.ownerId !== this.ownerId && locked.leaseUntil && locked.leaseUntil > now) return null;
      return tx.warehouseRuntime.update({ where: { warehouseId }, data: { ownerId: this.ownerId,
        epoch: locked.ownerId === this.ownerId && locked.leaseUntil && locked.leaseUntil > now ? locked.epoch : locked.epoch + 1,
        leaseUntil: new Date(now.getTime() + 5000) } });
    });
    if (!row) return null;
    const envelope = this.decode(row)!;
    return { scope: { spaceId: row.spaceId, warehouseId }, ownerId: this.ownerId, epoch: row.epoch, tick: row.tick, version: row.version, envelope, proposal: stepFleet(envelope.state) };
  }
  private async fence(tx: Prisma.TransactionClient, p: FleetPrepared) {
    const claims = await tx.fleetClaim.findMany({ where: { ...p.scope, active: true }, orderBy: { actorId: 'asc' } });
    for (const actorId of [...new Set(claims.map((c) => c.actorId))]) await this.aclLock(tx, { ...p.scope, actorId });
    const row = await lockWarehouseState(tx, p.scope), now = await databaseNow(tx);
    if (p.ownerId !== this.ownerId || row.ownerId !== this.ownerId || row.epoch !== p.epoch || row.tick !== p.tick || row.version !== p.version || !row.leaseUntil || row.leaseUntil <= now) throw new FleetFenceConflict('多车 owner、epoch、tick 或版本已变化');
    return { row, claims };
  }
  async commit(p: FleetPrepared, halt = false) {
    return this.db.$transaction(async (tx) => {
      const { row, claims } = await this.fence(tx, p), e = this.decode(row)!;
      if (p.proposal.state.tick !== p.tick + 1 || navigationOf(p.proposal.state).revision !== navigationOf(e.state).revision) throw new FleetFenceConflict('多车 tick 或地图版本不连续');
      for (const r of e.state.robots) if (r.work && r.work.phase !== 'COMPLETED' && !claims.some((c) => c.id === r.work!.taskId && c.robotId === r.id)) throw new ConflictException('活动任务没有持久归属，停止推进');
      const warehouse = await tx.warehouse.findUniqueOrThrow({ where: { id: p.scope.warehouseId } });
      if (e.state.robots.some((r) => r.charge && r.simulation.map.layoutId !== warehouse.activeLayoutId))
        throw new FleetFenceConflict('布局变化；先停止旧充电计划');
      let failure: string | null = halt ? '批次过账异常，保留占格与在途货物' : null;
      for (const c of claims) {
        const r = e.state.robots.find((r) => r.work?.taskId === c.id);
        if (!r || r.id !== c.robotId) throw new ConflictException('检查点与持久归属不一致');
        if (r.work?.phase === 'ERROR') continue;
        const access = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId: c.actorId, ...p.scope } } });
        const ledger = c.kind === 'OUTBOUND' ? await tx.transportTask.findFirst({ where: { id: c.taskId, ...p.scope } }) : await tx.putawayTask.findFirst({ where: { id: c.taskId, ...p.scope } });
        if (!access || access.role === 'VIEWER') failure = '任务操作权限已撤销';
        else if (warehouse.activeLayoutId !== r.simulation.map.layoutId) failure = '布局已变化';
        else if (ledger?.phase !== (c.loaded ? 'IN_TRANSIT' : 'READY')) failure = '账本阶段已变化';
      }
      if (failure) {
        const state = { ...e.state, robots: e.state.robots.map((r) => r.work && !['COMPLETED', 'ERROR'].includes(r.work.phase) ? { ...r, navigationIssue: null, work: { ...r.work, phase: 'ERROR', error: failure } } : r) };
        await tx.warehouseRuntime.update({ where: { warehouseId: p.scope.warehouseId }, data: { fleet: json({ ...e, state, from: state.robots.map((r) => r.simulation.robot.position) }) } });
        await appendWarehouseEvent(tx, p.scope, 'FLEET_ERROR', { tick: row.tick, error: failure });
      } else {
        for (const effect of p.proposal.effects) {
          const c = claims.find((c) => c.id === effect.taskId);
          if (!c || c.robotId !== effect.robotId) throw new ConflictException('取放效果没有有效归属');
          await (c.kind === 'OUTBOUND' ? this.transport : this.putaway).moveInTransaction(tx, { ...p.scope, actorId: c.actorId }, c.taskId, effect.stage, '多车批次阶段过账');
          await tx.fleetClaim.update({ where: { id: c.id }, data: { loaded: effect.stage === 'take', active: effect.stage !== 'drop' } });
        }
        await tx.warehouseRuntime.update({ where: { warehouseId: p.scope.warehouseId }, data: { tick: p.proposal.state.tick,
          fleet: json({ format: 1, state: p.proposal.state, from: e.state.robots.map((r) => r.simulation.robot.position) }) } });
        const previousAlerts = new Set(fleetAlerts(e.state).map((a) => a.key));
        const seq = await appendWarehouseEvent(tx, p.scope, 'FLEET_TICK', { tick: p.proposal.state.tick,
          layoutId: p.proposal.state.robots[0]!.simulation.map.layoutId, tickMs: p.proposal.state.robots[0]!.simulation.tickMs,
          newAlerts: fleetAlerts(p.proposal.state).filter((a) => !previousAlerts.has(a.key)),
          resources: p.proposal.state.resources ?? [],
          navigation: navigationOf(p.proposal.state),
          robots: p.proposal.state.robots.map((r) => ({ id: r.id, cell: r.simulation.robot.position, battery: r.simulation.robot.battery, charge: r.charge ?? null, taskId: r.work?.taskId ?? null, phase: r.work?.phase ?? 'IDLE', waitTicks: r.waitTicks, waitReason: r.waitReason, resourceWaitId: r.resourceWaitId ?? null, blockerId: r.blockerId, navigationIssue: r.navigationIssue ?? null, deviceFault: r.deviceFault ?? null })) });
        const state = p.proposal.state, map = state.robots[0]!.simulation.map;
        const completedIds = state.robots.flatMap((r) => r.work && !claims.some((c) => c.id === r.work!.taskId) ? [r.work.taskId] : []);
        const previous = completedIds.length ? await tx.fleetClaim.findMany({ where: { ...p.scope, id: { in: completedIds } } }) : [];
        await recordReplayFrame(tx, p.scope, {
          seq, tick: state.tick, layoutId: map.layoutId, layoutVersion: map.version, mode: 'FLEET',
          robots: state.robots.map((r, i) => {
            const claim = [...claims, ...previous].find((c) => c.id === r.work?.taskId);
            const effect = p.proposal.effects.find((item) => item.robotId === r.id);
            return { id: r.id, cell: r.simulation.robot.position, from: e.state.robots[i]!.simulation.robot.position,
              phase: r.work?.phase ?? 'IDLE', battery: r.simulation.robot.battery, taskId: r.work?.taskId ?? null,
              ledgerTaskId: claim?.taskId ?? null, carrying: effect ? effect.stage === 'take' : claim?.loaded ?? false,
              fault: !!r.deviceFault || r.work?.phase === 'ERROR', charging: !!r.charge, waitReason: r.waitReason };
          }),
          definition: { navigation: { ...navigationOf(state), closed: [...navigationOf(state).closed] },
            resources: (state.resources ?? []).map((r) => ({ ...r, cells: [...r.cells] })) },
        });
      }
      const now = await databaseNow(tx);
      if (row.leaseUntil! <= now) throw new FleetFenceConflict('批次执行期间租约已过期');
      await tx.warehouseRuntime.update({ where: { warehouseId: p.scope.warehouseId }, data: { leaseUntil: new Date(now.getTime() + 5000) } });
    }, { timeout: 15000 });
  }
  advance(): Promise<void> {
    if (this.pending || this.stopped) return this.pending ?? Promise.resolve();
    this.pending = (async () => {
      const rows = await this.db.warehouseRuntime.findMany({ where: { fleet: { not: Prisma.DbNull } } });
      for (const row of rows) { let prepared: FleetPrepared | null = null;
        try { prepared = await this.prepare(row.warehouseId); if (prepared) await this.commit(prepared); }
        catch (error) { if (prepared && !(error instanceof FleetFenceConflict)) await this.commit(prepared, true).catch(() => {}); }
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
