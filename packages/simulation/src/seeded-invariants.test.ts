import { env } from 'node:process';
import { expect, it } from 'vitest';
import { findPath } from './astar.js';
import { chargeCommand, fleetAlerts } from './energy.js';
import { assignFleetTask, createFleet, stepFleet, type FleetEffect, type FleetState, type WaitReason } from './fleet.js';
import { changeNavigation } from './navigation.js';
import { controlRobot } from './recovery.js';
import { configureResources } from './resources.js';
import type { Cell, SimulationMap } from './simulation.js';

const fixedSeeds = [0, 1, 42, 0xffffffff, ...Array.from({ length: 28 }, (_, i) => Math.imul(i + 1, 0x9e3779b9) >>> 0)];
const selected = env.DAY39_SEED;
if (selected !== undefined && (!/^\d{1,10}$/.test(selected) || Number(selected) > 0xffffffff)) throw new Error('DAY39_SEED must be a uint32 decimal');
const seeds = selected === undefined ? fixedSeeds : [Number(selected)];
const combinedSeeds = selected === undefined ? Array.from({ length: 8 }, (_, i) => i) : seeds;
const p = (x: number, z: number): Cell => ({ x, z });
const key = (c: Cell) => `${c.x},${c.z}`;
const same = (a: Cell, b: Cell) => a.x === b.x && a.z === b.z;
const distance = (a: Cell, b: Cell) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
const allCells = (width: number, depth: number) => Array.from({ length: width * depth }, (_, i) => p(i % width, Math.floor(i / width)));

// Independent test-only generator; it does not consume any simulator randomness.
function generator(seed: number) {
  let state = seed;
  return (n: number) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * n);
  };
}

function generatedMap(seed: number) {
  const random = generator(seed), width = 5 + random(4), depth = 5 + random(4);
  const blocked = allCells(width, depth).filter(({ x, z }) => x > 0 && z > 0 && x < width - 1 && z < depth - 1 && random(4) === 0);
  return { map: { layoutId: `day39-${seed}`, version: 1, width, depth, blocked }, random };
}

function walkable(map: SimulationMap, point: Cell, closed: readonly Cell[] = []) {
  return Number.isInteger(point.x) && Number.isInteger(point.z) && point.x >= 0 && point.z >= 0
    && point.x < map.width && point.z < map.depth && !map.blocked.some((cell) => same(cell, point)) && !closed.some((cell) => same(cell, point));
}

// Build edges only from pairwise adjacent traversable vertices. BFS does not share A*'s heap, heuristic, coordinate indices or pruning.
function shortest(map: SimulationMap, start: Cell, goal: Cell): Cell[] | null {
  const floor = allCells(map.width, map.depth).filter((cell) => walkable(map, cell));
  if (!floor.some((c) => same(c, start)) || !floor.some((c) => same(c, goal))) return null;
  const queue = [[start]], visited = new Set([key(start)]);
  for (let i = 0; i < queue.length; i++) {
    const route = queue[i]!, last = route.at(-1)!;
    if (same(last, goal)) return route;
    for (const candidate of floor) if (distance(candidate, last) === 1 && !visited.has(key(candidate))) {
      visited.add(key(candidate)); queue.push([...route, candidate]);
    }
  }
  return null;
}

function diagnose<T>(label: string, seed: number, input: unknown, run: () => T): T {
  try { return run(); }
  catch (cause) { throw new Error(`${label} DAY39_SEED=${seed} fixture=${JSON.stringify(input)}`, { cause }); }
}

it('Day39 T07 compares seeded A* routes and explicit invalid/unreachable results with independent BFS', () => {
  const statuses: Record<string, number> = {};
  for (const seed of seeds) {
    const { map, random } = generatedMap(seed);
    const floor = allCells(map.width, map.depth).filter((point) => walkable(map, point));
    const source = floor[random(floor.length)]!, goal = floor[random(floor.length)]!;
    const cut = Math.floor(map.width / 2);
    const cutMap = { ...map, blocked: allCells(map.width, map.depth).filter((point) => point.x === cut) };
    const cases = [
      { map, start: source, goal }, { map, start: source, goal: source },
      { map: cutMap, start: p(0, 0), goal: p(map.width - 1, map.depth - 1) },
      { map, start: p(-1, 0), goal }, { map: cutMap, start: p(0, 0), goal: p(cut, 0) },
    ];
    for (const fixture of cases) diagnose('T07', seed, fixture, () => {
      const { map, start, goal } = fixture, want = shortest(map, start, goal);
      const result = findPath({ ...map, walkable: (point) => walkable(map, point) }, start, goal, { timeoutMs: 1000 });
      const status = !walkable(map, start) ? 'invalid-start' : !walkable(map, goal) ? 'invalid-goal' : want ? 'found' : 'unreachable';
      expect(result.status).toBe(status);
      if (!want) { expect(result.path).toEqual([]); expect(result.cost).toBeNull(); }
      else {
        expect(result.cost).toBe(want.length - 1);
        expect(result.path.length).toBe(want.length);
        expect(result.path[0]).toEqual(start); expect(result.path.at(-1)).toEqual(goal);
        expect(result.path.every((point, i) => walkable(map, point) && (i === 0 || distance(result.path[i - 1]!, point) === 1))).toBe(true);
      }
      statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    });
  }
  console.info('DAY39_T07', JSON.stringify({ maps: seeds.length, statuses }));
});

function safe(before: FleetState, after: FleetState) {
  expect(after.tick).toBe(before.tick + 1);
  const pre = before.robots.map((r) => r.simulation.robot.position), post = after.robots.map((r) => r.simulation.robot.position);
  expect(new Set(post.map(key)).size).toBe(post.length);
  for (const [i, robot] of after.robots.entries()) {
    const to = post[i]!, from = pre[i]!;
    expect(robot.id).toBe(before.robots[i]!.id);
    expect(robot.simulation.tick).toBe(after.tick);
    expect(walkable(robot.simulation.map, to, after.navigation?.closed)).toBe(true);
    expect(distance(from, to)).toBeLessThanOrEqual(1);
    // Detect a reverse edge explicitly, and also check the more conservative start-of-tick occupancy rule.
    expect(pre.some((cell, j) => j !== i && same(cell, to) && same(post[j]!, from))).toBe(false);
    expect(pre.some((cell, j) => j !== i && same(cell, to))).toBe(false);
    expect(robot.simulation.robot.battery).toBeGreaterThanOrEqual(0);
    expect(robot.simulation.robot.battery).toBeLessThanOrEqual(10000);
  }
  for (const resource of after.resources ?? []) {
    const occupants = after.robots.filter((r) => resource.cells.some((cell) => same(cell, r.simulation.robot.position)));
    expect(occupants.length).toBeLessThanOrEqual(1);
    expect(resource.ownerId).toBe(occupants[0]?.id ?? null);
  }
}

function checked(initial: FleetState) {
  let state = initial;
  const effects = new Map<string, FleetEffect['stage'][]>(), waits = new Map<WaitReason, number>();
  return { get state() { return state; }, replace(next: FleetState) {
    expect(next.tick).toBe(state.tick);
    expect(next.robots.map((r) => r.simulation.robot.position)).toEqual(state.robots.map((r) => r.simulation.robot.position));
    state = next;
  }, tick() {
    const result = stepFleet(state);
    safe(state, result.state);
    for (const effect of result.effects) {
      const history = effects.get(effect.taskId) ?? [];
      expect(effect.stage).toBe(history.length === 0 ? 'take' : 'drop');
      expect(history.length).toBeLessThan(2);
      history.push(effect.stage); effects.set(effect.taskId, history);
      expect(result.state.robots.find((r) => r.id === effect.robotId)?.work?.taskId).toBe(effect.taskId);
    }
    for (const r of result.state.robots) if (r.waitReason) waits.set(r.waitReason, (waits.get(r.waitReason) ?? 0) + 1);
    state = result.state;
  }, effects, waits };
}

function makeTasks(seed: number) {
  const { map, random } = generatedMap(seed);
  const floor = allCells(map.width, map.depth).filter((point) => walkable(map, point));
  const perimeter = floor.filter(({ x, z }) => x === 0 || z === 0 || x === map.width - 1 || z === map.depth - 1);
  const robots = Array.from({ length: 3 + seed % 3 }, (_, i) => ({ id: `r${i}`, battery: 10000, position: perimeter.splice(random(perimeter.length), 1)[0]! }));
  const tasks = robots.map((r) => {
    const pickups = floor.filter((cell) => !same(cell, r.position) && shortest(map, r.position, cell));
    const pickup = pickups[random(pickups.length)]!;
    const drops = floor.filter((cell) => !same(cell, pickup) && shortest(map, pickup, cell));
    const drop = drops[random(drops.length)]!;
    return { robotId: r.id, id: `order-${r.id}`, approach: shortest(map, r.position, pickup)!, loaded: shortest(map, pickup, drop)! };
  });
  const aisles = [0, map.depth - 1].flatMap((z) => Array.from({ length: map.width - 1 }, (_, x) => [p(x, z), p(x + 1, z)]))
    .filter((cells) => robots.filter((r) => cells.some((cell) => same(cell, r.position))).length <= 1);
  return { map, robots, tasks, aisle: aisles[random(aisles.length)]! };
}

it('Day39 T08 checks every generated fleet tick and separates proposal safety from task completion', () => {
  let ticks = 0, completed = 0, assigned = 0, allCompleted = 0;
  const reasons: Record<string, number> = {}, waitRobotTicks: Record<string, number> = {};
  for (const seed of seeds) {
    const input = makeTasks(seed);
    diagnose('T08', seed, input, () => {
      const { map, robots, tasks, aisle } = input;
      let state = configureResources(createFleet({ map, seed, robots }), [{ id: 'aisle', kind: 'AISLE', cells: aisle }]);
      for (const t of tasks) state = assignFleetTask(state, t.robotId, t.id, t.approach, t.loaded);
      const monitor = checked(state);
      while (monitor.state.tick < 80 && monitor.state.robots.some((r) => r.work?.phase !== 'COMPLETED')) monitor.tick();
      ticks += monitor.state.tick; assigned += tasks.length;
      for (const [reason, count] of monitor.waits) waitRobotTicks[reason] = (waitRobotTicks[reason] ?? 0) + count;
      let finished = 0;
      for (const robot of monitor.state.robots) {
        expect(robot.work?.phase).not.toBe('ERROR');
        if (robot.work?.phase === 'COMPLETED') {
          expect(monitor.effects.get(robot.work.taskId)).toEqual(['take', 'drop']);
          finished++;
        } else {
          const reason = robot.waitReason ?? `TICK_LIMIT:${robot.work?.phase}`;
          reasons[reason] = (reasons[reason] ?? 0) + 1;
        }
      }
      completed += finished; allCompleted += Number(finished === tasks.length);
    });
  }
  expect(Object.values(reasons).reduce((n, count) => n + count, 0)).toBe(assigned - completed);
  if (selected === undefined) {
    expect(waitRobotTicks.TARGET_CONFLICT).toBeGreaterThan(0);
    expect(waitRobotTicks.RESOURCE_BUSY).toBeGreaterThan(0);
  }
  console.info('DAY39_T08', JSON.stringify({ scenarios: seeds.length, ticks, assigned, completed, allCompleted, reasons, waitRobotTicks }));
});

function oriented(seed: number) {
  const random = generator(seed), mirrorX = seed % 2 === 1, mirrorZ = (seed >>> 1) % 2 === 1, transpose = (seed >>> 2) % 2 === 1;
  const cell = (x: number, z: number) => {
    const a = mirrorX ? 7 - x : x, b = mirrorZ ? 5 - z : z;
    return transpose ? p(b, a) : p(a, b);
  };
  const map = { layoutId: `day39-combined-${seed}`, version: 1, width: transpose ? 6 : 8, depth: transpose ? 8 : 6,
    blocked: [cell(6, 4), cell(5 + random(3), 5)] };
  return { cell, map, battery: 9100 + random(700) };
}

it('Day39 T08/T09 retains a closed edge-exchange wait and explains why both tasks remain incomplete', () => {
  for (const seed of combinedSeeds) {
    const { cell: c, map } = oriented(seed);
    const robots = [{ id: 'a', position: c(1, 1) }, { id: 'b', position: c(2, 1) }, { id: 'idle', position: c(7, 4) }];
    const paths = [[c(1, 1), c(2, 1)], [c(2, 1), c(1, 1)]] as const;
    diagnose('T08/T09 head-on', seed, { map, robots, paths }, () => {
      let state = createFleet({ map, seed, robots });
      state = assignFleetTask(state, 'a', 'one', paths[0], [c(2, 1), c(3, 1)]);
      state = assignFleetTask(state, 'b', 'two', paths[1], [c(1, 1), c(0, 1)]);
      const monitor = checked(state);
      for (let i = 0; i < 24; i++) monitor.tick();
      const waiting = monitor.state.robots.filter((r) => r.work);
      expect(waiting.map((r) => [r.waitReason, r.blockerId, r.work?.phase])).toEqual([
        ['EDGE_SWAP', 'b', 'APPROACH'], ['EDGE_SWAP', 'a', 'APPROACH'],
      ]);
      expect(waiting.map((r) => r.simulation.robot.position)).toEqual(robots.slice(0, 2).map((r) => r.position));
      expect(fleetAlerts(monitor.state).map((a) => a.kind)).toEqual(['NO_PROGRESS', 'NO_PROGRESS']);
      expect(monitor.effects.size).toBe(0);
    });
  }
  console.info('DAY39_HEAD_ON', JSON.stringify({ scenarios: combinedSeeds.length, ticks: combinedSeeds.length * 24, completed: 0, reason: 'EDGE_SWAP' }));
});

it('Day39 T09/T10 combines no-path closure, carried fault, repair and a contended dock', () => {
  let ticks = 0;
  for (const seed of combinedSeeds) {
    const { cell: c, map, battery } = oriented(seed);
    const robots = [{ id: 'a', position: c(0, 1), battery: 10000 }, { id: 'b', position: c(0, 3), battery }, { id: 'c', position: c(2, 3), battery }];
    const aisle = [c(2, 1), c(3, 1)], dock = c(1, 3), wall = Array.from({ length: 6 }, (_, z) => c(4, z));
    const route = Array.from({ length: 6 }, (_, i) => c(1 + i, 1));
    diagnose('T09/T10 combined', seed, { map, robots, aisle, dock, wall, route }, () => {
      const initial = configureResources(createFleet({ map, seed, robots }), [
        { id: 'aisle', kind: 'AISLE', cells: aisle }, { id: 'dock', kind: 'CHARGING', cells: [dock] },
      ]);
      const depleted = configureResources(createFleet({ map, seed, robots: robots.map((r) => r.id === 'b' ? { ...r, battery: 0 } : r) }),
        [{ id: 'dock', kind: 'CHARGING', cells: [dock] }]);
      expect(() => chargeCommand(depleted, 'b', [robots[1]!.position, dock])).toThrow('charge plan unsafe');
      let state = assignFleetTask(initial, 'a', 'cargo', [robots[0]!.position, route[0]!], route);
      state = chargeCommand(chargeCommand(state, 'b', [robots[1]!.position, dock]), 'c', [robots[2]!.position, dock]);
      const monitor = checked(state), car = (id: string) => monitor.state.robots.find((r) => r.id === id)!;
      const owner = (id: string) => monitor.state.resources?.find((r) => r.id === id)?.ownerId;
      const runUntil = (condition: () => boolean) => {
        for (let i = 0; i < 40 && !condition(); i++) monitor.tick();
        expect(condition()).toBe(true);
      };
      runUntil(() => car('a').work?.phase === 'TRANSPORT' && same(car('a').simulation.robot.position, aisle[0]!));
      expect(monitor.effects.get('cargo')).toEqual(['take']);
      expect(owner('aisle')).toBe('a');
      const frozen = car('a').simulation.robot;
      const cut = () => monitor.replace(changeNavigation(monitor.state, wall, true, 0, [], { timeoutMs: 1000 }));
      const fault = () => monitor.replace(controlRobot(monitor.state, 'a', 'FAULT', 'seeded hardware-free failure'));
      if (seed % 2) { cut(); fault(); } else { fault(); cut(); }
      expect(car('a').navigationIssue?.reason).toBe('NO_PATH');
      for (let i = 0; i < 22; i++) {
        monitor.tick();
        expect(car('a').simulation.robot).toEqual(frozen);
        expect(car('a').work).toMatchObject({ taskId: 'cargo', phase: 'TRANSPORT' });
        expect(owner('aisle')).toBe('a');
      }
      expect(monitor.effects.get('cargo')).toEqual(['take']);
      expect(owner('dock')).toBe('b');
      expect(car('b').simulation.robot.battery).toBe(10000); expect(car('b').charge).toBeNull();
      expect(car('c').waitReason).toBe('RESOURCE_BUSY'); expect(car('c').blockerId).toBe('b');
      expect(fleetAlerts(monitor.state)).toEqual(expect.arrayContaining([expect.objectContaining({ robotId: 'c', kind: 'NO_PROGRESS' })]));
      const repair = () => monitor.replace(controlRobot(monitor.state, 'a', 'REPAIR', 'repair at tick boundary'));
      const reopen = () => monitor.replace(changeNavigation(monitor.state, [c(4, 1)], false, 1, [], { timeoutMs: 1000 }));
      if (seed % 2) repair(); else reopen();
      monitor.tick();
      expect(car('a').simulation.robot.position).toEqual(frozen.position);
      expect(car('a').work).toMatchObject({ taskId: 'cargo', phase: 'TRANSPORT' });
      expect(owner('aisle')).toBe('a');
      expect(monitor.effects.get('cargo')).toEqual(['take']);
      if (seed % 2) reopen(); else repair();
      runUntil(() => car('a').work?.phase === 'COMPLETED');
      expect(monitor.effects.get('cargo')).toEqual(['take', 'drop']);
      expect(owner('aisle')).toBeNull(); expect(owner('dock')).toBe('b');
      ticks += monitor.state.tick;
    });
  }
  console.info('DAY39_COMBINED', JSON.stringify({ scenarios: combinedSeeds.length, ticks,
    deliveredAfterRepair: combinedSeeds.length, chargesCompleted: combinedSeeds.length, chargesWaiting: combinedSeeds.length }));
});
