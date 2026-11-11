import { afterEach, expect, it, vi } from 'vitest';
import { findPath } from './astar';
import { buildNavigationGrid } from './navigation';
import { fixtureSnapshot } from './test-fixtures';

type Point = { x: number; z: number };
const budget = { maxExpanded: 65536, timeoutMs: 1000 };

function map(width: number, depth: number, blocked: Point[] = []) {
  const layout = fixtureSnapshot().layout;
  layout.layoutVersion = { ...layout.layoutVersion, width, depth };
  layout.racks = [];
  layout.locations = [];
  layout.blockedCells = blocked;
  return buildNavigationGrid(layout);
}

// The oracle uses its own occupancy table and FIFO traversal, independent of A*.
function bfs(width: number, depth: number, blocked: Point[], start: Point, goal: Point) {
  const walls = new Set(blocked.map(({ x, z }) => `${x},${z}`));
  const queue = [{ ...start, distance: 0 }];
  const seen = new Set([`${start.x},${start.z}`]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const point = queue[cursor]!;
    if (point.x === goal.x && point.z === goal.z) return point.distance;
    const adjacent = [{ x: point.x + 1, z: point.z }, { x: point.x - 1, z: point.z },
      { x: point.x, z: point.z + 1 }, { x: point.x, z: point.z - 1 }];
    for (const next of adjacent) {
      const key = `${next.x},${next.z}`;
      if (next.x < 0 || next.z < 0 || next.x >= width || next.z >= depth || walls.has(key) || seen.has(key)) continue;
      seen.add(key);
      queue.push({ ...next, distance: point.distance + 1 });
    }
  }
  return null;
}

function compare(width: number, depth: number, blocked: Point[], start: Point, goal: Point) {
  const grid = map(width, depth, blocked);
  const result = findPath(grid, start, goal, budget);
  const distance = bfs(width, depth, blocked, start, goal);
  expect(result.status).toBe(distance === null ? 'unreachable' : 'found');
  expect(result.cost).toBe(distance);
  expect(result.layoutId).toBe(grid.layoutId);
  expect(result.layoutVersion).toBe(grid.version);
  expect(result.metrics.expanded).toBeLessThanOrEqual(width * depth);
  expect(result.metrics.discovered).toBeLessThanOrEqual(width * depth);
  expect(result.metrics.elapsedMs).toBeGreaterThanOrEqual(0);
  if (distance === null) {
    expect(result.path).toEqual([]);
    return result;
  }
  expect(result.path[0]).toEqual(start);
  expect(result.path.at(-1)).toEqual(goal);
  expect(result.path).toHaveLength(distance + 1);
  for (let i = 0; i < result.path.length; i++) {
    const point = result.path[i]!;
    expect(grid.walkable(point)).toBe(true);
    if (i > 0) {
      const previous = result.path[i - 1]!;
      expect(Math.abs(point.x - previous.x) + Math.abs(point.z - previous.z)).toBe(1);
    }
  }
  return result;
}

afterEach(() => vi.restoreAllMocks());

it('takes a legal shortest detour and produces repeatable equal-cost paths', () => {
  const blocked = [{ x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 }, { x: 2, z: 3 }];
  const start = { x: 0, z: 0 }, goal = { x: 4, z: 0 };
  const result = compare(5, 5, blocked, start, goal);
  expect(result.cost).toBe(12);
  expect(findPath(map(5, 5, blocked), start, goal, budget).path).toEqual(result.path);
});

it('matches BFS for every valid endpoint pair on all 512 occupancy maps of 3 by 3 cells', () => {
  let comparisons = 0;
  for (let mask = 0; mask < 512; mask++) {
    const blocked: Point[] = [], free: Point[] = [];
    for (let index = 0; index < 9; index++) {
      (mask & (1 << index) ? blocked : free).push({ x: index % 3, z: Math.floor(index / 3) });
    }
    for (const start of free) for (const goal of free) {
      compare(3, 3, blocked, start, goal);
      comparisons++;
    }
  }
  expect(comparisons).toBe(11520);
});

it('matches BFS on 100 larger deterministic obstacle maps', () => {
  for (let sample = 0; sample < 100; sample++) {
    const blocked: Point[] = [];
    for (let index = 1; index < 119; index++) {
      const hash = Math.imul(index + 1, 2654435761) ^ Math.imul(sample + 1, 2246822519);
      if ((hash >>> 0) % 10 < 3) blocked.push({ x: index % 12, z: Math.floor(index / 12) });
    }
    compare(12, 10, blocked, { x: 0, z: 0 }, { x: 11, z: 9 });
  }
});

it('distinguishes a blocked or illegal endpoint from an exhausted unreachable search', () => {
  const grid = map(3, 3, [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 2 }]);
  for (const start of [{ x: -1, z: 0 }, { x: 0.5, z: 0 }, { x: NaN, z: 0 }, { x: 1, z: 0 }]) {
    expect(findPath(grid, start, { x: 2, z: 2 }).status).toBe('invalid-start');
  }
  for (const goal of [{ x: 3, z: 0 }, { x: 0, z: Infinity }, { x: 1, z: 1 }]) {
    expect(findPath(grid, { x: 0, z: 0 }, goal).status).toBe('invalid-goal');
  }
  const result = findPath(grid, { x: 0, z: 0 }, { x: 2, z: 0 }, budget);
  expect(result.status).toBe('unreachable');
  expect(result.cost).toBeNull();
  expect(result.path).toEqual([]);
  expect(result.metrics.expanded).toBe(3);
});

it('returns a same-cell path without expansion and preserves layout identity', () => {
  const grid = map(3, 3);
  const result = findPath(grid, { x: 0, z: 0 }, { x: 0, z: 0 }, { maxExpanded: 0 });
  expect(result.status).toBe('found');
  expect(result.path).toEqual([{ x: 0, z: 0 }]);
  expect(result.cost).toBe(0);
  expect(result.metrics.expanded).toBe(0);
  expect(result.layoutId).toBe(grid.layoutId);
});

it('reports node and monotonic time budgets with no partial success path', () => {
  const grid = map(10, 8);
  const start = { x: 0, z: 0 }, goal = { x: 9, z: 7 };
  const limited = findPath(grid, start, goal, { maxExpanded: 2, timeoutMs: 1000 });
  expect(limited.status).toBe('node-limit');
  expect(limited.metrics.expanded).toBe(2);
  expect(limited.path).toEqual([]);
  expect(limited.cost).toBeNull();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now++);
  const timed = findPath(grid, start, goal, { timeoutMs: 2 });
  expect(timed.status).toBe('time-limit');
  expect(timed.metrics.expanded).toBe(1);
  expect(timed.path).toEqual([]);
  expect(timed.cost).toBeNull();
});

it('rejects invalid budgets before searching', () => {
  const grid = map(3, 3);
  for (const options of [{ maxExpanded: -1 }, { maxExpanded: 0.5 }, { maxExpanded: 65537 },
    { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 1001 }]) {
    expect(findPath(grid, { x: 0, z: 0 }, { x: 2, z: 2 }, options).status).toBe('invalid-options');
  }
});

it('routes to a storage service cell while rejecting the rack interior', () => {
  const layout = fixtureSnapshot().layout;
  const grid = buildNavigationGrid(layout);
  const location = layout.locations[0]!;
  const result = findPath(grid, { x: 0, z: 0 }, grid.servicePoints.get(location.id)!, budget);
  expect(result.status).toBe('found');
  expect(result.cost).toBe(2);
  expect(findPath(grid, { x: 0, z: 0 }, location.grid).status).toBe('invalid-goal');
});
