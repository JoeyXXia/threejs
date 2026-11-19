import type { FleetState, FleetRobot } from './fleet.js';

export type DeviceFault = Readonly<{ reason: string; sinceTick: number }>;
export function validateRecovery(s: FleetState) {
  for (const r of s.robots) if (r.deviceFault && (!r.simulation.paused || !r.deviceFault.reason.trim() || r.deviceFault.reason.length > 200
    || !Number.isSafeInteger(r.deviceFault.sinceTick) || r.deviceFault.sinceTick < 0 || r.deviceFault.sinceTick > s.tick)) throw new Error('invalid device fault');
}

// Called at a committed tick boundary. No ledger effects or movement are proposed.
export function controlRobot(state: FleetState, robotId: string, action: 'FAULT' | 'REPAIR' | 'CANCEL', reason: string): FleetState {
  validateRecovery(state);
  const robot = state.robots.find((r) => r.id === robotId);
  if (!robot || !reason.trim() || reason.length > 200) throw new Error('invalid recovery command');
  const r = robot, phase = r.work?.phase;
  let changed: FleetRobot;
  if (action === 'FAULT') {
    if (!phase || ['COMPLETED', 'ERROR'].includes(phase) || r.deviceFault || (r.simulation.paused && !r.navigationIssue)) throw new Error('no running task or already paused/faulted');
    changed = { ...r, deviceFault: { reason, sinceTick: state.tick }, simulation: { ...r.simulation, paused: true }, waitReason: 'DEVICE_FAULT', blockerId: null, resourceWaitId: null };
  } else if (action === 'REPAIR') {
    if (!r.deviceFault || phase === 'ERROR' || r.simulation.robot.status === 'DEPLETED') throw new Error('not a repairable injected fault');
    changed = { ...r, deviceFault: null, simulation: { ...r.simulation, paused: !!r.navigationIssue },
      waitTicks: 0, waitReason: r.navigationIssue ? 'ROUTE_BLOCKED' : null, blockerId: null, resourceWaitId: null };
  } else {
    if (!phase || !['APPROACH', 'LOADING'].includes(phase)) throw new Error('only before pickup may cancel');
    const position = r.simulation.robot.position;
    changed = { ...r, work: null, navigationIssue: null, simulation: { ...r.simulation, paused: !!r.deviceFault,
      robot: { ...r.simulation.robot, status: 'IDLE', path: [position], next: 1 } }, waitTicks: 0,
      waitReason: r.deviceFault ? 'DEVICE_FAULT' : null, blockerId: null, resourceWaitId: null };
  }
  const next = { ...state, robots: state.robots.map((r) => r.id === robotId ? changed : r) };
  validateRecovery(next);
  return next;
}
