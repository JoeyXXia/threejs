import type { RealtimeSnapshot, TelemetryPose } from '@warehouse-twin/contracts';

type Entry = { pose: TelemetryPose; at: number; snap: boolean };
type Grid = RealtimeSnapshot['layout']['layoutVersion'];
export const snapshotSampleMs = 1000;

export function poseMatches(pose: TelemetryPose, grid: Grid, epoch: number, tick: number, revision: number, watermark: number) {
  return pose.layoutId === grid.id && pose.layoutVersion === grid.version && pose.epoch === epoch
    && pose.tick >= tick && pose.revision === revision && pose.seq >= watermark;
}

export class PoseBuffer {
  private latest: Entry | undefined;
  private listeners = new Set<() => void>();
  get size() { return Number(this.latest !== undefined); }
  get listenerCount() { return this.listeners.size; }
  read() { return this.latest; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  clear() {
    if (!this.latest) return;
    this.latest = undefined; this.emit();
  }
  private emit() { for (const listener of this.listeners) listener(); }
  offer(pose: TelemetryPose, baseline: RealtimeSnapshot, at: number) {
    const fleet = baseline.fleet.enabled, runtime = baseline.simulation.runtime, grid = baseline.layout.layoutVersion;
    const tick = fleet ? baseline.fleet.tick : runtime?.tick;
    const robots = fleet ? baseline.fleet.robots : runtime ? [{ id: 'robot-1', taskId: runtime.taskId }] : [];
    if (tick === undefined || pose.mode !== (fleet ? 'FLEET' : 'SINGLE')
      || !poseMatches(pose, grid, baseline.fleet.epoch, tick, fleet ? baseline.fleet.navigation.revision : 0, baseline.watermark)
      || pose.robots.length !== robots.length || new Set(pose.robots.map((r) => r.id)).size !== robots.length) return false;
    if (pose.robots.some((r) => !robots.some((b) => b.id === r.id && b.taskId === r.taskId)
      || r.from.x >= grid.width || r.to.x >= grid.width || r.from.z >= grid.depth || r.to.z >= grid.depth
      || Math.abs(r.to.x - r.from.x) + Math.abs(r.to.z - r.from.z) > 1 || (!fleet && !r.direction))) return false;
    const previous = this.latest?.pose;
    if (previous && (pose.epoch < previous.epoch || pose.seq <= previous.seq || pose.tick <= previous.tick)) return false;
    const compatible = previous?.layoutId === pose.layoutId && previous.epoch === pose.epoch && previous.revision === pose.revision;
    const lastTick = compatible ? Math.max(tick, previous.tick) : tick;
    this.latest = { pose, at, snap: pose.tick !== lastTick + 1 };
    this.emit(); return true;
  }
}
