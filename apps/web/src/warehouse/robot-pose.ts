import type { RobotSnapshot } from '@warehouse-twin/contracts';

// Only interpolate the last confirmed segment. Never extrapolate toward an unconfirmed cell.
export function confirmedPose(snapshot: RobotSnapshot, receivedAt: number, now: number) {
  const age = Math.max(0, now - receivedAt);
  const fraction = Math.min(1, age / snapshot.tickMs);
  return { x: snapshot.from.x + (snapshot.to.x - snapshot.from.x) * fraction,
    z: snapshot.from.z + (snapshot.to.z - snapshot.from.z) * fraction,
    stale: age > 1500 && snapshot.phase !== 'COMPLETED',
    angle: { N: Math.PI, E: Math.PI / 2, S: 0, W: -Math.PI / 2 }[snapshot.direction] };
}
