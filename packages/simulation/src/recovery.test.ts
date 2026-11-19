import { expect, it } from 'vitest';
import { assignFleetTask, createFleet, stepFleet } from './fleet.js';
import { controlRobot } from './recovery.js';
import { changeNavigation } from './navigation.js';
import { configureResources } from './resources.js';
const p = (x: number, z = 1) => ({ x, z });
function job() {
  const s = createFleet({ map: { layoutId: 'recovery', version: 1, width: 8, depth: 5, blocked: [] }, seed: 42,
    robots: [{ id: 'a', position: p(0) }, { id: 'b', position: p(7, 3) }, { id: 'c', position: p(7, 4) }] });
  return assignFleetTask(configureResources(s, [{ id: 'park', kind: 'PARKING', cells: [p(0)] }]), 'a', 'job', [p(0), p(1), p(2)], [p(2), p(3), p(4), p(5)]);
}
for (const phase of ['APPROACH', 'LOADING', 'TRANSPORT', 'UNLOADING'] as const) it(`fault/repair preserves ${phase} progress, cargo-effect count and position`, () => {
  let s = job(), takes = 0, drops = 0;
  while (s.robots[0]!.work!.phase !== phase) { const result = stepFleet(s); takes += result.effects.filter((e) => e.stage === 'take').length; s = result.state; }
  const r = s.robots[0]!, old = JSON.stringify(s);
  s = controlRobot(s, 'a', 'FAULT', 'synthetic fault'); expect(JSON.stringify(r)).toBe(JSON.stringify(JSON.parse(old).robots[0]));
  for (let i = 0; i < 12; i++) { const result = stepFleet(JSON.parse(JSON.stringify(s))); expect(result.effects).toEqual([]); s = result.state; }
  expect(s.robots[0]!.work).toEqual(r.work); expect(s.robots[0]!.simulation.robot).toEqual(r.simulation.robot);
  expect(s.robots[0]!.waitReason).toBe('DEVICE_FAULT');
  s = controlRobot(s, 'a', 'REPAIR', 'inspected');
  for (let i = 0; i < 35; i++) { const result = stepFleet(s); takes += result.effects.filter((e) => e.stage === 'take').length; drops += result.effects.filter((e) => e.stage === 'drop').length; s = result.state; }
  expect(s.robots[0]!.work!.phase).toBe('COMPLETED'); expect(takes).toBe(1); expect(drops).toBe(1);
});
it('cancels only before pickup without erasing history, physical permits or a device fault', () => {
  let s = controlRobot(job(), 'a', 'FAULT', 'fault'); const history = s.assignments;
  s = controlRobot(s, 'a', 'CANCEL', 'cancel');
  expect(s.assignments).toBe(history); expect(s.robots[0]!.work).toBeNull(); expect(s.resources![0]!.ownerId).toBe('a');
  expect(() => assignFleetTask(s, 'a', 'other', [p(0), p(1)], [p(1), p(2)])).toThrow();
  s = controlRobot(s, 'a', 'REPAIR', 'checked'); expect(s.robots[0]!.deviceFault).toBeNull();
  s = job(); while (s.robots[0]!.work!.phase !== 'TRANSPORT') s = stepFleet(s).state;
  expect(() => controlRobot(s, 'a', 'CANCEL', 'unsafe')).toThrow();
});
it('map reopening cannot repair a fault; repair cannot clear a navigation pause or generic ERROR', () => {
  const unknownPause = job();
  expect(() => controlRobot({ ...unknownPause, robots: unknownPause.robots.map((r) => ({ ...r, simulation: { ...r.simulation, paused: true } })) }, 'a', 'FAULT', 'fault')).toThrow();
  let s = controlRobot(job(), 'a', 'FAULT', 'fault');
  s = changeNavigation(s, [p(5)], true, 0); expect(s.robots[0]!.navigationIssue).toBeTruthy();
  s = changeNavigation(s, [p(5)], false, 1); expect(s.robots[0]!.simulation.paused).toBe(true);
  expect(stepFleet(s).effects).toEqual([]);
  s = changeNavigation(s, [p(5)], true, 2); s = controlRobot(s, 'a', 'REPAIR', 'checked');
  expect(s.robots[0]!.simulation.paused).toBe(true); expect(s.robots[0]!.navigationIssue).toBeTruthy();
  const bad = { ...s, robots: s.robots.map((r, i) => i ? r : { ...r, deviceFault: { reason: 'fault', sinceTick: s.tick }, navigationIssue: null, work: { ...r.work!, phase: 'ERROR' as const } }) };
  expect(() => controlRobot(bad, 'a', 'REPAIR', 'checked')).toThrow();
});
