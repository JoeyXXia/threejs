import { afterEach, expect, it, vi } from 'vitest';
import { findPath } from './astar.js';
import {
  applyCommand, createFixedStepRunner, createSimulation, nextRandom, stateSummary, step,
  type Command, type SimulationMap,
} from './simulation.js';

const map: SimulationMap = { layoutId: 'layout-test', version: 1, width: 5, depth: 5, blocked: [{ x: 1, z: 0 }] };
const path = [{ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 1 }, { x: 2, z: 1 }, { x: 2, z: 0 }];
const route: Command = { type: 'route', layoutId: map.layoutId, layoutVersion: 1, path };
const initial = (battery = 100) => createSimulation({ map, seed: 42, position: path[0]!, battery });
const moving = () => applyCommand(initial(), route);

afterEach(() => vi.restoreAllMocks());

it('defaults to 250ms and produces identical state and summaries for repeated input/seed', () => {
  const replay = () => {
    let state = createSimulation({ map, seed: 42, position: path[0]! });
    const summaries = [stateSummary(state)];
    for (let tick = 0; tick < 30; tick++) {
      if (tick === 0) state = applyCommand(state, route);
      if (tick === 2) state = applyCommand(state, { type: 'pause' });
      if (tick === 7) state = applyCommand(state, { type: 'resume' });
      state = step(state);
      summaries.push(stateSummary(state));
    }
    return { state, summaries };
  };
  expect(replay()).toEqual(replay());
  expect(replay().state).toMatchObject({ tickMs: 250, tick: 25, logicalTimeMs: 6250 });
});

it('moves at most one four-neighbor cell, updates heading, drains integer battery and stops', () => {
  let state = moving();
  for (const [i, direction] of ['S', 'E', 'E', 'N'].entries()) {
    const before = state;
    state = step(state);
    expect(state.robot).toMatchObject({ position: path[i + 1], battery: 99 - i, direction });
    expect(before.robot.position).toEqual(path[i]);
    expect(state.logicalTimeMs).toBe((i + 1) * 250);
  }
  expect(state.robot.status).toBe('IDLE');
  const idle = step(state);
  expect(idle.robot).toEqual(state.robot);
  expect(idle.tick).toBe(5);
});

it('does not move or advance logical time while paused; commands remain explicit', () => {
  let state = applyCommand(moving(), { type: 'pause' });
  const paused = state;
  for (let i = 0; i < 100; i++) state = step(state);
  expect(state).toBe(paused);
  state = step(applyCommand(state, { type: 'resume' }));
  expect(state).toMatchObject({ tick: 1, logicalTimeMs: 250, robot: { position: path[1] } });
});

it('matches logic at 30, 60 and 144 FPS over 10 seconds of integer elapsed input', () => {
  const results = [30, 60, 144].map((fps) => {
    const runner = createFixedStepRunner(moving());
    let previous = 0;
    for (let i = 1; i <= fps * 10; i++) {
      const now = Math.floor(i * 1000 / fps);
      expect(runner.advance(now - previous).lag).toBe(false);
      previous = now;
    }
    expect(runner.getState().tick).toBe(40);
    return stateSummary(runner.getState());
  });
  expect(new Set(results).size).toBe(1);
});

it('preserves fractional tick remainder, but discards it across real pause transitions', () => {
  const runner = createFixedStepRunner(moving());
  expect(runner.advance(249).steps).toBe(0);
  runner.command({ type: 'resume' });
  expect(runner.advance(1).steps).toBe(1);
  runner.advance(200);
  runner.command({ type: 'pause' });
  expect(runner.advance(100000)).toMatchObject({ steps: 0, remainderMs: 0, lag: false });
  runner.command({ type: 'resume' });
  expect(runner.advance(50)).toMatchObject({ steps: 0, remainderMs: 50 });
  expect(runner.advance(200).steps).toBe(1);
  expect(runner.getState().tick).toBe(2);
});

it('caps catch-up and reports discarded wall time without leaking a backlog', () => {
  const runner = createFixedStepRunner(moving());
  const result = runner.advance(10025);
  expect(result).toMatchObject({ steps: 8, droppedMs: 8000, lag: true, remainderMs: 25 });
  expect(result.state).toMatchObject({ tick: 8, logicalTimeMs: 2000 });
  expect(runner.advance(0)).toMatchObject({ steps: 0, droppedMs: 0, lag: false, remainderMs: 25 });
  expect(runner.advance(225).steps).toBe(1);
});

it('cannot consume more battery than available or teleport to the end', () => {
  let state = applyCommand(initial(2), route);
  for (let i = 0; i < 10; i++) state = step(state);
  expect(state.robot).toMatchObject({ position: path[2], battery: 0, status: 'DEPLETED', next: 3 });
  expect(() => applyCommand(state, route)).toThrow('battery depleted');
});

it('validates routes before accepting them, leaving the old state unchanged on rejection', () => {
  const state = initial();
  const before = stateSummary(state);
  const invalid = [[], [{ x: 2, z: 0 }], [path[0]!, { x: 1, z: 0 }],
    [path[0]!, { x: 1, z: 1 }], [path[0]!, { x: -1, z: 0 }], [path[0]!, path[0]!],
    [path[0]!, { x: NaN, z: 1 }], [path[0]!, { x: 0, z: 0.5 }]];
  for (const bad of invalid) expect(() => applyCommand(state, { ...route, path: bad })).toThrow();
  expect(() => applyCommand(state, { ...route, layoutVersion: 2 })).toThrow('stale layout');
  expect(() => applyCommand(state, { ...route, layoutId: 'other' })).toThrow('stale layout');
  expect(() => applyCommand(moving(), route)).toThrow('busy');
  expect(stateSummary(state)).toBe(before);
});

it('accepts a same-cell route without moving or draining battery', () => {
  const state = applyCommand(initial(), { ...route, path: [path[0]!] });
  expect(step(state).robot).toMatchObject({ status: 'IDLE', battery: 100, position: path[0] });
});

it('uses no ambient entropy, clock or timer for core and adapter', () => {
  const forbidden = () => { throw new Error('ambient source used'); };
  vi.spyOn(Math, 'random').mockImplementation(forbidden);
  vi.spyOn(Date, 'now').mockImplementation(forbidden);
  vi.spyOn(performance, 'now').mockImplementation(forbidden);
  vi.spyOn(globalThis, 'setInterval').mockImplementation(forbidden);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(forbidden);
  const runner = createFixedStepRunner(moving());
  const result = runner.advance(1000);
  expect(result.state.robot.position).toEqual(path[4]);
  expect(stateSummary(result.state)).toMatch(/^sim1-[0-9a-f]{8}$/);
});

it('has explicit reproducible PRNG state including seed zero and uint32 maximum', () => {
  for (const seed of [0, 1, 42, 0xffffffff]) {
    expect(nextRandom(seed)).toEqual(nextRandom(seed));
    expect(nextRandom(seed).value).toBeGreaterThanOrEqual(0);
    expect(nextRandom(seed).value).toBeLessThan(1);
    const make = () => createSimulation({ map, seed, position: path[0]! });
    expect(make()).toEqual(make());
    expect(make().robot.battery).toBeGreaterThanOrEqual(9000);
    expect(make().robot.battery).toBeLessThanOrEqual(10000);
  }
  expect(nextRandom(0).state).not.toBe(0);
  expect(stateSummary(createSimulation({ map, seed: 0, position: path[0]! })))
    .not.toBe(stateSummary(createSimulation({ map, seed: 1, position: path[0]! })));
});

it('copies and freezes caller-owned input and keeps snapshots JSON serializable', () => {
  const mutableMap = { ...map, blocked: [{ x: 1, z: 0 }] };
  const position = { x: 0, z: 0 };
  const mutablePath = path.map((p) => ({ ...p }));
  const state = applyCommand(createSimulation({ map: mutableMap, seed: 0, position }), { ...route, path: mutablePath });
  const summary = stateSummary(state);
  position.x = 4;
  mutableMap.blocked[0]!.x = 4;
  mutablePath[1]!.x = 4;
  expect(stateSummary(state)).toBe(summary);
  expect(Object.isFrozen(state.robot.path[1])).toBe(true);
  expect(Object.isFrozen(state.map.blocked[0])).toBe(true);
  expect(stateSummary(JSON.parse(JSON.stringify(state)))).toBe(summary);
});

it('rejects invalid configuration, elapsed input and step budget', () => {
  const config = { map, seed: 0, position: path[0]! };
  for (const seed of [-1, 0.5, NaN, Infinity, 0x100000000]) expect(() => createSimulation({ ...config, seed })).toThrow();
  for (const battery of [-1, 10001, 1.5]) expect(() => createSimulation({ ...config, battery })).toThrow();
  for (const tickMs of [0, 1001, NaN]) expect(() => createSimulation({ ...config, tickMs })).toThrow();
  expect(() => createSimulation({ ...config, map: { ...map, width: 0 } })).toThrow();
  expect(() => createSimulation({ ...config, map: { ...map, width: 512, depth: 512 } })).toThrow();
  expect(() => createSimulation({ ...config, position: { x: 1, z: 0 } })).toThrow();
  expect(() => createSimulation({ ...config, map: { ...map, blocked: [{ x: 99, z: 0 }] } })).toThrow();
  const runner = createFixedStepRunner(initial());
  for (const delta of [-1, 0.1, NaN, Infinity, 3600001]) expect(() => runner.advance(delta)).toThrow();
  expect(runner.getState().tick).toBe(0);
  expect(() => createFixedStepRunner(initial(), 0)).toThrow();
});

it('consumes the shared A* path without a browser and rejects stale layout identity', () => {
  const grid = { ...map, walkable: (p: { x: number; z: number }) =>
    Number.isInteger(p.x) && Number.isInteger(p.z) && p.x >= 0 && p.x < 5 && p.z >= 0 && p.z < 5
      && !map.blocked.some((b) => b.x === p.x && b.z === p.z) };
  const result = findPath(grid, path[0]!, path[4]!, { timeoutMs: 1000 });
  expect(result.status).toBe('found');
  const runner = createFixedStepRunner(initial());
  runner.command({ type: 'route', layoutId: result.layoutId, layoutVersion: result.layoutVersion, path: result.path });
  runner.advance(result.cost! * 250);
  expect(runner.getState().robot).toMatchObject({ position: path[4], status: 'IDLE' });
});

it('includes layout, pause and pending route in diagnostic identity', () => {
  const state = initial();
  expect(stateSummary(state)).not.toBe(stateSummary(applyCommand(state, route)));
  expect(stateSummary(state)).not.toBe(stateSummary(applyCommand(state, { type: 'pause' })));
  expect(stateSummary(state)).not.toBe(stateSummary({ ...state, map: { ...map, version: 2 } }));
});

it('canonicalizes coordinate property order and blocked-cell order in summaries', () => {
  const first = applyCommand(initial(), route);
  const reordered = { ...first, robot: { ...first.robot, path: path.map(({ x, z }) => ({ z, x })) } };
  expect(stateSummary(first)).toBe(stateSummary(reordered));
  const walls = [{ x: 1, z: 0 }, { x: 4, z: 4 }];
  const create = (blocked: typeof walls) => createSimulation({ map: { ...map, blocked }, seed: 0, position: path[0]! });
  expect(stateSummary(create(walls))).toBe(stateSummary(create([...walls].reverse())));
});
