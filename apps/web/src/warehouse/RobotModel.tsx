import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Group, MeshStandardMaterial } from 'three';
import type { LayoutResponse, RobotSnapshot } from '@warehouse-twin/contracts';
import { cellCenter } from './coordinates';
import { confirmedPose } from './robot-pose';
import { poseMatches, type PoseBuffer } from './pose-buffer';

export function RobotModel({ snapshot, grid, visual }: {
  snapshot: RobotSnapshot; grid: LayoutResponse['layoutVersion']; visual: { poses: PoseBuffer; watermark: number; epoch: number } | undefined;
}) {
  const mesh = useRef<Group>(null);
  const material = useRef<MeshStandardMaterial>(null);
  const sample = useRef({ snapshot, receivedAt: performance.now() });
  const invalidate = useThree((s) => s.invalidate);
  const canvas = useThree((s) => s.gl.domElement);
  const poses = visual?.poses;
  useEffect(() => poses?.subscribe(invalidate), [poses, invalidate]);
  useEffect(() => () => {
    for (const name of ['robotTask', 'robotX', 'robotZ', 'robotTick', 'robotStale']) delete canvas.dataset[name];
  }, [canvas]);
  useEffect(() => {
    const previous = sample.current.snapshot;
    // Same tick polled again must not restart interpolation.
    if (previous.taskId !== snapshot.taskId || previous.tick !== snapshot.tick || previous.phase !== snapshot.phase) {
      sample.current = { snapshot, receivedAt: performance.now() };
      invalidate();
    }
  }, [snapshot, invalidate]);
  useFrame(() => {
    const now = performance.now();
    const latest = poses?.read();
    const entry = visual && latest?.pose.mode === 'SINGLE' && poseMatches(latest.pose, grid, visual.epoch, snapshot.tick, 0, visual.watermark)
      && latest.pose.robots[0]?.taskId === snapshot.taskId ? latest : undefined;
    const move = entry?.pose.robots[0];
    const position = move && entry ? { ...sample.current.snapshot, tick: entry.pose.tick,
      from: entry.snap ? move.to : move.from, to: move.to, direction: move.direction ?? snapshot.direction } : sample.current.snapshot;
    const receivedAt = entry?.at ?? sample.current.receivedAt;
    const pose = confirmedPose(position, receivedAt, now);
    if (mesh.current) {
      mesh.current.position.set(grid.origin.x + (pose.x + .5) * grid.cellSize, .24, grid.origin.z + (pose.z + .5) * grid.cellSize);
      mesh.current.rotation.y = pose.angle;
    }
    material.current?.color.set(pose.stale || snapshot.phase === 'ERROR' ? '#8b8b8b' : snapshot.carrying ? '#e69c36' : '#246c9d');
    // Read-only QA diagnostics; never consumed by a business command.
    canvas.dataset.robotTask = snapshot.taskId;
    canvas.dataset.robotX = pose.x.toFixed(4);
    canvas.dataset.robotZ = pose.z.toFixed(4);
    canvas.dataset.robotTick = String(position.tick);
    canvas.dataset.robotStale = String(pose.stale);
    if (now - receivedAt <= 1600) invalidate();
  });
  const points = snapshot.route.map((p) => { const [x, , z] = cellCenter(grid, p.x, p.z); return [x, .08, z] as [number, number, number]; });
  return <>
    {points.length > 1 && <Line points={points} color="#246c9d" lineWidth={3} />}
    <group ref={mesh} position={cellCenter(grid, snapshot.from.x, snapshot.from.z)} userData={{ robotTaskId: snapshot.taskId }}>
      <mesh castShadow><boxGeometry args={[grid.cellSize * .65, .35, grid.cellSize * .75]} /><meshStandardMaterial ref={material} color="#246c9d" /></mesh>
      <mesh position={[0, .2, grid.cellSize * .28]}><boxGeometry args={[.14, .08, .12]} /><meshStandardMaterial color="#e5f5fa" /></mesh>
      {snapshot.carrying && <mesh position={[0, .35, 0]}><boxGeometry args={[.35, .3, .35]} /><meshStandardMaterial color="#b17f46" /></mesh>}
    </group>
  </>;
}
