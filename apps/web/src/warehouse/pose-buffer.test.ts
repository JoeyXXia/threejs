import { expect, it } from 'vitest';
import { realtimeSnapshotSchema, type TelemetryPose } from '@warehouse-twin/contracts';
import { PoseBuffer, poseMatches } from './pose-buffer';
import { fixtureId, fixtureSnapshot } from './test-fixtures';

const boundary = () => {
  const snapshot = fixtureSnapshot();
  snapshot.inventory.watermark = 10;
  const scope = { spaceId: fixtureId(1), warehouseId: fixtureId(2), role: 'ADMIN', watermark: 10, epoch: 2, stateVersion: 10 };
  const point = { x: 1, z: 1 };
  return realtimeSnapshotSchema.parse({ ...snapshot, watermark: 10,
    simulation: { ...scope, runtime: null, allocations: [], staging: [] },
    fleet: { ...scope, enabled: true, tick: 5, layoutId: fixtureId(3), layoutVersion: 1,
      robots: Array.from({ length: 3 }, (_, i) => ({ id: 'robot-' + (i + 1), taskId: null, ledgerTaskId: null,
        phase: 'IDLE', from: point, to: { x: point.x + i, z: 1 }, battery: 10000, carrying: false,
        route: [], waitTicks: 0, totalWaitTicks: 0, waitReason: null, blockerId: null, error: null }))
        .map((r) => ({ ...r, from: r.to })) },
  });
};
const pose = (seq: number, tick: number): TelemetryPose => ({ seq, tick, epoch: 2, layoutId: fixtureId(3), layoutVersion: 1, mode: 'FLEET',
  revision: 0, robots: boundary().fleet.robots.map(({ id, taskId, from, to }) => ({ id, taskId, from, to })) });

it('coalesces to one slot and snaps rather than interpolating across skipped ticks', () => {
  const buffer = new PoseBuffer(), base = boundary();
  expect(buffer.offer(pose(11, 6), base, 1)).toBe(true);
  expect(buffer.read()?.snap).toBe(false);
  expect(buffer.offer(pose(15, 10), base, 2)).toBe(true);
  expect(buffer.read()?.snap).toBe(true);
  for (let n = 16; n < 400; n++) expect(buffer.offer(pose(n, n - 5), base, n)).toBe(true);
  expect(buffer.size).toBe(1);
  expect(buffer.read()?.pose.seq).toBe(399);
});
it('rejects older sequences, wrong epoch/layout/revision and impossible task or movement', () => {
  const buffer = new PoseBuffer(), base = boundary();
  buffer.offer(pose(11, 6), base, 1);
  const next = pose(12, 7);
  for (const invalid of [pose(10, 5), { ...next, epoch: 1 }, { ...next, epoch: 3 }, { ...next, revision: 1 },
    { ...next, layoutId: fixtureId(25) },
    { ...next, robots: next.robots.map((r) => ({ ...r, taskId: fixtureId(30) })) },
    { ...next, robots: next.robots.map((r) => ({ ...r, from: { x: 8, z: 4 } })) }]) expect(buffer.offer(invalid, base, 2)).toBe(false);
  expect(buffer.read()?.pose.seq).toBe(11);
  expect(poseMatches(pose(11, 6), base.layout.layoutVersion, 2, 6, 0, 12)).toBe(false);
});
it('cleans up each visual subscriber across repeated mount/unmount and clears retained data', () => {
  const buffer = new PoseBuffer(), base = boundary();
  let deliveries = 0;
  const listen = () => { deliveries++; };
  for (let n = 0; n < 12; n++) {
    const remove = buffer.subscribe(listen);
    expect(buffer.listenerCount).toBe(1);
    remove();
    expect(buffer.listenerCount).toBe(0);
  }
  const dispose = buffer.subscribe(listen);
  buffer.offer(pose(11, 6), base, 1);
  dispose();
  buffer.clear();
  expect(buffer.size).toBe(0);
  expect(deliveries).toBe(1);
});
