import { findPath } from './astar.js';
import { applyCommand, type Cell } from './simulation.js';
import type { FleetState, FleetRobot } from './fleet.js';

export type Navigation = Readonly<{ revision: number; closed: readonly Cell[] }>;
export type NavigationIssue = Readonly<{ revision: number; reason: 'NO_PATH' | 'BUDGET' }>;
const key = (p: Cell) => `${p.x}:${p.z}`;
export const navigationOf = (s: FleetState): Navigation => s.navigation ?? { revision: 0, closed: [] };
const running = (r: FleetRobot) => r.work && !['COMPLETED', 'ERROR'].includes(r.work.phase);

export function validateNavigation(state: FleetState) {
  const nav = navigationOf(state), map = state.robots[0]!.simulation.map, closed = new Set(nav.closed.map(key));
  if (!Number.isSafeInteger(nav.revision) || nav.revision < 0 || nav.closed.length > 256 || closed.size !== nav.closed.length) throw new Error('navigation revision/cells');
  for (const p of nav.closed) if (!Number.isInteger(p.x) || !Number.isInteger(p.z) || p.x < 0 || p.z < 0 || p.x >= map.width || p.z >= map.depth
    || map.blocked.some((b) => key(b) === key(p)) || state.robots.some((r) => key(r.simulation.robot.position) === key(p))) throw new Error('invalid occupied closure');
  for (const r of state.robots) {
    if (r.navigationIssue && (r.navigationIssue.revision !== nav.revision || !r.simulation.paused || !running(r))) throw new Error('invalid navigation pause');
    if (!running(r) || r.navigationIssue) continue;
    const paths = [r.simulation.robot.path.slice(Math.max(0, r.simulation.robot.next - 1)), ...(['APPROACH', 'LOADING'].includes(r.work!.phase) ? [r.work!.transportPath] : [])];
    if (paths.some((path) => path.some((p) => closed.has(key(p))))) throw new Error('stale route crosses closure');
  }
}

// At most five robots × two searches; each search has a node AND wall-clock budget.
// No movements or inventory effects are applied by changing the map.
export function changeNavigation(state: FleetState, cells: readonly Cell[], close: boolean, expectedRevision: number,
  protectedCells: readonly Cell[] = [], options: { maxExpanded?: number; timeoutMs?: number } = {}): FleetState {
  validateNavigation(state);
  const old = navigationOf(state), map = state.robots[0]!.simulation.map;
  if (old.revision !== expectedRevision || old.revision >= Number.MAX_SAFE_INTEGER || !cells.length || cells.length > 128) throw new Error('stale navigation command');
  const desired = new Map(old.closed.map((p) => [key(p), p]));
  for (const p of cells) {
    if (!Number.isInteger(p.x) || !Number.isInteger(p.z) || p.x < 0 || p.z < 0 || p.x >= map.width || p.z >= map.depth || map.blocked.some((b) => key(b) === key(p))) throw new Error('closure is not a floor cell');
    if (close && (protectedCells.some((b) => key(b) === key(p)) || state.robots.some((r) => key(r.simulation.robot.position) === key(p)))) throw new Error('occupied or approved segment');
    if (close) desired.set(key(p), { ...p }); else desired.delete(key(p));
  }
  if (desired.size > 256) throw new Error('closure count limit');
  const closed = [...desired.values()].sort((a, b) => a.z - b.z || a.x - b.x);
  if (JSON.stringify([...old.closed].sort((a, b) => a.z - b.z || a.x - b.x)) === JSON.stringify(closed)) return state;
  const navigation = { revision: old.revision + 1, closed }, walls = new Set([...map.blocked, ...closed].map(key));
  const grid = { ...map, version: navigation.revision, walkable: (p: Cell) => p.x >= 0 && p.z >= 0 && p.x < map.width && p.z < map.depth && !walls.has(key(p)) };
  const budget = { maxExpanded: options.maxExpanded ?? 2000, timeoutMs: options.timeoutMs ?? 10 };
  const robots = state.robots.map((r): FleetRobot => {
    if (!running(r)) return r;
    const phase = r.work!.phase, future = r.simulation.robot.path.slice(Math.max(0, r.simulation.robot.next - 1));
    const affected = !!r.navigationIssue || [...future, ...(['APPROACH', 'LOADING'].includes(phase) ? r.work!.transportPath : [])].some((p) => walls.has(key(p)));
    if (!affected) return r;
    const current = r.simulation.robot.position, pickup = r.work!.transportPath[0]!, drop = r.work!.transportPath.at(-1)!;
    const a = findPath(grid, current, phase === 'APPROACH' ? pickup : phase === 'TRANSPORT' ? drop : current, budget);
    const b = ['APPROACH', 'LOADING'].includes(phase) ? findPath(grid, pickup, drop, budget) : null;
    const failed = [a, b].find((result) => result && result.status !== 'found');
    if (failed) return { ...r, simulation: { ...r.simulation, paused: true }, navigationIssue: { revision: navigation.revision,
      reason: ['node-limit', 'time-limit'].includes(failed.status) ? 'BUDGET' : 'NO_PATH' }, waitReason: 'ROUTE_BLOCKED', blockerId: null, resourceWaitId: null };
    const simulation = applyCommand({ ...r.simulation, paused: r.navigationIssue ? false : r.simulation.paused,
      robot: { ...r.simulation.robot, status: 'IDLE' } }, { type: 'route', layoutId: map.layoutId, layoutVersion: map.version, path: a.path });
    return { ...r, simulation, work: { ...r.work!, transportPath: b?.path ?? (phase === 'TRANSPORT' ? a.path : r.work!.transportPath) },
      navigationIssue: null, waitTicks: 0, waitReason: null, blockerId: null, resourceWaitId: null };
  });
  const result = { ...state, navigation, robots };
  validateNavigation(result);
  return result;
}
