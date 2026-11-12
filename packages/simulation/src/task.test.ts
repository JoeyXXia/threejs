import { expect, it } from 'vitest';
import { createSimulation } from './simulation.js';
import { createRobotTask, stepRobotTask } from './task.js';

const map = { layoutId: 'fixture', version: 1, width: 5, depth: 2, blocked: [] };
const approach = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
const transport = [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }];
const make = () => createRobotTask(createSimulation({ map, seed: 42, position: approach[0]!, battery: 100 }), approach, transport);

it('proposes take/drop once after four loading/unloading ticks and stops at completion', () => {
  let task = make();
  const phases = [task.phase];
  const effects: string[] = [];
  for (let i = 0; i < 30; i++) {
    const result = stepRobotTask(task);
    task = result.task;
    if (phases.at(-1) !== task.phase) phases.push(task.phase);
    if (result.effect) effects.push(result.effect);
  }
  expect(phases).toEqual(['APPROACH', 'LOADING', 'TRANSPORT', 'UNLOADING', 'COMPLETED']);
  expect(effects).toEqual(['take', 'drop']);
  expect(task.simulation).toMatchObject({ tick: 11, logicalTimeMs: 2750, robot: { position: transport[2], battery: 97 } });
  expect(stepRobotTask(task).task).toBe(task);
});

it('replays the same task and preserves the old state until the proposed ledger effect commits', () => {
  const replay = () => {
    let task = make();
    for (let i = 0; i < 5; i++) task = stepRobotTask(task).task;
    return task;
  };
  expect(replay()).toEqual(replay());
  let task = make();
  for (let i = 0; i < 4; i++) task = stepRobotTask(task).task;
  const before = JSON.stringify(task);
  expect(stepRobotTask(task).effect).toBe('take');
  expect(JSON.stringify(task)).toBe(before);
});

it('rejects disconnected transport segments and never advances paused or failed tasks', () => {
  const sim = createSimulation({ map, seed: 0, position: approach[0]! });
  expect(() => createRobotTask(sim, approach, [{ x: 4, z: 0 }])).toThrow();
  const task = make();
  const paused = { ...task, simulation: { ...task.simulation, paused: true } };
  expect(stepRobotTask(paused).task).toBe(paused);
  const depleted = { ...task, simulation: { ...task.simulation, robot: { ...task.simulation.robot, battery: 1 } } };
  const failed = stepRobotTask(depleted);
  expect(failed.effect).toBeNull();
  expect(failed.task.phase).toBe('ERROR');
  expect(stepRobotTask(failed.task).task).toBe(failed.task);
});
