import { createFixedStepRunner, createSimulation, stateSummary } from '../packages/simulation/dist/index.js';

const map = { layoutId: 'day17-node', version: 1, width: 3, depth: 3, blocked: [] };
const runner = createFixedStepRunner(createSimulation({ map, seed: 42, position: { x: 0, z: 0 }, battery: 100 }));
runner.command({ type: 'route', layoutId: map.layoutId, layoutVersion: map.version,
  path: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }] });
const snapshot = () => {
  const state = runner.getState();
  return { tick: state.tick, logicalTimeMs: state.logicalTimeMs, paused: state.paused,
    position: state.robot.position, direction: state.robot.direction, status: state.robot.status,
    battery: state.robot.battery, summary: stateSummary(state) };
};
runner.advance(500);
const arrived = snapshot();
runner.command({ type: 'pause' });
runner.advance(10000);
const paused = snapshot();
runner.command({ type: 'resume' });
runner.advance(250);
console.log(JSON.stringify({ node: process.version, arrived, paused, resumed: snapshot() }, null, 2));
