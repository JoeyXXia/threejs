import { describe, expect, it } from 'vitest';
import { cellCenter, rectangle, worldToCell } from './coordinates';
import { fixtureSnapshot } from './test-fixtures';

describe('grid/world coordinate contract', () => {
  const grid = fixtureSnapshot().layout.layoutVersion;
  it('maps integer cells to their centers with Y up', () => { expect(cellCenter(grid, 2, 3)).toEqual([2.5, 0, 3.5]); });
  it('handles shifted origins and non-unit cells', () => {
    const shifted = { ...grid, cellSize: 2, origin: { x: -10, z: 7 } };
    expect(cellCenter(shifted, 2, 3)).toEqual([-5, 0, 14]);
    for (let z = 0; z < shifted.depth; z++) for (let x = 0; x < shifted.width; x++) {
      const [worldX, , worldZ] = cellCenter(shifted, x, z);
      expect(worldToCell(shifted, worldX, worldZ)).toEqual({ x, z });
    }
    expect(worldToCell(shifted, -10, 7)).toEqual({ x: 0, z: 0 });
    expect(worldToCell(shifted, 10, 7)).toBeNull();
  });
  it('round-trips every sample cell center', () => {
    for (let x = 0; x < grid.width; x++) for (let z = 0; z < grid.depth; z++) {
      const world = cellCenter(grid, x, z);
      expect(worldToCell(grid, world[0], world[2])).toEqual({ x, z });
    }
  });
  it('treats outer boundaries as exclusive and floors interior points', () => {
    expect(worldToCell(grid, 10, 1)).toBeNull(); expect(worldToCell(grid, -0.01, 1)).toBeNull();
    expect(worldToCell(grid, 1, 8)).toBeNull(); expect(worldToCell(grid, Infinity, 1)).toBeNull();
    expect(worldToCell(grid, 9.999, 7.999)).toEqual({ x: 9, z: 7 });
  });
  it('rejects invalid cells rather than clamping them', () => {
    for (const [x, z] of [[-1, 0], [10, 0], [0, 8], [1.5, 2], [NaN, 0]]) expect(() => cellCenter(grid, x!, z!)).toThrow();
  });
  it('computes rectangle centers from edges, not a cell center offset', () => {
    expect(rectangle(grid, 2, 1, 3, 2)).toEqual({ position: [3.5, 0, 2], width: 3, depth: 2 });
    expect(() => rectangle(grid, 9, 0, 2, 2)).toThrow();
  });
  it('rejects nonfinite or zero-size grid metadata', () => {
    expect(() => cellCenter({ ...grid, cellSize: 0 }, 0, 0)).toThrow();
    expect(() => worldToCell({ ...grid, origin: { x: NaN, z: 0 } }, 0, 0)).toThrow();
  });
});
