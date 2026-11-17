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
