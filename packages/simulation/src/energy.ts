import { findPath } from './astar.js';
import { applyCommand, step, type Cell } from './simulation.js';
import { navigationOf } from './navigation.js';
import type { FleetRobot, FleetState } from './fleet.js';

export const ENERGY_RESERVE = 20; // basis points, not a measurement from real hardware
export const LOADED_STEP_COST = 2;
export const CHARGE_PER_TICK = 250;
export const STALL_TICKS = 20;
const MAX_BATTERY = 10000;
const key = (p: Cell) => `${p.x}:${p.z}`;
export const working = (r: FleetRobot) => !!r.work && !['COMPLETED', 'ERROR'].includes(r.work.phase);
export const taskEnergy = (approach: number, delivery: number, charger: number) => approach + delivery * LOADED_STEP_COST + charger + ENERGY_RESERVE;
export function chargePath(state: FleetState, start: Cell, fallback: Cell | undefined) {
  const configured = state.resources?.filter((r) => r.kind === 'CHARGING') ?? [];
  // One fixed dock per group; try at most four nearest by Manhattan distance.
  const candidates = configured.length ? configured.map((r) => r.cells[0]!) : fallback ? [fallback] : [];
  const distance = (p: Cell) => Math.abs(p.x - start.x) + Math.abs(p.z - start.z);
  const map = state.robots[0]!.simulation.map, walls = new Set([...map.blocked, ...navigationOf(state).closed].map(key));
  const grid = { ...map, walkable: (p: Cell) => p.x >= 0 && p.z >= 0 && p.x < map.width && p.z < map.depth && !walls.has(key(p)) };
  return candidates.sort((a, b) => distance(a) - distance(b) || a.z - b.z || a.x - b.x).slice(0, 4)
    .map((dock) => findPath(grid, start, dock, { maxExpanded: 2000, timeoutMs: 10 }))
    .filter((r) => r.status === 'found').sort((a, b) => a.path.length - b.path.length)[0]?.path ?? null;
}

export function chargeCommand(state: FleetState, robotId: string, path: readonly Cell[] | null): FleetState {
  const r = state.robots.find((r) => r.id === robotId);
  if (!r) throw new Error('unknown robot');
  const s = r.simulation;
  let next: FleetRobot;
  if (!path) {
    if (!r.charge) throw new Error('no charge plan');
    next = { ...r, charge: null, simulation: { ...s, robot: { ...s.robot,
      path: [s.robot.position], next: 1, status: s.robot.battery ? 'IDLE' : 'DEPLETED' } } };
  } else {
    if (r.charge || working(r) || r.work?.phase === 'ERROR' || r.deviceFault || s.paused
      || s.robot.battery >= MAX_BATTERY || s.robot.battery < path.length - 1) throw new Error('charge plan unsafe or not needed');
    const simulation = path.length === 1 && s.robot.battery === 0
      ? { ...s, robot: { ...s.robot, path: [s.robot.position], next: 1 } }
      : applyCommand(s, { type: 'route', layoutId: s.map.layoutId, layoutVersion: s.map.version, path });
    next = { ...r, simulation, charge: { dock: { ...path.at(-1)! } } };
  }
  const result = { ...state, robots: state.robots.map((b) => b.id === robotId ? { ...next, waitTicks: 0, waitReason: null, blockerId: null, resourceWaitId: null } : b) };
  validateEnergy(result);
  return result;
}

export function validateEnergy(state: FleetState) {
  const closed = new Set(navigationOf(state).closed.map(key));
  for (const r of state.robots) if (r.charge) {
    const s = r.simulation, { dock } = r.charge, path = s.robot.path, atDock = key(s.robot.position) === key(dock);
    const configured = state.resources?.filter((p) => p.kind === 'CHARGING') ?? [];
    if (working(r) || r.work?.phase === 'ERROR' || r.deviceFault || s.paused ||
      s.robot.battery >= MAX_BATTERY || s.robot.battery < path.length - s.robot.next ||
      !path[s.robot.next - 1] || key(path[s.robot.next - 1]!) !== key(s.robot.position) ||
      (atDock ? s.robot.next !== path.length : s.robot.status !== 'MOVING' || s.robot.next >= path.length) ||
      key(path.at(-1)!) !== key(dock) || path.slice(s.robot.next).some((p) => closed.has(key(p))) ||
      (configured.length > 0 && !configured.some((p) => key(p.cells[0]!) === key(dock)))) throw new Error('invalid charging checkpoint');
  }
}

export function stepCharge(r: FleetRobot) {
  const s = r.simulation;
  if (key(s.robot.position) !== key(r.charge!.dock)) return { simulation: step(s), charge: r.charge };
  const battery = Math.min(MAX_BATTERY, s.robot.battery + CHARGE_PER_TICK);
  return { simulation: { ...s, robot: { ...s.robot, status: 'IDLE' as const, battery } }, charge: battery === MAX_BATTERY ? null : r.charge };
}

export function energyBlocked(r: FleetRobot) {
  const { robot } = r.simulation;
  if (r.work?.phase === 'LOADING') return robot.battery <= (r.work.transportPath.length - 1) * LOADED_STEP_COST;
  if (r.work?.phase === 'TRANSPORT') return robot.battery <= (robot.path.length - robot.next) * LOADED_STEP_COST;
  return false;
}

export type FleetAlert = { key: string; robotId: string; kind: 'DEVICE_FAULT' | 'ENERGY_LOW' | 'NO_PROGRESS' };
export function fleetAlerts(state: FleetState): FleetAlert[] {
  return state.robots.flatMap((r): FleetAlert[] => {
    const kind = r.deviceFault ? 'DEVICE_FAULT'
      : (working(r) && r.waitReason === 'ENERGY_LOW') ? 'ENERGY_LOW'
      : ((working(r) || r.charge) && r.waitTicks >= STALL_TICKS && r.waitReason) ? 'NO_PROGRESS' : null;
    if (!kind) return [];
    const identity = r.charge ? `charge:${key(r.charge.dock)}` : r.work?.taskId ?? 'idle';
    return [{ key: `${r.id}:${identity}:${kind}${r.deviceFault ? ':' + r.deviceFault.sinceTick : ''}`, robotId: r.id, kind }];
  });
}
