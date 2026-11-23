import { expect, it } from 'vitest';
import { realtimeBatchSchema, robotCheckpointSchema, simulationResponseSchema, warehouseEventsSchema } from '@warehouse-twin/contracts';
import { createRobotTask, createSimulation } from '@warehouse-twin/simulation';
import { fixtureId } from './test-fixtures';

function checkpoint() {
  const map = { layoutId: fixtureId(3), version: 1, width: 3, depth: 3, blocked: [] };
  const path = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
  return { format: 1, actorId: fixtureId(1), taskId: fixtureId(2), allocationId: fixtureId(4), stagingId: fixtureId(5),
    from: path[0], loaded: false, error: null, task: createRobotTask(createSimulation({ map, seed: 0, position: path[0]! }), path, [path[1]!]) };
}
it('validates a versioned JSON checkpoint and rejects an unknown format or impossible tick/cursor', () => {
  const data = checkpoint();
  expect(robotCheckpointSchema.safeParse(JSON.parse(JSON.stringify(data))).success).toBe(true);
  expect(robotCheckpointSchema.safeParse({ ...data, format: 2 }).success).toBe(false);
  const task = { ...data.task, simulation: { ...data.task.simulation, logicalTimeMs: 9 } };
  expect(robotCheckpointSchema.safeParse({ ...data, task }).success).toBe(false);
  task.simulation = { ...data.task.simulation, robot: { ...data.task.simulation.robot, next: 100 } };
  expect(robotCheckpointSchema.safeParse({ ...data, task }).success).toBe(false);
});
it('separates the event watermark and owner epoch from the robot tick', () => {
  const data = { spaceId: fixtureId(1), warehouseId: fixtureId(2), role: 'VIEWER', watermark: 20, epoch: 3,
    stateVersion: 20, runtime: null, allocations: [], staging: [] };
  expect(simulationResponseSchema.safeParse(data).success).toBe(true);
  expect(simulationResponseSchema.safeParse({ ...data, watermark: -1 }).success).toBe(false);
});
it('reads legacy outbound checkpoints and separates putaway receipt identity from allocation identity', () => {
  const old = robotCheckpointSchema.parse(checkpoint());
  expect(old.kind).toBe('OUTBOUND');
  expect(old.inboundOrderId).toBeNull();
  const putaway = { ...checkpoint(), kind: 'PUTAWAY', allocationId: null, inboundOrderId: fixtureId(6) };
  expect(robotCheckpointSchema.safeParse(putaway).success).toBe(true);
  expect(robotCheckpointSchema.safeParse({ ...putaway, inboundOrderId: null }).success).toBe(false);
  expect(robotCheckpointSchema.safeParse({ ...putaway, allocationId: fixtureId(4) }).success).toBe(false);
  expect(robotCheckpointSchema.safeParse({ ...checkpoint(), kind: 'OUTBOUND', allocationId: null }).success).toBe(false);
});
it('requires contiguous ordered events bounded by a committed watermark', () => {
  const data = { spaceId: fixtureId(1), warehouseId: fixtureId(2), after: 3, watermark: 6, hasMore: true,
    events: [{ seq: 4, version: 4, epoch: 1, tick: 2, kind: 'SIM_TICK', payload: {}, createdAt: '2026-11-13T01:00:00.000Z' }] };
  expect(warehouseEventsSchema.safeParse(data).success).toBe(true);
  expect(warehouseEventsSchema.safeParse({ ...data, hasMore: false }).success).toBe(false);
  expect(warehouseEventsSchema.safeParse({ ...data, events: [{ ...data.events[0], seq: 5 }] }).success).toBe(false);
  expect(warehouseEventsSchema.safeParse({ ...data, watermark: 3 }).success).toBe(false);
  expect(warehouseEventsSchema.safeParse({ ...data, events: [data.events[0], data.events[0]] }).success).toBe(false);
});
it('accepts unknown legacy metadata but rejects invalid or missing fields in the realtime envelope', () => {
  const event = { seq: 1, version: null, epoch: null, tick: 0, kind: 'OUTBOUND_CREATE', payload: {}, createdAt: '2026-11-13T01:00:00.000Z' };
  const batch = { spaceId: fixtureId(1), warehouseId: fixtureId(2), events: [event] };
  expect(realtimeBatchSchema.safeParse(batch).success).toBe(true);
  expect(realtimeBatchSchema.safeParse({ ...batch, events: [{ ...event, epoch: -1 }] }).success).toBe(false);
  expect(realtimeBatchSchema.safeParse({ ...batch, events: [{ ...event, version: undefined }] }).success).toBe(false);
});
