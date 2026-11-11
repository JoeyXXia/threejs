import type { LayoutResponse } from '@warehouse-twin/contracts';

type Point = { x: number; z: number };
export const navigationCell = { AISLE: 0, RACK: 1, WALL: 2, SERVICE: 3, STATION: 4 } as const;
type CellKind = typeof navigationCell[keyof typeof navigationCell];
const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

export function buildNavigationGrid(layout: LayoutResponse) {
  const { id: layoutId, version, width, depth } = layout.layoutVersion;
  const size = width * depth;
  if (!Number.isInteger(width) || !Number.isInteger(depth) || width <= 0 || depth <= 0
    || width > 512 || depth > 512 || size > 65536) {
    throw new Error('导航地图超出支持范围');
  }

  const cells = new Uint8Array(size);
  const index = ({ x, z }: Point) => Number.isInteger(x) && Number.isInteger(z) && x >= 0 && z >= 0 && x < width && z < depth
    ? z * width + x : -1;
  const cellAt = (point: Point) => cells[index(point)] as CellKind | undefined;
  const walkable = (point: Point) => {
    const kind = cellAt(point);
    return kind === navigationCell.AISLE || kind === navigationCell.SERVICE || kind === navigationCell.STATION;
  };
  for (const point of layout.blockedCells) {
    const offset = index(point);
    if (offset < 0) throw new Error('阻塞格超出布局范围');
    cells[offset] = navigationCell.WALL;
  }
  const racks = new Map(layout.racks.map((rack) => [rack.id, rack]));
  for (const rack of layout.racks) {
    const right = rack.gridX + rack.sizeX - 1;
    const bottom = rack.gridZ + rack.sizeZ - 1;
    if (rack.sizeX <= 0 || rack.sizeZ <= 0 || index({ x: rack.gridX, z: rack.gridZ }) < 0 || index({ x: right, z: bottom }) < 0) {
      throw new Error('货架占地超出布局范围');
    }
    for (let z = rack.gridZ; z <= bottom; z++) {
      cells.fill(navigationCell.RACK, z * width + rack.gridX, z * width + right + 1);
    }
  }

  const servicePoints = new Map<string, Point>();
  const invalidServices: string[] = [];
  for (const location of layout.locations) {
    const point = location.serviceCell;
    const rack = location.rackId ? racks.get(location.rackId) : undefined;
    const onRackSide = rack
      && location.grid.x >= rack.gridX && location.grid.x < rack.gridX + rack.sizeX
      && location.grid.z >= rack.gridZ && location.grid.z < rack.gridZ + rack.sizeZ
      && location.grid.level >= 0 && location.grid.level < rack.levels && (
      ((point.x === rack.gridX - 1 || point.x === rack.gridX + rack.sizeX)
        && point.z >= rack.gridZ && point.z < rack.gridZ + rack.sizeZ)
      || ((point.z === rack.gridZ - 1 || point.z === rack.gridZ + rack.sizeZ)
        && point.x >= rack.gridX && point.x < rack.gridX + rack.sizeX)
    );
    const storage = location.kind === 'STORAGE';
    const validGeometry = storage ? onRackSide
      : !location.rackId && location.grid.level === 0 && point.x === location.grid.x && point.z === location.grid.z;
    if (!validGeometry || !walkable(point)) {
      invalidServices.push(location.code);
      continue;
    }
    servicePoints.set(location.id, { ...point });
    const offset = index(point);
    if (!storage || cells[offset] !== navigationCell.STATION) {
      cells[offset] = storage ? navigationCell.SERVICE : navigationCell.STATION;
    }
  }

  const components = new Int32Array(size);
  const queue = new Int32Array(size);
  let componentCount = 0;
  let walkableCount = 0;
  for (let start = 0; start < size; start++) {
    if (components[start] || !walkable({ x: start % width, z: Math.floor(start / width) })) continue;
    components[start] = ++componentCount;
    queue[0] = start;
    let end = 1;
    for (let cursor = 0; cursor < end; cursor++) {
      const current = queue[cursor]!;
      const x = current % width;
      const z = Math.floor(current / width);
      for (const [dx, dz] of neighbors) {
        const point = { x: x + dx, z: z + dz };
        const next = index(point);
        if (next < 0 || components[next] || !walkable(point)) continue;
        components[next] = componentCount;
        queue[end++] = next;
      }
    }
    walkableCount += end;
  }

  return { layoutId, version, width, depth, cellAt, walkable, servicePoints, invalidServices,
    componentAt: (point: Point) => components[index(point)] || null, componentCount, walkableCount };
}
