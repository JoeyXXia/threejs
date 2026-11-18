import { expect, it } from 'vitest';
import { assignFleetTask, createFleet, stepFleet, type FleetState } from './fleet.js';
import { configureResources, validateResources, type ResourceDefinition } from './resources.js';
const p = (x: number, z = 1) => ({ x, z });
const initial = () => createFleet({ map: { layoutId: 'resource-test', version: 1, width: 7, depth: 5, blocked: [p(6, 4)] }, seed: 42,
  robots: [{ id: 'a', position: p(0) }, { id: 'b', position: p(4) }, { id: 'c', position: p(6, 3) }] });
const corridor: ResourceDefinition = { id: 'aisle', kind: 'AISLE', cells: [p(1), p(2), p(3)] };
const busy = () => {
  let s = configureResources(initial(), [corridor]);
  s = assignFleetTask(s, 'a', 'job-a', [p(0), p(1), p(2), p(3), p(3, 2)], [p(3, 2), p(4, 2)]);
  return assignFleetTask(s, 'b', 'job-b', [p(4), p(3), p(2), p(1), p(1, 2)], [p(1, 2), p(0, 2)]);
};
it('grants one corridor before entry even for different empty target cells, then releases only after exit', () => {
  let s = stepFleet(busy()).state;
  expect(s.resources![0]!.ownerId).toBe('a');
  expect(s.robots[1]).toMatchObject({ waitReason: 'RESOURCE_BUSY', resourceWaitId: 'aisle', blockerId: 'a', waitTicks: 1 });
  for (let i = 0; i < 2; i++) { s = stepFleet(s).state; expect(s.resources![0]!.ownerId).toBe('a'); }
  s = stepFleet(s).state; expect(s.resources![0]!.ownerId).toBeNull();
  expect(s.robots[1]!.waitReason).toBe('RESOURCE_BUSY'); // prior tick owner still guarded entry
  s = stepFleet(s).state; expect(s.resources![0]!.ownerId).toBe('b');
  expect(s.robots[0]!.simulation.robot.position).toEqual(p(3, 2));
});
it('retains idle and ERROR occupancy through arbitrary ticks and JSON restart, with no lease timeout escape', () => {
  const parked = configureResources(initial(), [{ id: 'park', kind: 'PARKING', cells: [p(0), p(1)] }]);
  let s = assignFleetTask(parked, 'b', 'job-b', [p(4), p(3), p(2), p(1)], [p(1), p(1, 2)]);
  for (let i = 0; i < 30; i++) s = stepFleet(JSON.parse(JSON.stringify(s))).state;
  expect(s.resources![0]!.ownerId).toBe('a'); expect(s.robots[1]!.waitReason).toBe('RESOURCE_BUSY');
  let fault = stepFleet(busy()).state;
  fault = { ...fault, robots: fault.robots.map((r) => r.id === 'a' ? { ...r, work: { ...r.work!, phase: 'ERROR', error: 'fixture fault' } } : r) };
  for (let i = 0; i < 30; i++) fault = stepFleet(JSON.parse(JSON.stringify(fault))).state;
  expect(fault.resources![0]!.ownerId).toBe('a'); expect(fault.robots[0]!.simulation.robot.position).toEqual(p(1));
  expect(fault.robots[1]!.waitTicks).toBe(31);
});
it('uses waiting and priority ordering without granting through another occupied group', () => {
  const state = busy();
  const aged: FleetState = { ...state, robots: state.robots.map((r) => r.id === 'b' ? { ...r, waitTicks: 10, totalWaitTicks: 10 } : r) };
  expect(stepFleet(aged).state.resources![0]!.ownerId).toBe('b');
  const priority = { ...aged, robots: aged.robots.map((r) => r.id === 'a' ? { ...r, priority: 1 } : r) };
  expect(stepFleet(priority).state.resources![0]!.ownerId).toBe('a');
});
it('validates all four kinds, connected walkable disjoint bounded cells and existing single occupancy', () => {
  for (const kind of ['AISLE', 'PARKING', 'CHARGING', 'WORKSTATION'] as const) expect(configureResources(initial(), [{ ...corridor, kind }]).resources![0]!.kind).toBe(kind);
  for (const cells of [[], [p(1), p(1)], [p(1), p(3)], [p(6, 4)], [p(7)], [p(.5)]]) expect(() => configureResources(initial(), [{ ...corridor, cells }])).toThrow();
  expect(() => configureResources(initial(), [corridor, { ...corridor, id: 'other' }])).toThrow();
  expect(() => configureResources(initial(), [{ ...corridor, cells: [p(0), p(1), p(2), p(3), p(4)] }])).toThrow();
});
it('rejects ghost or missing permits, immutable reconfiguration and active-work first configuration', () => {
  const s = configureResources(initial(), [corridor]);
  expect(configureResources(s, [{ ...corridor, cells: [...corridor.cells].reverse() }])).toBe(s);
  expect(() => configureResources(s, [{ ...corridor, id: 'replacement' }])).toThrow();
  expect(() => configureResources(assignFleetTask(initial(), 'a', 'j', [p(0), p(1)], [p(1), p(2)]), [corridor])).toThrow();
  expect(() => validateResources({ ...s, resources: [{ ...s.resources![0]!, ownerId: 'a' }] })).toThrow();
  const owned = configureResources(initial(), [{ ...corridor, cells: [p(0)] }]);
  expect(() => validateResources({ ...owned, resources: [{ ...owned.resources![0]!, ownerId: null }] })).toThrow();
});
it('keeps one-cell endpoint/parking occupancy after completion and preserves input proposal immutability', () => {
  let s = configureResources(initial(), [{ id: 'station', kind: 'WORKSTATION', cells: [p(1)] }]);
  s = assignFleetTask(s, 'a', 'job', [p(0)], [p(0), p(1)]);
  const before = JSON.stringify(s); stepFleet(s); expect(JSON.stringify(s)).toBe(before);
  for (let i = 0; i < 20; i++) s = stepFleet(s).state;
  expect(s.robots[0]!.work!.phase).toBe('COMPLETED'); expect(s.resources![0]!.ownerId).toBe('a');
});
