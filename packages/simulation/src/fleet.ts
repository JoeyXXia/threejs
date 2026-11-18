import { createSimulation, type Cell, type SimulationMap, type SimulationState } from './simulation.js';
import { createRobotTask, stepRobotTask, type RobotTask } from './task.js';
import { coordinateResources, settledResources, type FleetResource } from './resources.js';
import { validateNavigation, type Navigation, type NavigationIssue } from './navigation.js';

export type WaitReason = 'OCCUPIED' | 'EDGE_SWAP' | 'TARGET_CONFLICT' | 'RESOURCE_BUSY' | 'ROUTE_BLOCKED';
export type MoveProposal = Readonly<{ robotId: string; from: Cell; to: Cell; priority: number; waitTicks: number }>;
export type MoveDecision = Readonly<{ robotId: string; allowed: boolean; reason: WaitReason | null; blockerId: string | null; resourceId?: string | null }>;
export type FleetWork = Readonly<Omit<RobotTask, 'simulation'> & { taskId: string }>;
export type FleetRobot = Readonly<{ id: string; simulation: SimulationState; work: FleetWork | null;
  priority: number; waitTicks: number; totalWaitTicks: number; waitReason: WaitReason | null; blockerId: string | null; resourceWaitId?: string | null | undefined; navigationIssue?: NavigationIssue | null | undefined }>;
type Assignment = Readonly<{ taskId: string; robotId: string; approach: readonly Cell[]; transport: readonly Cell[] }>;
export type FleetState = Readonly<{ schemaVersion: 1; tick: number; robots: readonly FleetRobot[]; assignments: readonly Assignment[]; resources?: readonly FleetResource[] | undefined; navigation?: Navigation | undefined }>;
export type FleetEffect = Readonly<{ robotId: string; taskId: string; stage: 'take' | 'drop'; proposalKey: string }>;

const equal = (a: Cell, b: Cell) => a.x === b.x && a.z === b.z;
const key = (p: Cell) => `${p.x}:${p.z}`;
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const integer = (n: number, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= maximum;
function identity(value: string) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new RangeError('fleet identity'); }
function cell(p: Cell) { if (!integer(p.x, 511) || !integer(p.z, 511)) throw new RangeError('fleet cell'); }

// All occupants must be included, even parked, paused, failed or completed robots.
// Conservative rule: a cell occupied at the beginning of a tick is never reusable in that tick.
export function coordinateMoves(proposals: readonly MoveProposal[]): readonly MoveDecision[] {
  if (!proposals.length || proposals.length > 5) throw new RangeError('one to five proposals required');
  const ids = new Map<string, MoveProposal>(), occupied = new Map<string, MoveProposal>();
  for (const p of proposals) {
    identity(p.robotId); cell(p.from); cell(p.to);
    if (!integer(p.priority, 1000) || !integer(p.waitTicks) || ids.has(p.robotId) || occupied.has(key(p.from))
      || Math.abs(p.from.x - p.to.x) + Math.abs(p.from.z - p.to.z) > 1) throw new RangeError('invalid or overlapping proposals');
    ids.set(p.robotId, p); occupied.set(key(p.from), p);
  }
  const reserved = new Map<string, string>(), result: MoveDecision[] = [];
  const ordered = [...proposals].sort((a, b) => b.priority - a.priority || b.waitTicks - a.waitTicks || compareId(a.robotId, b.robotId));
  for (const p of ordered) {
    let reason: WaitReason | null = null, blockerId: string | null = null;
    if (!equal(p.from, p.to)) {
      const occupant = occupied.get(key(p.to));
      if (occupant) {
        reason = equal(occupant.to, p.from) ? 'EDGE_SWAP' : 'OCCUPIED'; blockerId = occupant.robotId;
      } else if (reserved.has(key(p.to))) { reason = 'TARGET_CONFLICT'; blockerId = reserved.get(key(p.to))!; }
      else reserved.set(key(p.to), p.robotId);
    }
    result.push(Object.freeze({ robotId: p.robotId, allowed: reason === null, reason, blockerId }));
  }
  return Object.freeze(result.sort((a, b) => compareId(a.robotId, b.robotId)));
}

export function createFleet(input: { map: SimulationMap; seed: number;
  robots: readonly { id: string; position: Cell; priority?: number; battery?: number }[] }): FleetState {
  if (input.robots.length < 3 || input.robots.length > 5 || !integer(input.seed, 0xffffffff)) throw new RangeError('three to five robots and uint32 seed required');
  const robots = [...input.robots].sort((a, b) => compareId(a.id, b.id)).map((r, index): FleetRobot => Object.freeze({
    id: r.id, simulation: createSimulation({ map: input.map, seed: (input.seed + index) >>> 0,
      position: r.position, robotId: r.id, ...(r.battery === undefined ? {} : { battery: r.battery }) }),
    priority: r.priority ?? 0, work: null, waitTicks: 0, totalWaitTicks: 0, waitReason: null, blockerId: null,
  }));
  coordinateMoves(robots.map((r) => ({ robotId: r.id, from: r.simulation.robot.position, to: r.simulation.robot.position, priority: r.priority, waitTicks: 0 })));
  return Object.freeze({ schemaVersion: 1, tick: 0, robots: Object.freeze(robots), assignments: Object.freeze([]) });
}

const copied = (path: readonly Cell[]) => Object.freeze(path.map((p) => Object.freeze({ ...p })));
const samePath = (a: readonly Cell[], b: readonly Cell[]) => a.length === b.length && a.every((p, i) => equal(p, b[i]!));
function work(taskId: string, task: RobotTask): FleetWork {
  return Object.freeze({ taskId, phase: task.phase, phaseTicks: task.phaseTicks, transportPath: task.transportPath, error: task.error });
}

// Pure assignment proposal, not a database claim. The persistence adapter commits it under the warehouse fence.
export function assignFleetTask(state: FleetState, robotId: string, taskId: string,
  approach: readonly Cell[], transport: readonly Cell[]): FleetState {
  identity(robotId); identity(taskId);
  const assigned = state.assignments.find((a) => a.taskId === taskId);
  if (assigned) {
    if (assigned.robotId !== robotId || !samePath(assigned.approach, approach) || !samePath(assigned.transport, transport)) throw new Error('task already assigned with different parameters');
    return state;
  }
  if (state.assignments.length >= 10000) throw new RangeError('assignment history limit');
  const robot = state.robots.find((r) => r.id === robotId);
  if (!robot) throw new Error('unknown robot');
  if (robot.work && robot.work.phase !== 'COMPLETED') throw new Error('robot has an active or failed task');
  const task = createRobotTask(robot.simulation, approach, transport);
  const assignment = Object.freeze({ taskId, robotId, approach: copied(approach), transport: copied(transport) });
  const result = Object.freeze({ ...state, assignments: Object.freeze([...state.assignments, assignment]),
    robots: Object.freeze(state.robots.map((r) => r.id === robotId ? Object.freeze({ ...r, simulation: task.simulation,
      work: work(taskId, task), waitTicks: 0, waitReason: null, blockerId: null, resourceWaitId: null, navigationIssue: null }) : r)) });
  validateNavigation(result);
  return result;
}

function clock(state: SimulationState, tick: number): SimulationState {
  return Object.freeze({ ...state, tick, logicalTimeMs: tick * state.tickMs });
}

// One atomic batch proposal. No callback writes inventory; effects must share the eventual DB transaction.
export function stepFleet(state: FleetState): Readonly<{ state: FleetState; effects: readonly FleetEffect[]; decisions: readonly MoveDecision[] }> {
  if (state.schemaVersion !== 1 || state.robots.length < 3 || state.robots.length > 5 || !integer(state.tick, Math.floor(Number.MAX_SAFE_INTEGER / 1000) - 1)) throw new RangeError('fleet checkpoint');
  const taskIds = new Set<string>(), assignments = new Map<string, string>();
  for (const a of state.assignments) {
    if (assignments.has(a.taskId)) throw new Error('duplicate assignment');
    assignments.set(a.taskId, a.robotId);
  }
  const reference = state.robots[0]!.simulation;
  validateNavigation(state);
  const proposals = state.robots.map((r) => {
    const s = r.simulation;
    if (s.robot.id !== r.id || s.tick !== state.tick || s.logicalTimeMs !== state.tick * s.tickMs
      || s.tickMs !== reference.tickMs || s.map.layoutId !== reference.map.layoutId || s.map.version !== reference.map.version
      || !integer(r.totalWaitTicks) || !integer(r.waitTicks)) throw new Error('mixed fleet checkpoint');
    if (r.work) {
      if (taskIds.has(r.work.taskId) || assignments.get(r.work.taskId) !== r.id) throw new Error('task owned by multiple or different robots');
      taskIds.add(r.work.taskId);
    }
    return r.work ? stepRobotTask({ ...r.work, simulation: s }) : { task: null, effect: null };
  });
  const moves = state.robots.map((r, i) => ({ robotId: r.id, from: r.simulation.robot.position,
    to: proposals[i]!.task?.simulation.robot.position ?? r.simulation.robot.position, priority: r.priority, waitTicks: r.waitTicks }));
  // Remove unpermitted targets before vertex arbitration: an outside waiter must not
  // win a target against the existing physical owner and stall its exit forever.
  const permits = coordinateResources(state, moves, moves.map((p) => ({ robotId: p.robotId, allowed: true, reason: null, blockerId: null })));
  const permitById = new Map(permits.map((d) => [d.robotId, d]));
  const physical = coordinateMoves(moves.map((p) => permitById.get(p.robotId)!.allowed ? p : { ...p, to: p.from }));
  const decisions = physical.map((d) => permitById.get(d.robotId)!.allowed ? d : permitById.get(d.robotId)!);
  const byId = new Map(decisions.map((d) => [d.robotId, d])), tick = state.tick + 1, effects: FleetEffect[] = [];
  const robots = state.robots.map((r, i): FleetRobot => {
    const decision = byId.get(r.id)!, proposal = proposals[i]!;
    if (!decision.allowed || r.navigationIssue) {
      if (!integer(r.waitTicks + 1) || !integer(r.totalWaitTicks + 1)) throw new RangeError('wait counter overflow');
      return Object.freeze({ ...r, simulation: clock(r.simulation, tick), waitTicks: r.waitTicks + 1,
        totalWaitTicks: r.totalWaitTicks + 1, waitReason: r.navigationIssue ? 'ROUTE_BLOCKED' : decision.reason, blockerId: decision.blockerId, resourceWaitId: decision.resourceId ?? null });
    }
    if (proposal.effect) effects.push(Object.freeze({ robotId: r.id, taskId: r.work!.taskId,
      stage: proposal.effect, proposalKey: `fleet:${r.work!.taskId}:${proposal.effect}` }));
    return Object.freeze({ ...r, simulation: clock(proposal.task?.simulation ?? r.simulation, tick),
      work: proposal.task ? work(r.work!.taskId, proposal.task) : null, waitTicks: 0, waitReason: null, blockerId: null, resourceWaitId: null });
  });
  const next = { ...state, tick, robots: Object.freeze(robots) };
  return Object.freeze({ state: Object.freeze({ ...next, ...(state.resources ? { resources: settledResources(next) } : {}) }),
    effects: Object.freeze(effects), decisions });
}
