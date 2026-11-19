import { expect, it } from 'vitest';
import { fleetResponseSchema } from '@warehouse-twin/contracts';
import { fleetKey } from './fleet-data';
import { fixtureId } from './test-fixtures';

const sample = () => ({ spaceId: fixtureId(1), warehouseId: fixtureId(2), role: 'ADMIN', enabled: true,
  tick: 0, watermark: 1, stateVersion: 1, epoch: 0, layoutId: fixtureId(3), layoutVersion: 1,
  robots: Array.from({ length: 3 }, (_, i) => ({ id: `robot-${i + 1}`, taskId: null as string | null, ledgerTaskId: null as string | null,
    phase: 'IDLE', from: { x: i * 2, z: 0 }, to: { x: i * 2, z: 0 }, battery: 10000, carrying: false,
    route: [], waitTicks: 0, totalWaitTicks: 0, waitReason: null, blockerId: null, error: null })) });

it('accepts an idle persistent fleet and rejects duplicate cells, vehicle ids or task ownership', () => {
  expect(fleetResponseSchema.safeParse(sample()).success).toBe(true);
  for (const kind of ['cell', 'robot', 'task']) {
    const data = sample();
    if (kind === 'cell') data.robots[1]!.to = data.robots[0]!.to;
    else if (kind === 'robot') data.robots[1]!.id = data.robots[0]!.id;
    else for (const r of data.robots.slice(0, 2)) { r.taskId = fixtureId(4); r.ledgerTaskId = fixtureId(5); r.phase = 'APPROACH'; }
    expect(fleetResponseSchema.safeParse(data).success).toBe(false);
  }
});
it('rejects unconfirmed jumps, impossible cargo and disabled fleets retaining vehicles', () => {
  const jump = sample(); jump.robots[0]!.to.x = 4;
  expect(fleetResponseSchema.safeParse(jump).success).toBe(false);
  const cargo = sample(); cargo.robots[0]!.carrying = true;
  expect(fleetResponseSchema.safeParse(cargo).success).toBe(false);
  expect(fleetResponseSchema.safeParse({ ...sample(), enabled: false }).success).toBe(false);
  expect(fleetResponseSchema.safeParse({ ...sample(), robots: [] }).success).toBe(false);
});
it('isolates fleet caches by authenticated user, space and warehouse', () => {
  expect(fleetKey('u1', 's1', 'w1')).not.toEqual(fleetKey('u2', 's1', 'w1'));
  expect(fleetKey('u1', 's1', 'w1')).not.toEqual(fleetKey('u1', 's2', 'w1'));
  expect(fleetKey('u1', 's1', 'w1')).not.toEqual(fleetKey('u1', 's1', 'w2'));
});
it('checks resource occupancy/owners, overlap and historical blocking identity without requiring a current owner', () => {
  const data = { ...sample(), resources: [{ id: 'park', kind: 'PARKING', cells: [{ x: 0, z: 0 }], ownerId: 'robot-1' }] };
  expect(fleetResponseSchema.safeParse(data).success).toBe(true);
  expect(fleetResponseSchema.safeParse({ ...data, resources: [{ ...data.resources[0], ownerId: null }] }).success).toBe(false);
  expect(fleetResponseSchema.safeParse({ ...data, resources: [...data.resources, ...data.resources] }).success).toBe(false);
  const waiting = { ...sample(), resources: [{ id: 'aisle', kind: 'AISLE', cells: [{ x: 6, z: 0 }], ownerId: null }] };
  const robots = waiting.robots.map((r, i) => i === 1 ? { ...r, waitReason: 'RESOURCE_BUSY', resourceWaitId: 'aisle', blockerId: 'robot-1' } : r);
  expect(fleetResponseSchema.safeParse({ ...waiting, robots }).success).toBe(true);
  expect(fleetResponseSchema.safeParse({ ...waiting, robots: robots.map((r) => ({ ...r, resourceWaitId: 'unknown' })) }).success).toBe(false);
});
it('rejects closed confirmed segments and stale pause alerts while accepting revisioned navigation snapshots', () => {
  const data = { ...sample(), navigation: { revision: 1, closed: [{ x: 6, z: 1 }] } };
  expect(fleetResponseSchema.safeParse(data).success).toBe(true);
  expect(fleetResponseSchema.safeParse({ ...data, navigation: { revision: 1, closed: [{ x: 0, z: 0 }] } }).success).toBe(false);
  expect(fleetResponseSchema.safeParse({ ...data, navigation: { revision: 1, closed: [{ x: 6, z: 1 }, { x: 6, z: 1 }] } }).success).toBe(false);
  expect(fleetResponseSchema.safeParse({ ...data, robots: data.robots.map((r) => ({ ...r, navigationIssue: { revision: 0, reason: 'NO_PATH' } })) }).success).toBe(false);
});
it('keeps device recovery status consistent with cargo and rejects future fault ticks', () => {
  const original = sample();
  const data = { ...original, robots: original.robots.map((r, i) => i ? r : { ...r, deviceFault: { reason: 'fault', sinceTick: 0 }, waitReason: 'DEVICE_FAULT', recoveryStatus: 'PAUSED' }) };
  expect(fleetResponseSchema.safeParse(data).success).toBe(true);
  expect(fleetResponseSchema.safeParse({ ...data, robots: data.robots.map((r) => ({ ...r, recoveryStatus: 'NEEDS_RECOVERY' })) }).success).toBe(false);
  expect(fleetResponseSchema.safeParse({ ...data, robots: data.robots.map((r) => ({ ...r, deviceFault: { reason: 'fault', sinceTick: 1 } })) }).success).toBe(false);
});
