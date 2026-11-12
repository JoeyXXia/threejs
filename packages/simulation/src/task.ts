import { applyCommand, step, type Cell, type SimulationState } from './simulation.js';

export type TransportPhase = 'APPROACH' | 'LOADING' | 'TRANSPORT' | 'UNLOADING' | 'COMPLETED' | 'ERROR';
export type RobotTask = Readonly<{
  simulation: SimulationState; phase: TransportPhase; phaseTicks: number;
  transportPath: readonly Cell[]; error: string | null;
}>;

export function createRobotTask(simulation: SimulationState, approachPath: readonly Cell[], transportPath: readonly Cell[]): RobotTask {
  // Validate both segments up front, including their shared pickup endpoint.
  const approach = applyCommand(simulation, { type: 'route', layoutId: simulation.map.layoutId,
    layoutVersion: simulation.map.version, path: approachPath });
  const endpoint = approachPath[approachPath.length - 1]!;
  applyCommand({ ...simulation, robot: { ...simulation.robot, position: endpoint } }, {
    type: 'route', layoutId: simulation.map.layoutId, layoutVersion: simulation.map.version, path: transportPath,
  });
  const path = Object.freeze(transportPath.map((p) => Object.freeze({ ...p })));
  return Object.freeze({ simulation: approach, phase: 'APPROACH', phaseTicks: 0, transportPath: path, error: null });
}

// Effects are proposals. The caller commits the ledger effect before publishing the returned state.
export function stepRobotTask(task: RobotTask): { task: RobotTask; effect: 'take' | 'drop' | null } {
  if (task.phase === 'COMPLETED' || task.phase === 'ERROR' || task.simulation.paused) return { task, effect: null };
  let simulation = step(task.simulation);
  let phase: TransportPhase = task.phase;
  let phaseTicks = task.phaseTicks + 1;
  let effect: 'take' | 'drop' | null = null;
  if (simulation.robot.status === 'DEPLETED') {
    return { task: Object.freeze({ ...task, simulation, phase: 'ERROR', error: '电量耗尽，任务已停止' }), effect: null };
  }
  if (phase === 'APPROACH' && simulation.robot.status === 'IDLE') { phase = 'LOADING'; phaseTicks = 0; }
  else if (phase === 'TRANSPORT' && simulation.robot.status === 'IDLE') { phase = 'UNLOADING'; phaseTicks = 0; }
  else if (phase === 'LOADING' && phaseTicks >= 4) {
    effect = 'take'; phase = 'TRANSPORT'; phaseTicks = 0;
    simulation = applyCommand(simulation, { type: 'route', layoutId: simulation.map.layoutId,
      layoutVersion: simulation.map.version, path: task.transportPath });
  } else if (phase === 'UNLOADING' && phaseTicks >= 4) { effect = 'drop'; phase = 'COMPLETED'; phaseTicks = 0; }
  return { task: Object.freeze({ ...task, simulation, phase, phaseTicks }), effect };
}
