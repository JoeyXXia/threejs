import type { Cell } from './simulation.js';
import type { FleetState, MoveDecision, MoveProposal } from './fleet.js';

export type ResourceDefinition = Readonly<{ id: string; kind: 'AISLE' | 'PARKING' | 'CHARGING' | 'WORKSTATION'; cells: readonly Cell[] }>;
export type FleetResource = ResourceDefinition & Readonly<{ ownerId: string | null }>;
const key = (p: Cell) => `${p.x}:${p.z}`;
const inside = (r: ResourceDefinition, p: Cell) => r.cells.some((c) => c.x === p.x && c.z === p.z);
const order = (a: MoveProposal, b: MoveProposal) => b.priority - a.priority || b.waitTicks - a.waitTicks || (a.robotId < b.robotId ? -1 : 1);

// Permits describe physical occupancy, not a process lease. Never expire them by wall-clock time.
export function validateResources(state: FleetState): void {
  const ids = new Set<string>(), cells = new Set<string>(), map = state.robots[0]!.simulation.map;
  if ((state.resources?.length ?? 0) > 32) throw new RangeError('resource count');
  for (const r of state.resources ?? []) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(r.id) || ids.has(r.id) || !['AISLE', 'PARKING', 'CHARGING', 'WORKSTATION'].includes(r.kind)
      || !r.cells.length || r.cells.length > 128) throw new RangeError('resource definition');
    ids.add(r.id);
    for (const c of r.cells) {
      if (!Number.isInteger(c.x) || !Number.isInteger(c.z) || c.x < 0 || c.z < 0 || c.x >= map.width || c.z >= map.depth
        || cells.has(key(c)) || map.blocked.some((b) => key(b) === key(c))) throw new RangeError('resource cells overlap or are unwalkable');
      cells.add(key(c));
    }
    const group = new Set(r.cells.map(key)), reached = new Set([key(r.cells[0]!)]), queue = [r.cells[0]!];
    for (let i = 0; i < queue.length; i++) { const p = queue[i]!;
      for (const c of [{ x: p.x + 1, z: p.z }, { x: p.x - 1, z: p.z }, { x: p.x, z: p.z + 1 }, { x: p.x, z: p.z - 1 }])
        if (group.has(key(c)) && !reached.has(key(c))) { reached.add(key(c)); queue.push(c); }
    }
    if (reached.size !== r.cells.length) throw new RangeError('resource must be connected');
    const occupants = state.robots.filter((b) => inside(r, b.simulation.robot.position));
    if (occupants.length > 1 || (occupants[0]?.id ?? null) !== r.ownerId) throw new Error('resource permit disagrees with physical occupancy');
  }
}
export function configureResources(state: FleetState, definitions: readonly ResourceDefinition[]): FleetState {
  const resources = [...definitions].map((r): FleetResource => ({ id: r.id, kind: r.kind,
    cells: [...r.cells].sort((a, b) => a.z - b.z || a.x - b.x).map((p) => ({ ...p })),
    ownerId: state.robots.find((b) => inside(r, b.simulation.robot.position))?.id ?? null })).sort((a, b) => a.id < b.id ? -1 : 1);
  const result = { ...state, resources };
  validateResources(result);
  if (state.resources?.length) {
    if (JSON.stringify(state.resources) !== JSON.stringify(resources)) throw new Error('resource configuration is immutable');
    return state;
  }
  if (!resources.length || state.robots.some((r) => r.work && !['COMPLETED', 'ERROR'].includes(r.work.phase))) throw new Error('configure a nonempty resource set before active work');
  return result;
}

export function coordinateResources(state: FleetState, proposals: readonly MoveProposal[], decisions: readonly MoveDecision[]): readonly MoveDecision[] {
  validateResources(state);
  const granted = new Map((state.resources ?? []).map((r) => [r.id, r.ownerId]));
  const byId = new Map(decisions.map((d) => [d.robotId, d]));
  for (const p of [...proposals].sort(order)) {
    if (!byId.get(p.robotId)!.allowed) continue;
    const target = state.resources?.find((r) => inside(r, p.to));
    if (!target) continue;
    const owner = granted.get(target.id);
    if (owner && owner !== p.robotId) byId.set(p.robotId, { robotId: p.robotId, allowed: false, reason: 'RESOURCE_BUSY', blockerId: owner, resourceId: target.id });
    else granted.set(target.id, p.robotId);
  }
  return decisions.map((d) => byId.get(d.robotId)!);
}
export function settledResources(state: FleetState): readonly FleetResource[] {
  return (state.resources ?? []).map((r) => ({ ...r, ownerId: state.robots.find((b) => inside(r, b.simulation.robot.position))?.id ?? null }));
}
