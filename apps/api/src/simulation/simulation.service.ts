import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createRobotTask, createSimulation, findPath, stepRobotTask, type Cell, type RobotTask } from '@warehouse-twin/simulation';
import type { RobotSnapshot, SimulationResponse } from '@warehouse-twin/contracts';
import { DatabaseService } from '../database.service';
import { TransportService } from '../transport/transport.service';
import { objectInput, textInput, uuidInput } from '../auth/input';

type Scope = { actorId: string; spaceId: string; warehouseId: string };
type Runtime = { scope: Scope; taskId: string; allocationId: string; stagingId: string;
  task: RobotTask; from: Cell; error: string | null; loaded: boolean };
const active = (run: Runtime) => !['COMPLETED', 'ERROR'].includes(run.task.phase);

@Injectable()
export class SimulationService implements OnModuleInit, OnModuleDestroy {
  private readonly runs = new Map<string, Runtime>();
  private readonly starting = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private advancing = false;
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(TransportService) private readonly transport: TransportService) {}

  onModuleInit() { if (!this.timer) { this.timer = setInterval(() => { void this.advance(); }, 250); this.timer.unref(); } }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private key(scope: Scope) { return `${scope.spaceId}:${scope.warehouseId}`; }

  private async access(scope: Scope, write = false) {
    for (const value of [scope.actorId, scope.spaceId, scope.warehouseId]) uuidInput(value);
    const access = await this.db.warehouseAccess.findUnique({
      where: { userId_spaceId_warehouseId: { userId: scope.actorId, spaceId: scope.spaceId, warehouseId: scope.warehouseId } },
      include: { warehouse: { include: { activeLayout: { include: { racks: true, placements: { include: { location: true } } } } } } },
    });
    if (!access) throw new NotFoundException('仓库不可访问');
    if (write && access.role === 'VIEWER') throw new ForbiddenException('只读账户不能启动机器人');
    if (!access.warehouse.activeLayout) throw new ConflictException('仓库没有已发布布局');
    return access;
  }

  private snapshot(run: Runtime): RobotSnapshot {
    const { simulation: state, phase } = run.task;
    return { taskId: run.taskId, allocationId: run.allocationId, layoutId: state.map.layoutId, layoutVersion: state.map.version,
      phase, tick: state.tick, logicalTimeMs: state.logicalTimeMs, tickMs: 250,
      from: run.from, to: state.robot.position, direction: state.robot.direction, battery: state.robot.battery,
      route: [...state.robot.path], carrying: run.loaded, error: run.error ?? run.task.error };
  }

  async read(scope: Scope): Promise<SimulationResponse> {
    const access = await this.access(scope);
    const where = { spaceId: scope.spaceId, warehouseId: scope.warehouseId };
    const allocations = await this.db.allocation.findMany({ where: { ...where, order: { status: 'ALLOCATED' },
      OR: [{ task: null }, { task: { phase: 'READY' } }] },
      include: { balance: { include: { location: true } }, order: { include: { batch: true } } }, orderBy: { id: 'asc' }, take: 100 });
    const run = this.runs.get(this.key(scope));
    return { ...where, role: access.role, runtime: run ? this.snapshot(run) : null,
      allocations: allocations.map((row) => ({ id: row.id, quantity: row.quantity,
        label: `${row.order.batch.code} · ${row.balance.location.code} · ${row.quantity} 件` })),
      staging: access.warehouse.activeLayout!.placements.filter((p) => p.location.kind === 'OUTBOUND')
        .map((p) => ({ id: p.locationId, code: p.location.code })) };
  }

  async start(scope: Scope, value: unknown) {
    const body = objectInput(value, ['allocationId', 'stagingLocationId', 'reason']);
    const allocationId = uuidInput(body.allocationId), stagingId = uuidInput(body.stagingLocationId);
    const reason = textInput(body.reason, 1, 200);
    const key = this.key(scope);
    await this.access(scope, true);
    if (this.starting.has(key)) throw new ConflictException('启动正在处理，请刷新后重试');
    const previous = this.runs.get(key);
    if (previous?.allocationId === allocationId) {
      if (previous.stagingId !== stagingId) throw new ConflictException('该任务已绑定其他暂存位');
      if (previous.task.phase === 'ERROR') throw new ConflictException('任务已停止，需要检查后端记录；本阶段不支持恢复');
      return this.snapshot(previous);
    }
    if (previous && active(previous)) throw new ConflictException('本仓库机器人正在执行任务');
    if (previous?.task.phase === 'ERROR') throw new ConflictException('本仓库任务异常，不能覆盖');
    this.starting.add(key);
    try {
      const access = await this.access(scope, true);
      const layout = access.warehouse.activeLayout!;
      const allocation = await this.db.allocation.findFirst({ where: { id: allocationId, spaceId: scope.spaceId, warehouseId: scope.warehouseId }, include: { task: true, order: true } });
      if (!allocation || allocation.order.status !== 'ALLOCATED') throw new ConflictException('分配不可执行');
      if (allocation.task && allocation.task.phase !== 'READY') throw new ConflictException('任务已取货或已到暂存区，不能重新初始化');
      const source = layout.placements.find((p) => p.locationId === allocation.locationId);
      const destination = layout.placements.find((p) => p.locationId === stagingId && p.location.kind === 'OUTBOUND');
      if (!source || !destination) throw new ConflictException('取放货位不在当前布局');
      const blocked = layout.racks.flatMap((rack) => Array.from({ length: rack.sizeX * rack.sizeZ }, (_, i) => ({ x: rack.gridX + i % rack.sizeX, z: rack.gridZ + Math.floor(i / rack.sizeX) })));
      const map = { layoutId: layout.id, version: layout.version, width: layout.width, depth: layout.depth, blocked };
      // createSimulation applies the same bounded map checks as the pure core.
      const parking = layout.placements.find((p) => p.location.kind === 'CHARGING') ?? source;
      const position = previous?.task.simulation.map.layoutId === layout.id
        ? previous.task.simulation.robot.position : { x: parking.serviceX, z: parking.serviceZ };
      const simulation = createSimulation({ map, seed: 42, position, battery: previous?.task.simulation.robot.battery ?? 10000 });
      const walls = new Set(blocked.map((p) => `${p.x}:${p.z}`));
      const grid = { ...map, walkable: (p: Cell) => Number.isInteger(p.x) && Number.isInteger(p.z)
        && p.x >= 0 && p.z >= 0 && p.x < map.width && p.z < map.depth && !walls.has(`${p.x}:${p.z}`) };
      const pickup = { x: source.serviceX, z: source.serviceZ }, target = { x: destination.serviceX, z: destination.serviceZ };
      const approach = findPath(grid, position, pickup), carrying = findPath(grid, pickup, target);
      if (approach.status !== 'found' || carrying.status !== 'found') throw new ConflictException('取放货路径不可达或超过搜索预算');
      if (approach.cost! + carrying.cost! >= simulation.robot.battery) throw new ConflictException('电量不足以完成路径');
      const task = createRobotTask(simulation, approach.path, carrying.path);
      const ledger = await this.transport.create(scope, allocationId, stagingId, reason, layout.id);
      if (ledger.phase !== 'READY') throw new ConflictException('运输阶段已变化，不能启动');
      const run: Runtime = { scope, taskId: ledger.id, allocationId, stagingId, task, from: position, error: null, loaded: false };
      this.runs.set(key, run);
      return this.snapshot(run);
    } finally { this.starting.delete(key); }
  }

  // One process-owned clock; guarded against overlapping callbacks. Tests call this with no timer.
  async advance() {
    if (this.advancing) return;
    this.advancing = true;
    try {
      for (const run of this.runs.values()) {
        if (!active(run)) continue;
        try {
          const access = await this.access(run.scope, true);
          if (access.warehouse.activeLayoutId !== run.task.simulation.map.layoutId) throw new Error('layout changed');
          const ledger = await this.db.transportTask.findUniqueOrThrow({ where: { id: run.taskId } });
          const expected = ['TRANSPORT', 'UNLOADING'].includes(run.task.phase) ? 'IN_TRANSIT' : 'READY';
          if (ledger.phase !== expected) throw new Error('ledger phase changed');
          const proposal = stepRobotTask(run.task);
          if (proposal.effect) {
            await this.transport[proposal.effect](run.scope, run.taskId, '软件机器人阶段过账', run.task.simulation.map.layoutId);
            run.loaded = proposal.effect === 'take';
          }
          run.from = run.task.simulation.robot.position;
          run.task = proposal.task;
        } catch {
          // Do not publish uncommitted poses or continue after a failed/ambiguous DB call.
          run.task = Object.freeze({ ...run.task, phase: 'ERROR' });
          run.from = run.task.simulation.robot.position;
          run.error = '任务已停止：权限、布局或过账异常，请检查后台记录';
        }
      }
    } finally { this.advancing = false; }
  }
}
