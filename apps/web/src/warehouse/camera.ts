import type { LayoutResponse } from '@warehouse-twin/contracts';
import type { CameraMode } from './scene-store';
import { cellCenter, rectangle } from './coordinates';

export function cameraPose(layout: LayoutResponse, mode: CameraMode, locationId: string | null) {
  const grid = layout.layoutVersion, floor = rectangle(grid, 0, 0, grid.width, grid.depth);
  const size = Math.max(floor.width, floor.depth);
  const location = locationId ? layout.locations.find((entry) => entry.id === locationId) : undefined;
  if (locationId && !location) throw new Error('Unknown camera location');
  const target: [number, number, number] = location ? cellCenter(grid, location.grid.x, location.grid.z) : [...floor.position];
  if (location) target[1] = location.grid.level * (layout.racks.find((rack) => rack.id === location.rackId)?.levelHeight ?? 0) + grid.cellSize * .5;
  const position: [number, number, number] = mode === 'top' ? [target[0], size * 1.6, target[2]]
    : location ? [target[0] + grid.cellSize * 5, target[1] + grid.cellSize * 6, target[2] + grid.cellSize * 7]
      : [target[0] + size * .65, size * .8, target[2] + size * .9];
  return { position, target, zoom: mode === 'top' && location ? Math.max(1, size / (8 * grid.cellSize)) : 1 };
}

export function orthographicBounds(layout: LayoutResponse, aspect: number) {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('Invalid viewport aspect');
  const grid = layout.layoutVersion;
  const halfHeight = Math.max(grid.depth * grid.cellSize / 2, grid.width * grid.cellSize / (2 * aspect)) * 1.15;
  return { left: -halfHeight * aspect, right: halfHeight * aspect, top: halfHeight, bottom: -halfHeight };
}

export function smoothProgress(elapsed: number, duration = .65) {
  const t = Math.min(1, Math.max(0, elapsed / duration));
  return t * t * (3 - 2 * t);
}
