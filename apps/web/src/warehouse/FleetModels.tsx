import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Group } from 'three';
import type { FleetResponse, LayoutResponse } from '@warehouse-twin/contracts';
import { cellCenter } from './coordinates';

export function FleetModels({ fleet, grid }: { fleet: FleetResponse; grid: LayoutResponse['layoutVersion'] }) {
  const meshes = useRef<Record<string, Group | null>>({}), sample = useRef({ fleet, at: performance.now() });
  const canvas = useThree((s) => s.gl.domElement), invalidate = useThree((s) => s.invalidate);
  useEffect(() => { if (sample.current.fleet.stateVersion !== fleet.stateVersion) { sample.current = { fleet, at: sample.current.fleet.tick === fleet.tick ? sample.current.at : performance.now() }; invalidate(); } }, [fleet, invalidate]);
  useEffect(() => { canvas.dataset.fleetCount = String(fleet.robots.length); return () => { delete canvas.dataset.fleetCount; delete canvas.dataset.fleetPositions; }; }, [canvas, fleet.robots.length]);
  useFrame(() => {
    const age = performance.now() - sample.current.at, t = Math.min(1, Math.max(0, age / 250));
    const positions = sample.current.fleet.robots.map((r) => {
      const x = r.from.x + (r.to.x - r.from.x) * t, z = r.from.z + (r.to.z - r.from.z) * t;
      meshes.current[r.id]?.position.set(grid.origin.x + (x + .5) * grid.cellSize, .24, grid.origin.z + (z + .5) * grid.cellSize);
      return { id: r.id, x, z, tick: sample.current.fleet.tick };
    });
    canvas.dataset.fleetPositions = JSON.stringify(positions);
    if (age <= 1600) invalidate();
  });
  return <>{fleet.robots.map((r, i) => <group key={r.id}>
    {r.route.length > 1 && <Line points={r.route.map((p) => { const [x, , z] = cellCenter(grid, p.x, p.z); return [x, .06 + i * .01, z] as [number, number, number]; })} color={(['#246c9d', '#8b4db0', '#278562', '#a36b25', '#a13f4f'][i] ?? '#246c9d')} lineWidth={2} />}
    <group ref={(node) => { meshes.current[r.id] = node; }} position={cellCenter(grid, r.from.x, r.from.z)} userData={{ robotId: r.id }}>
      <mesh castShadow><boxGeometry args={[grid.cellSize * .6, .35, grid.cellSize * .7]} /><meshStandardMaterial color={r.phase === 'ERROR' ? '#888888' : r.waitReason ? '#bf7e16' : (['#246c9d', '#8b4db0', '#278562', '#a36b25', '#a13f4f'][i] ?? '#246c9d')} /></mesh>
      <mesh position={[0, .2, .25]}><boxGeometry args={[.14, .08, .12]} /><meshStandardMaterial color="#ffffff" /></mesh>
      {r.carrying && <mesh position={[0, .35, 0]}><boxGeometry args={[.35, .3, .35]} /><meshStandardMaterial color="#b17f46" /></mesh>}
    </group>
  </group>)}</>;
}
