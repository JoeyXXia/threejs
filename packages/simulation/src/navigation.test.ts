import { expect, it } from 'vitest';
import { assignFleetTask, createFleet, stepFleet, type FleetState } from './fleet.js';
import { changeNavigation, navigationOf, validateNavigation } from './navigation.js';
const p = (x: number, z = 1) => ({ x, z });
function initial() { return createFleet({ map: { layoutId: 'navigation', version: 1, width: 7, depth: 5, blocked: [] }, seed: 42,
  robots: [{ id: 'a', position: p(0), battery: 10000 }, { id: 'b', position: p(6, 3), battery: 10000 }, { id: 'c', position: p(6, 4), battery: 10000 }] }); }
const job = () => assignFleetTask(initial(), 'a', 'job', [p(0), p(1), p(2), p(3)], [p(3), p(4), p(5)]);
it('reroutes around a free closure without moving, changing task phase, battery, tick or assignment history', () => {
  const old = job(), before = JSON.stringify(old), next = changeNavigation(old, [p(2)], true, 0);
  expect(JSON.stringify(old)).toBe(before); expect(next.tick).toBe(old.tick); expect(next.assignments).toBe(old.assignments);
  expect(next.robots[0]!.simulation.robot.position).toEqual(p(0)); expect(next.robots[0]!.simulation.robot.battery).toBe(10000);
  expect(next.robots[0]!.simulation.robot.path.some((c) => c.x === 2 && c.z === 1)).toBe(false);
  let s = next;
  for (let i = 0; i < 30; i++) { s = stepFleet(s).state; expect(s.robots[0]!.simulation.robot.position).not.toEqual(p(2)); }
  expect(s.robots[0]!.work!.phase).toBe('COMPLETED');
});
it('rejects occupied cells, confirmed segment endpoints, invalid floors, stale revisions and new assignments through closures', () => {
  expect(() => changeNavigation(job(), [p(0)], true, 0)).toThrow();
  expect(() => changeNavigation(job(), [p(2)], true, 0, [p(2)])).toThrow();
  expect(() => changeNavigation(job(), [p(7)], true, 0)).toThrow();
  const s = changeNavigation(initial(), [p(2)], true, 0);
  expect(() => changeNavigation(s, [p(3)], true, 0)).toThrow();
  expect(() => assignFleetTask(s, 'a', 'new', [p(0), p(1), p(2)], [p(2), p(3)])).toThrow();
  expect(changeNavigation(s, [p(2)], true, 1)).toBe(s);
});
it('pauses honestly on a full cut, retains phase/cargo effects and resumes only by a new map revision', () => {
  let s = job();
  while (s.robots[0]!.work!.phase !== 'TRANSPORT') s = stepFleet(s).state;
  const before = s.robots[0]!, wall = Array.from({ length: 5 }, (_, z) => p(4, z));
  s = changeNavigation(s, wall, true, 0);
  expect(s.robots[0]).toMatchObject({ navigationIssue: { revision: 1, reason: 'NO_PATH' }, work: { phase: 'TRANSPORT' } });
  for (let i = 0; i < 15; i++) { const step = stepFleet(JSON.parse(JSON.stringify(s))); expect(step.effects).toEqual([]); s = step.state; }
  expect(s.robots[0]!.simulation.robot.position).toEqual(before.simulation.robot.position);
  expect(s.robots[0]!.simulation.robot.battery).toBe(before.simulation.robot.battery);
  expect(s.robots[0]!.waitReason).toBe('ROUTE_BLOCKED');
  s = changeNavigation(s, [p(4)], false, 1);
  expect(s.robots[0]!.navigationIssue).toBeNull(); expect(s.robots[0]!.simulation.paused).toBe(false);
  let drops = 0; for (let i = 0; i < 20; i++) { const step = stepFleet(s); drops += step.effects.filter((e) => e.stage === 'drop').length; s = step.state; }
  expect(drops).toBe(1); expect(s.robots[0]!.work!.phase).toBe('COMPLETED');
});
it('limits expansion rather than fabricating a straight route, with no automatic retry storm', () => {
  let s = changeNavigation(job(), [p(2)], true, 0, [], { maxExpanded: 0, timeoutMs: 10 });
  expect(s.robots[0]!.navigationIssue?.reason).toBe('BUDGET');
  const route = s.robots[0]!.simulation.robot.path;
  for (let i = 0; i < 20; i++) s = stepFleet(s).state;
  expect(s.robots[0]!.simulation.robot.path).toEqual(route); expect(navigationOf(s).revision).toBe(1);
  expect(s.robots[0]!.simulation.robot.position).toEqual(p(0));
});
it('keeps loading phase progress on failed future-leg planning, then posts take only once after reopening', () => {
  let s = job(); while (s.robots[0]!.work!.phase !== 'LOADING') s = stepFleet(s).state;
  s = stepFleet(s).state; const phaseTicks = s.robots[0]!.work!.phaseTicks;
  s = changeNavigation(s, [p(5)], true, 0); expect(s.robots[0]!.work!.phaseTicks).toBe(phaseTicks);
  expect(stepFleet(s).effects).toEqual([]);
  s = changeNavigation(s, [p(5)], false, 1);
  let takes = 0; for (let i = 0; i < 20; i++) { const step = stepFleet(s); takes += step.effects.filter((e) => e.stage === 'take').length; s = step.state; }
  expect(takes).toBe(1);
});
it('handles frequent map revisions without teleporting or accepting a corrupted old route', () => {
  let s = job(); const position = s.robots[0]!.simulation.robot.position;
  for (let i = 0; i < 10; i++) { s = changeNavigation(s, [p(2)], i % 2 === 0, i); validateNavigation(s); expect(s.robots[0]!.simulation.robot.position).toEqual(position); }
  const bad: FleetState = { ...job(), navigation: { revision: 1, closed: [p(2)] } };
  expect(() => stepFleet(bad)).toThrow('stale route');
});
