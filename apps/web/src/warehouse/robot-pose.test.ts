import { expect, it } from 'vitest';
import { robotSnapshotSchema, type RobotSnapshot } from '@warehouse-twin/contracts';
import { confirmedPose } from './robot-pose';

const snapshot: RobotSnapshot = { taskId: '00000000-0000-4000-8000-000000000001', allocationId: '00000000-0000-4000-8000-000000000002',
  layoutId: '00000000-0000-4000-8000-000000000003', layoutVersion: 1, phase: 'TRANSPORT', tick: 2, logicalTimeMs: 500,
  tickMs: 250, from: { x: 0, z: 0 }, to: { x: 1, z: 0 }, direction: 'E', battery: 9999,
  route: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }], carrying: true, error: null };

it('interpolates only a confirmed segment, never the next route cell', () => {
  expect(confirmedPose(snapshot, 1000, 1000).x).toBe(0);
  expect(confirmedPose(snapshot, 1000, 1125).x).toBe(.5);
  expect(confirmedPose(snapshot, 1000, 1250).x).toBe(1);
  expect(confirmedPose(snapshot, 1000, 20000)).toMatchObject({ x: 1, z: 0, stale: true });
  expect(confirmedPose(snapshot, 1000, 500).x).toBe(0);
});
it('low display FPS changes no authoritative fields and converges to the same endpoint', () => {
  const original = JSON.stringify(snapshot);
  for (const fps of [5, 30, 60, 144]) {
    for (let i = 0; i < fps * 2; i++) confirmedPose(snapshot, 0, i * 1000 / fps);
    expect(confirmedPose(snapshot, 0, 2000).x).toBe(1);
  }
  expect(JSON.stringify(snapshot)).toBe(original);
});
it('rejects teleport segments and inconsistent logical clocks at the response boundary', () => {
  expect(robotSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(robotSnapshotSchema.safeParse({ ...snapshot, to: { x: 2, z: 0 } }).success).toBe(false);
  expect(robotSnapshotSchema.safeParse({ ...snapshot, logicalTimeMs: 1 }).success).toBe(false);
});
