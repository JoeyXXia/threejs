import { expect, it } from 'vitest';
import { assignFleetTask, coordinateMoves, createFleet, stepFleet, type FleetState, type MoveProposal } from './fleet.js';

const p = (x: number, z: number) => ({ x, z });
const map = { layoutId: 'fleet-fixture', version: 1, width: 5, depth: 5, blocked: [] };
const proposal = (robotId: string, from: ReturnType<typeof p>, to: ReturnType<typeof p>, waitTicks = 0, priority = 0): MoveProposal => ({ robotId, from, to, waitTicks, priority });
function fleet() {
  return createFleet({ map, seed: 42, robots: [{ id: 'a', position: p(0, 1), battery: 10000 },
    { id: 'b', position: p(1, 0), battery: 10000 }, { id: 'c', position: p(3, 3), battery: 10000 }] });
}
function crossing() {
  let state = assignFleetTask(fleet(), 'a', 'job-a', [p(0, 1), p(1, 1), p(2, 1)], [p(2, 1), p(3, 1)]);
  state = assignFleetTask(state, 'b', 'job-b', [p(1, 0), p(1, 1), p(1, 2)], [p(1, 2), p(1, 3)]);
  return state;
}
function safeTransition(before: FleetState, after: FleetState) {
  const positions = after.robots.map((r) => JSON.stringify(r.simulation.robot.position));
  expect(new Set(positions).size).toBe(after.robots.length);
  for (const r of after.robots) {
    const old = before.robots.find((b) => b.id === r.id)!;
    const moved = JSON.stringify(old.simulation.robot.position) !== JSON.stringify(r.simulation.robot.position);
    if (moved) expect(before.robots.some((b) => b.id !== r.id && JSON.stringify(b.simulation.robot.position) === JSON.stringify(r.simulation.robot.position))).toBe(false);
  }
}

it('arbitrates the same empty target by explicit priority, then consecutive waiting, then stable id', () => {
  const a = proposal('a', p(0, 1), p(1, 1)), b = proposal('b', p(1, 0), p(1, 1));
  expect(coordinateMoves([b, a])).toEqual([{ robotId: 'a', allowed: true, reason: null, blockerId: null },
    { robotId: 'b', allowed: false, reason: 'TARGET_CONFLICT', blockerId: 'a' }]);
  expect(coordinateMoves([a, { ...b, waitTicks: 1 }])[1]!.allowed).toBe(true);
  expect(coordinateMoves([{ ...a, priority: 1 }, { ...b, waitTicks: 100 }])[0]!.allowed).toBe(true);
  expect(coordinateMoves([a, b])).toEqual(coordinateMoves([b, a]));
});

it('rejects both sides of an edge swap rather than letting the priority winner pass through', () => {
  const decisions = coordinateMoves([proposal('a', p(0, 0), p(1, 0), 0, 99), proposal('b', p(1, 0), p(0, 0))]);
  expect(decisions.map((d) => [d.allowed, d.reason])).toEqual([[false, 'EDGE_SWAP'], [false, 'EDGE_SWAP']]);
});

it('conservatively denies following into a cell even when its occupant leaves during the same tick', () => {
  const decisions = coordinateMoves([proposal('a', p(0, 0), p(1, 0)), proposal('b', p(1, 0), p(2, 0))]);
  expect(decisions[0]).toMatchObject({ allowed: false, reason: 'OCCUPIED', blockerId: 'b' });
  expect(decisions[1]!.allowed).toBe(true);
  expect(coordinateMoves([proposal('a', p(0, 0), p(1, 0)), proposal('b', p(2, 0), p(3, 0))]).every((d) => d.allowed)).toBe(true);
});

it('keeps parked occupants solid and rejects malformed, duplicate or overlapping proposals', () => {
  const moving = proposal('a', p(0, 0), p(1, 0)), parked = proposal('b', p(1, 0), p(1, 0));
  expect(coordinateMoves([moving, parked])[0]).toMatchObject({ allowed: false, reason: 'OCCUPIED' });
  for (const values of [[], [moving, { ...parked, robotId: 'a' }], [moving, { ...parked, from: p(0, 0) }],
    [{ ...moving, to: p(1, 1) }], [{ ...moving, to: p(-1, 0) }], [{ ...moving, waitTicks: -1 }], [{ ...moving, priority: 1001 }]]) {
    expect(() => coordinateMoves(values)).toThrow();
  }
});

it('creates only three to five robots, with distinct legal cells and reproducible explicit seed/id ordering', () => {
  const descriptors = fleet().robots.map((r) => ({ id: r.id, position: r.simulation.robot.position }));
  const forward = createFleet({ map, seed: 42, robots: descriptors });
  expect(createFleet({ map, seed: 42, robots: [...descriptors].reverse() })).toEqual(forward);
  expect(createFleet({ map, seed: 42, robots: [...descriptors, { id: 'd', position: p(4, 4) }, { id: 'e', position: p(4, 3) }] }).robots).toHaveLength(5);
  expect(() => createFleet({ map, seed: 42, robots: descriptors.slice(0, 2) })).toThrow();
  expect(() => createFleet({ map, seed: 42, robots: [...descriptors, ...descriptors] })).toThrow();
  expect(() => createFleet({ map, seed: 42, robots: descriptors.map((r) => ({ ...r, position: p(0, 0) })) })).toThrow();
});

it('claims a task once, makes matching replay idempotent and rejects changed ownership, paths or a busy robot', () => {
  const state = assignFleetTask(fleet(), 'a', 'job-a', [p(0, 1), p(1, 1)], [p(1, 1), p(2, 1)]);
  expect(assignFleetTask(state, 'a', 'job-a', [p(0, 1), p(1, 1)], [p(1, 1), p(2, 1)])).toBe(state);
  expect(() => assignFleetTask(state, 'b', 'job-a', [p(1, 0)], [p(1, 0)])).toThrow('already assigned');
  expect(() => assignFleetTask(state, 'a', 'job-a', [p(0, 1)], [p(0, 1)])).toThrow('different parameters');
  expect(() => assignFleetTask(state, 'a', 'job-new', [p(0, 1)], [p(0, 1)])).toThrow('active');
  expect(() => assignFleetTask(state, 'unknown', 'job-new', [p(0, 1)], [p(0, 1)])).toThrow('unknown');
});

it('runs a three-robot crossing with observable waits, safe steps and exactly two effect proposals per task', () => {
  let state = crossing();
  const effects = [], waits = [];
  for (let i = 0; i < 60; i++) {
    const result = stepFleet(state);
    safeTransition(state, result.state);
    effects.push(...result.effects); waits.push(...result.state.robots.filter((r) => r.waitReason !== null));
    state = result.state;
    if (state.robots.filter((r) => r.work?.phase === 'COMPLETED').length === 2) break;
  }
  expect(state.robots.filter((r) => r.work?.phase === 'COMPLETED')).toHaveLength(2);
  expect(effects.map((e) => e.proposalKey).sort()).toEqual(['fleet:job-a:drop', 'fleet:job-a:take', 'fleet:job-b:drop', 'fleet:job-b:take']);
  expect(waits.some((r) => r.waitReason === 'TARGET_CONFLICT')).toBe(true);
  expect(waits.some((r) => r.waitReason === 'OCCUPIED')).toBe(true);
  expect(state.robots[1]!.totalWaitTicks).toBe(2);
  expect(state.robots[2]!.simulation.robot.position).toEqual(p(3, 3));
});

it('retains a real head-on deadlock for 25 ticks, without consuming route cursor, battery or manufacturing completion', () => {
  let state = createFleet({ map, seed: 0, robots: [{ id: 'a', position: p(0, 0), battery: 100 },
    { id: 'b', position: p(1, 0), battery: 100 }, { id: 'c', position: p(4, 4) }] });
  state = assignFleetTask(state, 'a', 'job-a', [p(0, 0), p(1, 0)], [p(1, 0), p(2, 0)]);
  state = assignFleetTask(state, 'b', 'job-b', [p(1, 0), p(0, 0)], [p(0, 0), p(0, 1)]);
  const initial = state;
  for (let i = 0; i < 25; i++) {
    const result = stepFleet(state); safeTransition(state, result.state);
    expect(result.effects).toEqual([]); state = result.state;
  }
  expect(state.tick).toBe(25);
  for (let i = 0; i < 2; i++) {
    expect(state.robots[i]).toMatchObject({ waitTicks: 25, totalWaitTicks: 25, waitReason: 'EDGE_SWAP', work: { phase: 'APPROACH', phaseTicks: 0 } });
    expect(state.robots[i]!.simulation.robot).toEqual(initial.robots[i]!.simulation.robot);
  }
});

it('retains failed robot occupancy and prevents assigning new work over its error state', () => {
  let state = createFleet({ map, seed: 0, robots: [{ id: 'a', position: p(0, 0), battery: 1 },
    { id: 'b', position: p(2, 0), battery: 100 }, { id: 'c', position: p(4, 4) }] });
  state = assignFleetTask(state, 'a', 'job-a', [p(0, 0), p(1, 0)], [p(1, 0), p(1, 1)]);
  state = assignFleetTask(state, 'b', 'job-b', [p(2, 0), p(1, 0)], [p(1, 0), p(0, 0)]);
  for (let i = 0; i < 3; i++) state = stepFleet(state).state;
  expect(state.robots[0]).toMatchObject({ work: { phase: 'ERROR' }, simulation: { robot: { position: p(1, 0) } } });
  expect(state.robots[1]).toMatchObject({ waitReason: 'OCCUPIED', blockerId: 'a' });
  expect(() => assignFleetTask(state, 'a', 'replacement', [p(1, 0)], [p(1, 0)])).toThrow('failed');
});

it('keeps completed assignment history unique after the owner starts a later task', () => {
  let state = assignFleetTask(fleet(), 'a', 'old', [p(0, 1)], [p(0, 1)]);
  for (let i = 0; i < 12; i++) state = stepFleet(state).state;
  expect(state.robots[0]!.work!.phase).toBe('COMPLETED');
  state = assignFleetTask(state, 'a', 'new', [p(0, 1), p(1, 1)], [p(1, 1)]);
  expect(assignFleetTask(state, 'a', 'old', [p(0, 1)], [p(0, 1)])).toBe(state);
  expect(state.robots[0]!.work!.taskId).toBe('new');
  expect(() => assignFleetTask(state, 'b', 'old', [p(1, 0)], [p(1, 0)])).toThrow('already assigned');
});

it('advances five distinct active tasks together and proposes one take/drop pair per owner', () => {
  let state = createFleet({ map, seed: 42, robots: Array.from({ length: 5 }, (_, x) => ({ id: `r-${x}`, position: p(x, 0), battery: 10000 })) });
  for (let x = 0; x < 5; x++) state = assignFleetTask(state, `r-${x}`, `job-${x}`, [p(x, 0), p(x, 1)], [p(x, 1), p(x, 2)]);
  const effects = [];
  for (let i = 0; i < 10; i++) {
    const next = stepFleet(state); safeTransition(state, next.state);
    effects.push(...next.effects); state = next.state;
  }
  expect(state.robots.every((r) => r.work?.phase === 'COMPLETED' && r.totalWaitTicks === 0)).toBe(true);
  expect(effects).toHaveLength(10);
  expect(new Set(effects.map((e) => e.proposalKey)).size).toBe(10);
  for (let x = 0; x < 5; x++) expect(effects.filter((e) => e.robotId === `r-${x}`).map((e) => e.stage)).toEqual(['take', 'drop']);
});

it('produces immutable deterministic proposals across JSON checkpoint round trips; replay is not a ledger commit', () => {
  const state = crossing(), before = JSON.stringify(state), next = stepFleet(state);
  expect(JSON.stringify(state)).toBe(before);
  expect(stepFleet(state)).toEqual(next);
  expect(stepFleet(JSON.parse(before))).toEqual(next);
  expect(Object.isFrozen(next.state.robots[0])).toBe(true);
  const malformed = { ...state, robots: state.robots.map((r, i) => i === 1 ? { ...r, work: state.robots[0]!.work } : r) };
  expect(() => stepFleet(malformed)).toThrow('task owned');
  expect(() => stepFleet({ ...state, tick: 99 })).toThrow('mixed');
});

it('exhaustively keeps distinct cells and rejects occupied-cell entry on all 648 three-robot 2x2 proposals', () => {
  const cells = [p(0, 0), p(1, 0), p(0, 1), p(1, 1)];
  const next = (from: ReturnType<typeof p>) => cells.filter((to) => Math.abs(to.x - from.x) + Math.abs(to.z - from.z) <= 1);
  let tested = 0;
  for (const a of cells) for (const b of cells) for (const c of cells) {
    if (a === b || a === c || b === c) continue;
    for (const x of next(a)) for (const y of next(b)) for (const z of next(c)) {
      const input = [proposal('a', a, x), proposal('b', b, y), proposal('c', c, z)];
      const decisions = coordinateMoves(input);
      const final = input.map((r, i) => decisions[i]!.allowed ? r.to : r.from);
      expect(new Set(final.map((v) => JSON.stringify(v))).size).toBe(3);
      for (let i = 0; i < 3; i++) if (final[i] !== input[i]!.from) {
        expect(input.some((r, j) => i !== j && r.from.x === final[i]!.x && r.from.z === final[i]!.z)).toBe(false);
      }
      tested++;
    }
  }
  expect(tested).toBe(648);
});
