import { expect, it } from 'vitest';
import { assignFleetTask, createFleet, stepFleet } from './fleet.js';
import { chargeCommand, chargePath, fleetAlerts, taskEnergy } from './energy.js';
import { changeNavigation } from './navigation.js';
import { configureResources } from './resources.js';
const p = (x: number, z = 1) => ({ x, z });
const make = (battery = 100) => createFleet({ map: { layoutId: 'energy', version: 1, width: 8, depth: 5, blocked: [] }, seed: 42,
  robots: [{ id: 'a', position: p(0), battery }, { id: 'b', position: p(2), battery }, { id: 'c', position: p(7, 4) }] });

it('budgets approach, delivery, return and reserve; closures remove an otherwise reachable dock', () => {
  expect(taskEnergy(5, 13, 7)).toBe(58);
  expect(chargePath(make(), p(0), p(3))?.length).toBe(4);
  expect(chargePath(changeNavigation(make(), [p(3)], true, 0), p(0), p(3))).toBeNull();
  expect(() => chargeCommand(make(1), 'a', [p(0), p(1), p(1, 0)])).toThrow();
});

it('charges exactly one robot at the dock; a charged parked car retains the permit and a contender alerts once per wait', () => {
  let s = configureResources(make(9751), [{ id: 'dock', kind: 'CHARGING', cells: [p(1)] }]);
  s = chargeCommand(chargeCommand(s, 'a', [p(0), p(1)]), 'b', [p(2), p(1)]);
  s = stepFleet(s).state;
  expect(s.resources![0]!.ownerId).toBe('a'); expect(s.robots[0]!.simulation.robot.battery).toBe(9750);
  expect(s.robots[1]!.simulation.robot.battery).toBe(9751);
  s = stepFleet(s).state; expect(s.robots[0]!.simulation.robot.battery).toBe(10000);
  expect(s.robots[0]!.charge).toBeNull(); expect(s.resources![0]!.ownerId).toBe('a');
  for (let i = 2; i < 19; i++) s = stepFleet(s).state;
  expect(fleetAlerts(s)).toEqual([]);
  s = stepFleet(s).state;
  const alerts = fleetAlerts(s);
  expect(alerts.map((a) => a.kind)).toEqual(['NO_PROGRESS']);
  expect(fleetAlerts(stepFleet(s).state)).toEqual(alerts);
  expect(fleetAlerts(chargeCommand(s, 'b', null))).toEqual([]);
});

it('blocks closures across a live charge route until operator stops it at the current cell', () => {
  const s = chargeCommand(make(), 'a', [p(0), p(1), p(1, 0)]);
  expect(() => changeNavigation(s, [p(1)], true, 0)).toThrow();
  const stopped = chargeCommand(s, 'a', null);
  expect(changeNavigation(stopped, [p(1)], true, 0).navigation?.revision).toBe(1);
  expect(stopped.robots[0]!.simulation.robot.position).toEqual(p(0));
});

it('pauses a battery-starved loaded phase without position, cargo effects or assignment changes', () => {
  let s = assignFleetTask(make(), 'a', 'job', [p(0)], [p(0), p(0, 2), p(1, 2)]);
  while (s.robots[0]!.work!.phase !== 'TRANSPORT') s = stepFleet(s).state;
  expect(stepFleet(s).state.robots[0]!.simulation.robot.battery).toBe(98);
  s = { ...s, robots: s.robots.map((r, i) => i ? r : { ...r, simulation: { ...r.simulation, robot: { ...r.simulation.robot, battery: 2 } } }) };
  const first = stepFleet(s);
  expect(first.effects).toEqual([]); expect(first.state.robots[0]!.work).toEqual(s.robots[0]!.work);
  expect(first.state.robots[0]!.simulation.robot).toEqual(s.robots[0]!.simulation.robot);
  expect(fleetAlerts(first.state)[0]?.kind).toBe('ENERGY_LOW');
  expect(() => chargeCommand(first.state, 'a', [p(0)])).toThrow();
});

it('diagnoses a two-way edge wait without moving either robot or multiplying keys', () => {
  let s = assignFleetTask(make(), 'a', 'one', [p(0), p(1), p(2)], [p(2)]);
  s = assignFleetTask(s, 'b', 'two', [p(2), p(1), p(0)], [p(0)]);
  for (let i = 0; i < 25; i++) s = stepFleet(s).state;
  expect(s.robots.slice(0, 2).map((r) => r.waitReason)).toEqual(['EDGE_SWAP', 'EDGE_SWAP']);
  expect(fleetAlerts(s).map((a) => a.kind)).toEqual(['NO_PROGRESS', 'NO_PROGRESS']);
});
