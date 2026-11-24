import { expect, it } from 'vitest';
import { acceptsSnapshot, EventCursor } from './realtime-sync';

const events = (...sequence: number[]) => sequence.map((seq) => ({ seq }));
const snapshot = (watermark: number, epoch: number, stateVersion = watermark, tick = watermark) =>
  ({ watermark, fleet: { epoch, stateVersion, tick } });

it('deduplicates and does not skip a missing lower seq', () => {
  const cursor = new EventCursor(7);
  expect(cursor.ingest(events(7, 10, 9, 10))).toBe(true);
  expect(cursor.after).toBe(7);
  expect(cursor.hasGap).toBe(true);
  cursor.ingest(events(8, 8, 9));
  expect(cursor.after).toBe(10);
  expect(cursor.hasGap).toBe(false);
});
it('rebases only through the snapshot watermark and retains later buffered events', () => {
  const cursor = new EventCursor(4);
  cursor.ingest(events(6, 8, 9));
  cursor.cover(7);
  expect(cursor.after).toBe(9);
  expect(cursor.hasGap).toBe(false);
  cursor.cover(6);
  expect(cursor.after).toBe(9);
});
it('bounds unresolved gaps and requires resynchronization on overflow', () => {
  const cursor = new EventCursor(0);
  expect(cursor.ingest(events(...Array.from({ length: 200 }, (_, i) => i + 2)))).toBe(true);
  expect(cursor.ingest(events(202))).toBe(false);
  expect(cursor.after).toBe(0);
});
it('accepts a coherent response at its requested boundary without starving on a newer tick', () => {
  const previous = snapshot(4, 1);
  expect(acceptsSnapshot(previous, snapshot(4, 2), 5)).toBe(false);
  expect(acceptsSnapshot(previous, snapshot(5, 2), 5)).toBe(true);
});
it('never replaces a confirmed position with a regressed epoch, cursor, tick or version', () => {
  const confirmed = snapshot(8, 3, 8, 5);
  for (const old of [snapshot(7, 3, 8, 5), snapshot(9, 2), snapshot(9, 3, 7, 5), snapshot(9, 3, 9, 4)]) {
    expect(acceptsSnapshot(confirmed, old, 7)).toBe(false);
  }
});
