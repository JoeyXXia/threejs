// Pure coordination evidence only: no DB, HTTP runner, UI, dispatch or production claim.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createFleet, assignFleetTask, stepFleet } from '../packages/simulation/dist/index.js';

const p = (x, z) => ({ x, z });
const map = { layoutId: 'T08-core-6x6', version: 1, width: 6, depth: 6, blocked: [] };
function run(name, count, headOn = false) {
  const parks = [p(5, 5), p(5, 4), p(4, 5)];
  let state = createFleet({ map, seed: 42, robots: [
    { id: 'a', position: headOn ? p(0, 0) : p(0, 1), battery: 10000 },
    { id: 'b', position: p(1, 0), battery: 10000 },
    ...parks.slice(0, count - 2).map((position, i) => ({ id: `park-${i}`, position, battery: 10000 })),
  ] });
  state = headOn
    ? assignFleetTask(state, 'a', 'job-a', [p(0, 0), p(1, 0)], [p(1, 0), p(2, 0)])
    : assignFleetTask(state, 'a', 'job-a', [p(0, 1), p(1, 1), p(2, 1)], [p(2, 1), p(3, 1)]);
  state = headOn
    ? assignFleetTask(state, 'b', 'job-b', [p(1, 0), p(0, 0)], [p(0, 0), p(0, 1)])
    : assignFleetTask(state, 'b', 'job-b', [p(1, 0), p(1, 1), p(1, 2)], [p(1, 2), p(1, 3)]);
  const effects = [], waits = [];
  for (let i = 0; i < 100; i++) {
    const result = stepFleet(state), after = result.state;
    assert.equal(new Set(after.robots.map((r) => JSON.stringify(r.simulation.robot.position))).size, count);
    for (const robot of after.robots) {
      const old = state.robots.find((r) => r.id === robot.id);
      const moved = JSON.stringify(old.simulation.robot.position) !== JSON.stringify(robot.simulation.robot.position);
      if (moved) assert.equal(state.robots.some((r) => r.id !== robot.id
        && JSON.stringify(r.simulation.robot.position) === JSON.stringify(robot.simulation.robot.position)), false);
    }
    waits.push(...after.robots.filter((r) => r.waitReason).map((r) => ({ tick: after.tick, robotId: r.id, reason: r.waitReason, blockerId: r.blockerId })));
    effects.push(...result.effects); state = after;
    if (state.robots.filter((r) => r.work).every((r) => r.work.phase === 'COMPLETED')) break;
  }
  assert.equal(new Set(effects.map((e) => e.proposalKey)).size, effects.length);
  if (headOn) {
    assert.equal(effects.length, 0);
    assert.equal(state.tick, 100);
    assert.ok(state.robots.slice(0, 2).every((r) => r.waitTicks === 100 && r.waitReason === 'EDGE_SWAP' && r.work.phase === 'APPROACH'));
  } else {
    assert.equal(effects.length, 4);
    assert.ok(state.robots.filter((r) => r.work).every((r) => r.work.phase === 'COMPLETED'));
  }
  return { name, robots: count, tick: state.tick, status: headOn ? 'WAITING_NOT_COMPLETED' : 'COMPLETED',
    checkedNoVertexCollisionOrOccupiedEntry: true, effects, waits,
    final: state.robots.map((r) => ({ id: r.id, position: r.simulation.robot.position,
      phase: r.work?.phase ?? 'IDLE', taskId: r.work?.taskId ?? null, totalWaitTicks: r.totalWaitTicks, waitReason: r.waitReason })) };
}
const evidence = { capturedAt: new Date().toISOString(), scope: 'PURE_CORE_ONLY', persisted: false, browserVerified: false,
  map, tickMs: 250, seed: 42, scenarios: [run('T08-CROSS-3', 3), run('T08-CROSS-5', 5), run('T08-HEADON-5', 5, true)] };
mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
writeFileSync(new URL('../reports/day22-core.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ...evidence, scenarios: evidence.scenarios.map(({ name, robots, tick, status, effects, waits }) => ({ name, robots, tick, status, effects: effects.length, waitingObservations: waits.length })) }, null, 2));
