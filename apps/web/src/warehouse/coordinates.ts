import type { LayoutResponse } from '@warehouse-twin/contracts';

type Grid = LayoutResponse['layoutVersion'];
function validGrid(grid: Grid) {
  if (!Number.isInteger(grid.width) || !Number.isInteger(grid.depth) || grid.width <= 0 || grid.depth <= 0
    || !Number.isFinite(grid.cellSize) || grid.cellSize <= 0 || !Number.isFinite(grid.origin.x) || !Number.isFinite(grid.origin.z)) {
    throw new Error('Invalid grid geometry');
  }
}

export function cellCenter(grid: Grid, x: number, z: number): [number, number, number] {
  validGrid(grid);
  if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0 || x >= grid.width || z >= grid.depth) throw new Error('Grid cell out of bounds');
  return [grid.origin.x + (x + 0.5) * grid.cellSize, 0, grid.origin.z + (z + 0.5) * grid.cellSize];
}

export function worldToCell(grid: Grid, x: number, z: number): { x: number; z: number } | null {
  validGrid(grid);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const gx = Math.floor((x - grid.origin.x) / grid.cellSize), gz = Math.floor((z - grid.origin.z) / grid.cellSize);
  return gx >= 0 && gz >= 0 && gx < grid.width && gz < grid.depth ? { x: gx, z: gz } : null;
}

export function rectangle(grid: Grid, x: number, z: number, width: number, depth: number) {
  validGrid(grid);
  if (![x, z, width, depth].every(Number.isInteger) || x < 0 || z < 0 || width <= 0 || depth <= 0
    || x + width > grid.width || z + depth > grid.depth) throw new Error('Rectangle out of bounds');
  return { position: [grid.origin.x + (x + width / 2) * grid.cellSize, 0, grid.origin.z + (z + depth / 2) * grid.cellSize] as [number, number, number],
    width: width * grid.cellSize, depth: depth * grid.cellSize };
}
