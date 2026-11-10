import { useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import type { WarehouseSnapshot } from '@warehouse-twin/contracts';
import { cellCenter, rectangle } from './coordinates';
import { zoneAppearance } from './zone-palette';
import { inventoryAppearance } from './inventory-view';
import type { LocationView, ZoneFilter } from './inventory-view';
import type { CameraMode } from './scene-store';
import { CameraRig } from './CameraRig';

function ContextWatch({ onLost }: { onLost: () => void }) {
  const canvas = useThree((state) => state.gl.domElement);
  useEffect(() => {
    const handle = (event: Event) => { event.preventDefault(); onLost(); };
    canvas.addEventListener('webglcontextlost', handle);
    return () => canvas.removeEventListener('webglcontextlost', handle);
  }, [canvas, onLost]);
  return null;
}

type Props = { snapshot: WarehouseSnapshot; views: LocationView[]; showZones: boolean; showServiceCells: boolean; selectedLocationId: string | null;
  zoneFilter: ZoneFilter; cameraMode: CameraMode; cameraRequest: { locationId: string | null; sequence: number }; onSelect: (id: string | null) => void };

export function WarehouseScene({ snapshot, views, showZones, showServiceCells, selectedLocationId, zoneFilter, cameraMode, cameraRequest, onSelect }: Props) {
  const [lost, setLost] = useState(false);
  const { layout } = snapshot;
  const grid = layout.layoutVersion;
  const floor = rectangle(grid, 0, 0, grid.width, grid.depth);
  const [cx, , cz] = floor.position;
  const size = Math.max(floor.width, floor.depth);
  const services = [...new Map(views.map(({ location }) => [`${location.serviceCell.x},${location.serviceCell.z}`, location.serviceCell])).values()];
  if (lost) return <p role="alert" className="scene-fallback">WebGL 上下文已丢失，请重新载入场景。</p>;
  return <Canvas key={grid.id} shadows="percentage" dpr={[1, 1.5]} frameloop="demand"
      onPointerMissed={() => onSelect(null)}
      camera={{ position: [cx + size * .65, size * .8, cz + size * .9], fov: 42, near: .1, far: size * 10 }}
      fallback={<p role="alert">当前设备不支持 WebGL，API 汇总仍可查看。</p>}>
      <ContextWatch onLost={() => setLost(true)} />
      <color attach="background" args={['#edf2ef']} />
      <ambientLight intensity={1.1} />
      <hemisphereLight args={['#ffffff', '#a7b5a7', 1.2]} />
      <directionalLight castShadow position={[cx + 8, size, cz - 6]} intensity={2.2}
        shadow-mapSize={[1024, 1024]} shadow-camera-left={-size} shadow-camera-right={size}
        shadow-camera-top={size} shadow-camera-bottom={-size} shadow-camera-far={size * 4} shadow-bias={-.001} />
      <mesh position={[cx, -.09, cz]} receiveShadow onClick={(event) => { event.stopPropagation(); if (event.delta < 4) onSelect(null); }}><boxGeometry args={[floor.width, .16, floor.depth]} /><meshStandardMaterial color="#d7dfd9" /></mesh>
      <Grid position={[cx, .003, cz]} args={[floor.width, floor.depth]} cellSize={grid.cellSize} sectionSize={grid.cellSize * 5}
        cellColor="#b6c3ba" sectionColor="#92a89b" fadeDistance={size * 4} />
      {showZones && layout.zones.filter((zone) => zoneFilter === 'ALL' || zone.kind === zoneFilter).map((zone) => {
        const rect = rectangle(grid, zone.gridX, zone.gridZ, zone.sizeX, zone.sizeZ);
        return <mesh key={zone.id} position={[rect.position[0], .018, rect.position[2]]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[rect.width, rect.depth]} /><meshStandardMaterial color={zoneAppearance[zone.kind].color} transparent opacity={.32} depthWrite={false} />
        </mesh>;
      })}
      {layout.racks.map((rack) => {
        const rect = rectangle(grid, rack.gridX, rack.gridZ, rack.sizeX, rack.sizeZ);
        const height = rack.levels * rack.levelHeight;
        return <group key={rack.id} position={rect.position} onClick={(event) => event.stopPropagation()}>
          {[-1, 1].flatMap((x) => [-1, 1].map((z) => <mesh key={`${x}:${z}`} position={[x * (rect.width / 2 - .05), height / 2, z * (rect.depth / 2 - .05)]} castShadow>
            <boxGeometry args={[.08, height, .08]} /><meshStandardMaterial color="#465e70" />
          </mesh>))}
          {Array.from({ length: rack.levels + 1 }, (_, level) => <mesh key={level} position={[0, level * rack.levelHeight + .09, 0]} castShadow receiveShadow>
            <boxGeometry args={[rect.width, .12, rect.depth]} /><meshStandardMaterial color="#b3b8b1" />
          </mesh>)}
        </group>;
      })}
      {views.map(({ location, total, status }) => {
        const [x, , z] = cellCenter(grid, location.grid.x, location.grid.z);
        const rack = layout.racks.find((rack) => rack.id === location.rackId);
        const hasStock = total.onHand > 0;
        const side = grid.cellSize * .64;
        const y = location.grid.level * (rack?.levelHeight ?? 0) + .14 + side / 2;
        return <group key={location.id} position={[x, y, z]} userData={{ locationId: location.id }}
          onClick={(event) => { event.stopPropagation(); if (event.delta < 4) onSelect(location.id); }}>
          <mesh castShadow={hasStock}>
            <boxGeometry args={[side, side, side]} />
            <meshStandardMaterial color={inventoryAppearance[status].color} wireframe={!hasStock} />
          </mesh>
          {selectedLocationId === location.id && <mesh><boxGeometry args={[side + .06, side + .06, side + .06]} /><meshBasicMaterial color="#276b7e" wireframe /></mesh>}
        </group>;
      })}
      {showServiceCells && services.map((cell) => {
        const [x, , z] = cellCenter(grid, cell.x, cell.z);
        return <mesh key={`${cell.x},${cell.z}`} position={[x, .05, z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[grid.cellSize * .2, grid.cellSize * .28, 24]} /><meshBasicMaterial color="#376f85" />
        </mesh>;
      })}
      <CameraRig layout={layout} mode={cameraMode} request={cameraRequest} />
    </Canvas>;
}
