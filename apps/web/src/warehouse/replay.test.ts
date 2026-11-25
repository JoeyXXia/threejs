import { expect, it } from 'vitest';
import type { HistoryPage, ReplayFrame } from '@warehouse-twin/contracts';
import { buildTimeline, IncompleteReplay, replaySeek, replayStep } from './replay-data';
import { createReplayStore, replayInterval } from './replay-store';
import { fixtureId } from './test-fixtures';

const scope = { spaceId: fixtureId(1), warehouseId: fixtureId(2) };
const time = '2026-11-24T00:00:00.000Z';
const navigation = { revision: 1, closed: [{ x: 3, z: 2 }] };
const resource = { id: 'aisle', kind: 'AISLE' as const, ownerId: null, cells: [{ x: 4, z: 1 }] };
function frame(seq: number, tick: number, layoutVersion: number, anchor: boolean): ReplayFrame {
  return {
    seq, tick, layoutId: fixtureId(layoutVersion + 3), layoutVersion, anchor, mode: 'FLEET', capturedAt: time,
    state: { format: 1, inventory: { onHand: 62, reserved: tick, available: 55 - tick, hold: 7 },
      robots: [
        { id: 'robot-1', cell: { x: tick, z: 1 }, from: { x: tick - 1, z: 1 }, phase: 'TRANSPORT',
          battery: 9990, taskId: fixtureId(8), ledgerTaskId: fixtureId(9), carrying: true, fault: false, charging: false, waitReason: null },
        { id: 'robot-2', cell: { x: 0, z: 1 }, from: { x: 0, z: 1 }, phase: 'IDLE',
          battery: 10000, taskId: null, ledgerTaskId: null, carrying: false, fault: false, charging: false, waitReason: null },
      ],
      owners: seq === 6 ? [{ id: resource.id, ownerId: 'robot-1' }] : [],
      ...(anchor ? { definition: { navigation: { revision: 0, closed: [] }, resources: [] } } : {}),
    },
  };
}
const ev = (seq: number, tick: number, kind: string, payload: unknown = null) =>
  ({ seq, tick, version: seq, epoch: 1, kind, payload, createdAt: time });
function fixture(): HistoryPage[] {
  const base = frame(1, 1, 1, true);
  const common = { ...scope, baseline: base, first: 1, through: 6 };
  return [
    { ...common, nextAfter: 3, frames: [frame(3, 2, 1, false)],
      events: [ev(2, 1, 'FLEET_NAVIGATION_CHANGED', { navigation }), ev(3, 2, 'FLEET_TICK')] },
    { ...common, nextAfter: null, frames: [frame(4, 3, 2, true), frame(6, 4, 2, false)],
      events: [ev(4, 3, 'FLEET_TICK'), ev(5, 3, 'FLEET_RESOURCES_CONFIGURED', { resources: [resource] }), ev(6, 4, 'FLEET_TICK')] },
  ];
}

it('sequential replay and seek produce the same stock, vehicle positions and topology across anchors', () => {
  const timeline = buildTimeline(fixture(), scope.spaceId, scope.warehouseId)!;
  let sequential = replaySeek(timeline, 0);
  for (let i = 1; i < timeline.frames.length; i++) {
    sequential = replayStep(timeline, sequential, i);
    expect(sequential).toEqual(replaySeek(timeline, i));
  }
  expect(replaySeek(timeline, 1).navigation).toEqual(navigation);
  expect(sequential.frame.layoutVersion).toBe(2);
  expect(sequential.navigation.closed).toEqual([]);
  expect(sequential.resources[0]?.ownerId).toBe('robot-1');
  expect(sequential.frame.state.robots).toHaveLength(2);
});

it('starts at the target frame while still rebuilding from an earlier baseline', () => {
  const timeline = buildTimeline(fixture().map((p) => ({ ...p, first: 3 })), scope.spaceId, scope.warehouseId)!;
  const player = createReplayStore(timeline).getState();
  expect(player.index).toBe(1);
  expect(player.state.navigation).toEqual(navigation);
});

it('rejects dropped, duplicated, cross-warehouse or unpinned pages', () => {
  const build = (pages: HistoryPage[]) => buildTimeline(pages, scope.spaceId, scope.warehouseId);
  expect(() => build(fixture().slice(0, 1))).toThrow(IncompleteReplay);
  for (const broken of [
    (p: HistoryPage) => ({ ...p, through: 7 }),
    (p: HistoryPage) => ({ ...p, warehouseId: fixtureId(22) }),
    (p: HistoryPage) => ({ ...p, frames: [] }),
    (p: HistoryPage) => ({ ...p, events: [p.events[0]!, p.events[0]!, p.events[2]!] }),
    (p: HistoryPage) => ({ ...p, frames: [frame(4, 3, 2, false), p.frames[1]!] }),
  ]) {
    const [first, second] = fixture();
    expect(() => build([first!, broken(second!)])).toThrow(IncompleteReplay);
  }
});

it('fails closed on incompatible dynamic layout events', () => {
  const pages = fixture();
  pages[0]!.events[0] = ev(2, 1, 'FLEET_NAVIGATION_CHANGED', { navigation: { revision: -1, closed: [] } });
  const timeline = buildTimeline(pages, scope.spaceId, scope.warehouseId)!;
  expect(() => replaySeek(timeline, 1)).toThrow(IncompleteReplay);
});

it('represents a valid empty history separately from an incomplete one', () => {
  expect(buildTimeline([{ ...scope, first: null, through: null, baseline: null, events: [], frames: [], nextAfter: null }], scope.spaceId, scope.warehouseId)).toBeNull();
});

it('keeps a scope-local player with pause, speed, highlight and deterministic seek', () => {
  const timeline = buildTimeline(fixture(), scope.spaceId, scope.warehouseId)!;
  const player = createReplayStore(timeline), other = createReplayStore(timeline);
  player.getState().advance();
  expect(player.getState().index).toBe(0);
  player.getState().setSpeed(2); player.getState().setTask(fixtureId(8)); player.getState().toggle();
  player.getState().advance();
  expect(player.getState().index).toBe(1);
  player.getState().seek(3);
  expect(player.getState().playing).toBe(false);
  expect(player.getState().state).toEqual(replaySeek(timeline, 3));
  expect(other.getState()).toMatchObject({ index: 0, speed: 1, task: '' });
  expect(([0.5, 1, 2] as const).map(replayInterval)).toEqual([500, 250, 125]);
});
