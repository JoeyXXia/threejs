export type Grid = {
  layoutId: string; version: number; width: number; depth: number;
  walkable: (point: { x: number; z: number }) => boolean;
};
type Point = { x: number; z: number };
type Entry = { index: number; g: number; h: number };
type SearchStatus = 'found' | 'unreachable' | 'invalid-start' | 'invalid-goal' | 'invalid-options' | 'node-limit' | 'time-limit';
const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

// Equal priorities use h, then the cell index, so equal-cost routes are repeatable.
const before = (a: Entry, b: Entry) => a.g + a.h < b.g + b.h
  || (a.g + a.h === b.g + b.h && (a.h < b.h || (a.h === b.h && a.index < b.index)));

class MinHeap {
  entries: Entry[] = [];

  push(entry: Entry) {
    let child = this.entries.length;
    this.entries.push(entry);
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (!before(entry, this.entries[parent]!)) break;
      this.entries[child] = this.entries[parent]!;
      child = parent;
    }
    this.entries[child] = entry;
  }

  pop() {
    const first = this.entries[0]!;
    const last = this.entries.pop()!;
    if (!this.entries.length) return first;
    let parent = 0;
    while (parent * 2 + 1 < this.entries.length) {
      let child = parent * 2 + 1;
      const right = child + 1;
      if (right < this.entries.length && before(this.entries[right]!, this.entries[child]!)) child = right;
      if (!before(this.entries[child]!, last)) break;
      this.entries[parent] = this.entries[child]!;
      parent = child;
    }
    this.entries[parent] = last;
    return first;
  }
}

export function findPath(grid: Grid, start: Point, goal: Point, options: { maxExpanded?: number; timeoutMs?: number } = {}) {
  const startedAt = performance.now();
  const maxExpanded = options.maxExpanded ?? 10000;
  const timeoutMs = options.timeoutMs ?? 25;
  let expanded = 0;
  let discovered = 0;
  let queuePeak = 0;
  const finish = (status: SearchStatus, path: Point[] = []) => ({
    status, path, cost: status === 'found' ? path.length - 1 : null,
    layoutId: grid.layoutId, layoutVersion: grid.version,
    metrics: { expanded, discovered, queuePeak, elapsedMs: performance.now() - startedAt },
  });
  if (!Number.isInteger(maxExpanded) || maxExpanded < 0 || maxExpanded > 65536
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1000) return finish('invalid-options');
  if (!grid.walkable(start)) return finish('invalid-start');
  if (!grid.walkable(goal)) return finish('invalid-goal');
  if (start.x === goal.x && start.z === goal.z) return finish('found', [{ ...start }]);

  const size = grid.width * grid.depth;
  const scores = new Float64Array(size).fill(Infinity);
  const parents = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const startIndex = start.z * grid.width + start.x;
  const goalIndex = goal.z * grid.width + goal.x;
  const open = new MinHeap();
  scores[startIndex] = 0;
  open.push({ index: startIndex, g: 0, h: Math.abs(start.x - goal.x) + Math.abs(start.z - goal.z) });
  discovered = queuePeak = 1;

  while (open.entries.length) {
    if (performance.now() - startedAt >= timeoutMs) return finish('time-limit');
    const current = open.pop();
    // Improvements insert a new heap entry. Discard older scores when popped.
    if (closed[current.index] || current.g !== scores[current.index]) continue;
    if (current.index === goalIndex) {
      const path: Point[] = [];
      for (let index = goalIndex; index !== -1; index = parents[index]!) {
        path.push({ x: index % grid.width, z: Math.floor(index / grid.width) });
      }
      return finish('found', path.reverse());
    }
    if (expanded >= maxExpanded) return finish('node-limit');
    closed[current.index] = 1;
    expanded++;
    const x = current.index % grid.width;
    const z = Math.floor(current.index / grid.width);
    for (const [dx, dz] of neighbors) {
      const point = { x: x + dx, z: z + dz };
      if (!grid.walkable(point)) continue;
      const next = point.z * grid.width + point.x;
      const g = current.g + 1;
      if (closed[next] || g >= scores[next]!) continue;
      if (scores[next] === Infinity) discovered++;
      scores[next] = g;
      parents[next] = current.index;
      open.push({ index: next, g, h: Math.abs(point.x - goal.x) + Math.abs(point.z - goal.z) });
      queuePeak = Math.max(queuePeak, open.entries.length);
    }
  }
  return finish('unreachable');
}
