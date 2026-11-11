import { expect, it } from 'vitest';
import { buildNavigationGrid, navigationCell } from './navigation';
import { fixtureId, fixtureSnapshot } from './test-fixtures';

it('blocks the rack footprint independently of the API obstacle list and shares valid service cells across levels', () => {
  const layout = fixtureSnapshot().layout;
  layout.blockedCells = [{ x: 0, z: 0 }];
  layout.racks[0]!.levels = 2;
  layout.locations[1]!.grid = { ...layout.locations[0]!.grid, level: 1 };
  layout.locations[1]!.serviceCell = layout.locations[0]!.serviceCell;
  const grid = buildNavigationGrid(layout);
  expect(grid.cellAt({ x: 0, z: 0 })).toBe(navigationCell.WALL);
  expect(grid.cellAt({ x: 2, z: 2 })).toBe(navigationCell.RACK);
  expect(grid.walkable(layout.locations[0]!.grid)).toBe(false);
  expect(grid.cellAt({ x: 1, z: 1 })).toBe(navigationCell.SERVICE);
  expect(grid.servicePoints.get(fixtureId(6))).toEqual(grid.servicePoints.get(fixtureId(7)));
  expect(grid.walkableCount).toBe(77);
  expect(grid.walkable({ x: -1, z: 0 })).toBe(false);
  expect(grid.invalidServices).toEqual([]);
});

it('marks a ground workstation and reports a four-neighbor split', () => {
  const layout = fixtureSnapshot().layout;
  layout.locations.push({ ...layout.locations[0]!, id: fixtureId(30), code: 'QC', kind: 'QC',
    rackId: null, grid: { x: 8, z: 1, level: 0 }, serviceCell: { x: 8, z: 1 } });
  layout.blockedCells.push(...Array.from({ length: 8 }, (_, z) => ({ x: 5, z })));
  const grid = buildNavigationGrid(layout);
  expect(grid.componentCount).toBe(2);
  expect(grid.cellAt({ x: 8, z: 1 })).toBe(navigationCell.STATION);
  expect(grid.componentAt({ x: 8, z: 1 })).not.toBe(grid.componentAt({ x: 1, z: 1 }));
  expect(grid.componentAt({ x: 5, z: 1 })).toBeNull();
});

it('reports service points on obstacles, outside the layout and away from the rack side', () => {
  const layout = fixtureSnapshot().layout;
  const location = layout.locations[0]!;
  const other = layout.locations[1]!;
  location.serviceCell = { x: 2, z: 1 };
  other.serviceCell = { x: -1, z: 0 };
  layout.locations.push({ ...location, id: fixtureId(33), code: 'FAR', serviceCell: { x: 8, z: 1 } });
  const grid = buildNavigationGrid(layout);
  expect(grid.servicePoints.size).toBe(0);
  expect(grid.invalidServices).toEqual([location.code, other.code, 'FAR']);
  expect(grid.walkable({ x: 8, z: 1 })).toBe(true);
});

it('rejects dimensions that exceed the debug grid budget before allocating cells', () => {
  const layout = fixtureSnapshot().layout;
  layout.layoutVersion.width = 513;
  expect(() => buildNavigationGrid(layout)).toThrow('导航地图超出支持范围');
});
