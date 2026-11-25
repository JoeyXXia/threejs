import { telemetryPoseSchema } from '@warehouse-twin/contracts';

type Event = { seq: number; tick: number; epoch: number | null; kind: string; payload: unknown };
const isPose = (event: Event) => event.kind === 'FLEET_TICK' || event.kind === 'SIM_TICK';
const record = (value: unknown) => typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

export function projectTelemetry<T extends Event>(page: T[]) {
  const last = page.at(-1);
  const data = record(last?.payload);
  const fleet = last?.kind === 'FLEET_TICK';
  const candidate = last && data && isPose(last) ? telemetryPoseSchema.safeParse({
    seq: last.seq, tick: last.tick, epoch: last.epoch, layoutId: data.layoutId, layoutVersion: data.layoutVersion,
    mode: fleet ? 'FLEET' : 'SINGLE', revision: fleet ? record(data.navigation)?.revision : 0,
    robots: fleet && Array.isArray(data.robots) ? data.robots.map((r: unknown) => {
      const bot = record(r);
      return { id: bot?.id, taskId: bot?.taskId, from: bot?.from, to: bot?.cell };
    }) : fleet ? [] : [{ id: 'robot-1', taskId: data.taskId, from: data.from, to: data.to, direction: data.direction }],
  }) : undefined;
  return {
    events: page.map((event) => {
      if (!isPose(event)) return event;
      const alerts = record(event.payload)?.newAlerts;
      return { ...event, payload: Array.isArray(alerts) && alerts.length ? { newAlerts: alerts } : null };
    }),
    ...(candidate?.success ? { pose: candidate.data } : {}),
  };
}
