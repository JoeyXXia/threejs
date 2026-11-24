// Sequence is warehouse-local. It orders notifications, not speculative stock or pose deltas.
export class EventCursor {
  private pending = new Set<number>();
  constructor(public after: number) {}
  get hasGap() { return this.pending.size > 0; }
  ingest(events: readonly { seq: number }[]) {
    for (const { seq } of events) if (seq > this.after) this.pending.add(seq);
    this.drain();
    return this.pending.size <= 200;
  }
  cover(watermark: number) {
    this.after = Math.max(this.after, watermark);
    for (const seq of this.pending) if (seq <= this.after) this.pending.delete(seq);
    this.drain();
  }
  private drain() {
    while (this.pending.delete(this.after + 1)) this.after++;
  }
}

type Boundary = { watermark: number; fleet: { epoch: number; stateVersion: number; tick: number } };
export function acceptsSnapshot(current: Boundary | undefined, candidate: Boundary, minimum: number) {
  return candidate.watermark >= minimum && (!current || (
    candidate.watermark >= current.watermark
    && candidate.fleet.stateVersion >= current.fleet.stateVersion
    && candidate.fleet.epoch >= current.fleet.epoch
    && candidate.fleet.tick >= current.fleet.tick
  ));
}
