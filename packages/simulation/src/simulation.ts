export type Cell = Readonly<{ x: number; z: number }>;
export type SimulationMap = Readonly<{
  layoutId: string; version: number; width: number; depth: number; blocked: readonly Cell[];
}>;
export type Direction = 'N' | 'E' | 'S' | 'W';
export type Robot = Readonly<{
  id: string; position: Cell; direction: Direction;
  status: 'IDLE' | 'MOVING' | 'DEPLETED';
  battery: number; path: readonly Cell[]; next: number;
}>;
export type SimulationState = Readonly<{
  schemaVersion: 1; seed: number; randomState: number; map: SimulationMap;
  tickMs: number; tick: number; logicalTimeMs: number; paused: boolean; robot: Robot;
}>;
export type Command =
  | Readonly<{ type: 'pause' | 'resume' }>
  | Readonly<{ type: 'route'; layoutId: string; layoutVersion: number; path: readonly Cell[] }>;

function integer(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(name);
}

function validCell(map: SimulationMap, point: Cell) {
  return Number.isInteger(point.x) && Number.isInteger(point.z)
    && point.x >= 0 && point.z >= 0 && point.x < map.width && point.z < map.depth;
}

const same = (a: Cell, b: Cell) => a.x === b.x && a.z === b.z;
const key = (p: Cell) => p.z + ':' + p.x;

// Mulberry32: explicit uint32 state; no global entropy or wall clock.
export function nextRandom(state: number): Readonly<{ state: number; value: number }> {
  integer(state, 0, 0xffffffff, 'random state must be uint32');
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(next ^ (next >>> 15), next | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

export function createSimulation(input: {
  map: SimulationMap; seed: number; position: Cell; robotId?: string; battery?: number; tickMs?: number;
}): SimulationState {
  const { map, seed, position } = input;
  integer(seed, 0, 0xffffffff, 'seed must be uint32');
  integer(map.width, 1, 512, 'width');
  integer(map.depth, 1, 512, 'depth');
  integer(map.version, 1, Number.MAX_SAFE_INTEGER, 'layout version');
  if (!map.layoutId || map.width * map.depth > 65536 || map.blocked.length > 65536) throw new RangeError('layout');
  if (map.blocked.some((point) => !validCell(map, point))) throw new RangeError('blocked cell');
  if (!validCell(map, position) || map.blocked.some((point) => same(point, position))) throw new RangeError('initial cell');
  const tickMs = input.tickMs ?? 250;
  integer(tickMs, 1, 1000, 'tickMs');
  const random = nextRandom(seed);
  // Only the default initial battery uses seeded randomness; movement consumes no entropy.
  const battery = input.battery ?? 9000 + Math.floor(random.value * 1001);
  integer(battery, 0, 10000, 'battery basis points');
  const id = input.robotId ?? 'sim-robot-1';
  if (!id.trim()) throw new RangeError('robot id');
  const copiedMap = Object.freeze({ ...map, blocked: Object.freeze(map.blocked.map((point) => Object.freeze({ ...point }))) });
  return Object.freeze({
    schemaVersion: 1, seed, randomState: random.state, map: copiedMap,
    tickMs, tick: 0, logicalTimeMs: 0, paused: false,
    robot: Object.freeze({ id, position: Object.freeze({ ...position }), direction: 'N',
      status: battery === 0 ? 'DEPLETED' : 'IDLE', battery, path: Object.freeze([]), next: 0 }),
  });
}

export function applyCommand(state: SimulationState, command: Command): SimulationState {
  switch (command.type) {
    case 'pause': return Object.freeze({ ...state, paused: true });
    case 'resume': return Object.freeze({ ...state, paused: false });
    case 'route': {
      if (command.layoutId !== state.map.layoutId || command.layoutVersion !== state.map.version) throw new Error('stale layout');
      if (state.robot.status === 'MOVING') throw new Error('robot busy');
      if (state.robot.battery === 0) throw new Error('battery depleted');
      const { path } = command;
      if (!path.length || path.length > 65536 || !same(path[0]!, state.robot.position)) throw new RangeError('path start/length');
      const blocked = new Set(state.map.blocked.map(key));
      for (let i = 0; i < path.length; i++) {
        const point = path[i]!;
        if (!validCell(state.map, point) || blocked.has(key(point))) throw new RangeError('path blocked/outside');
        const prev = path[i - 1];
        if (prev && Math.abs(point.x - prev.x) + Math.abs(point.z - prev.z) !== 1) throw new RangeError('path must be four-neighbor');
      }
      return Object.freeze({ ...state, robot: Object.freeze({ ...state.robot,
        path: Object.freeze(path.map((point) => Object.freeze({ ...point }))), next: 1,
        status: path.length === 1 ? 'IDLE' : 'MOVING',
      }) });
    }
    default: throw new Error('unknown command');
  }
}

export function step(state: SimulationState): SimulationState {
  if (state.paused) return state;
  integer(state.logicalTimeMs + state.tickMs, 0, Number.MAX_SAFE_INTEGER, 'logical clock overflow');
  let robot = state.robot;
  if (robot.status === 'MOVING') {
    const position = robot.path[robot.next]!;
    const dx = position.x - robot.position.x;
    const dz = position.z - robot.position.z;
    const direction: Direction = dx > 0 ? 'E' : dx < 0 ? 'W' : dz > 0 ? 'S' : 'N';
    const battery = robot.battery - 1;
    const next = robot.next + 1;
    robot = Object.freeze({ ...robot, position, direction, battery, next,
      status: battery === 0 ? 'DEPLETED' : next === robot.path.length ? 'IDLE' : 'MOVING' });
  }
  return Object.freeze({ ...state, tick: state.tick + 1, logicalTimeMs: state.logicalTimeMs + state.tickMs, robot });
}

// Versioned canonical summary. Diagnostic identity, not a cryptographic signature.
export function stateSummary(state: SimulationState): string {
  const canonical = JSON.stringify([
    state.schemaVersion, state.seed, state.randomState,
    state.map.layoutId, state.map.version, state.map.width, state.map.depth,
    [...new Set(state.map.blocked.map(key))].sort(), state.tickMs, state.tick, state.logicalTimeMs, state.paused,
    state.robot.id, state.robot.position.x, state.robot.position.z, state.robot.direction,
    state.robot.status, state.robot.battery, state.robot.path.map(({ x, z }) => [x, z]), state.robot.next,
  ]);
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i++) hash = Math.imul(hash ^ canonical.charCodeAt(i), 16777619) >>> 0;
  return 'sim1-' + hash.toString(16).padStart(8, '0');
}

// The caller owns the one external clock. This adapter never starts a timer.
export function createFixedStepRunner(initial: SimulationState, maxStepsPerAdvance = 8) {
  integer(maxStepsPerAdvance, 1, 1000, 'step budget');
  let state = initial;
  let remainderMs = 0;
  return {
    getState: () => state,
    command(command: Command) {
      const next = applyCommand(state, command);
      // Only a real pause transition discards partial time; duplicate resume is harmless.
      if (next.paused !== state.paused) remainderMs = 0;
      state = next;
      return state;
    },
    advance(elapsedMs: number) {
      // Integer milliseconds avoid float partition drift at a tick boundary.
      integer(elapsedMs, 0, 3600000, 'elapsedMs');
      if (state.paused) {
        remainderMs = 0;
        return { state, steps: 0, remainderMs, droppedMs: 0, lag: false };
      }
      const total = remainderMs + elapsedMs;
      const due = Math.floor(total / state.tickMs);
      const steps = Math.min(due, maxStepsPerAdvance);
      // Do not leave an unbounded queue of historical ticks after a slow callback.
      const droppedMs = (due - steps) * state.tickMs;
      remainderMs = total % state.tickMs;
      for (let i = 0; i < steps; i++) state = step(state);
      return { state, steps, remainderMs, droppedMs, lag: droppedMs > 0 };
    },
  };
}
