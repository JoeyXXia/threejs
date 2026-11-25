import { historyPageSchema, layoutSchema, replayDefinitionSchema, type HistoryPage, type LayoutResponse, type ReplayFrame } from '@warehouse-twin/contracts';
import { api } from '../api';

type Event = HistoryPage['events'][number];
type Definition = NonNullable<ReplayFrame['state']['definition']>;
export type Timeline = { frames: ReplayFrame[]; events: Event[]; first: number; through: number };
export type ReplayState = { frame: ReplayFrame; navigation: Definition['navigation']; resources: Definition['resources'] };
export type ReplayData = { timeline: Timeline; layouts: Record<string, LayoutResponse> };
export class IncompleteReplay extends Error {
  constructor() { super('历史数据不完整或不兼容，未推断库存与位置。请缩小范围或重试。'); }
}
const fail = (): never => { throw new IncompleteReplay(); };
const tickEvent = (e: Event) => e.kind === 'SIM_TICK' || e.kind === 'FLEET_TICK';

export function buildTimeline(pages: HistoryPage[], spaceId: string, warehouseId: string): Timeline | null {
  const initial = pages[0] ?? fail();
  const { baseline, first, through } = initial;
  if (initial.spaceId !== spaceId || initial.warehouseId !== warehouseId) return fail();
  if (!baseline || first === null || through === null) {
    if (baseline === null && first === null && through === null && pages.length === 1
      && !initial.events.length && !initial.frames.length && initial.nextAfter === null) return null;
    return fail();
  }
  if (!baseline.anchor || baseline.seq > first || first > through) return fail();
  const events: Event[] = [], frames: ReplayFrame[] = [baseline];
  let after = baseline.seq;
  for (const [index, page] of pages.entries()) {
    if (page.spaceId !== spaceId || page.warehouseId !== warehouseId || page.first !== first || page.through !== through
      || JSON.stringify(page.baseline) !== JSON.stringify(baseline)) return fail();
    const last = after + page.events.length;
    if (last > through || (after < through && last === after) || page.events.some((e, i) => e.seq !== after + i + 1)
      || page.nextAfter !== (last < through ? last : null) || (page.nextAfter === null && index !== pages.length - 1)) return fail();
    const ticks = page.events.filter(tickEvent);
    if (ticks.length !== page.frames.length) return fail();
    for (const [i, frame] of page.frames.entries()) {
      const event = ticks[i]!, previous = frames.at(-1)!;
      if (frame.seq !== event.seq || frame.tick !== event.tick || frame.tick !== previous.tick + 1
        || frame.mode !== (event.kind === 'FLEET_TICK' ? 'FLEET' : 'SINGLE')
        || (!frame.anchor && (frame.layoutId !== previous.layoutId || frame.mode !== previous.mode || frame.layoutVersion !== previous.layoutVersion))) return fail();
      frames.push(frame);
    }
    events.push(...page.events); after = last;
  }
  const start = frames.findIndex((frame) => frame.seq === first);
  if (after !== through || start < 0) return fail();
  return { frames, events, first: start, through };
}

function anchor(frame: ReplayFrame): ReplayState {
  return { frame, ...(frame.state.definition ?? fail()) };
}

// No planner or live cache is consulted. Apply only recorded changes since the previous frame.
export function replayStep(timeline: Timeline, previous: ReplayState, index: number): ReplayState {
  const frame = timeline.frames[index] ?? fail();
  if (frame.anchor) return anchor(frame);
  let { navigation, resources } = previous;
  const base = timeline.frames[0]!.seq;
  for (const event of timeline.events.slice(previous.frame.seq - base, frame.seq - base)) {
    if (event.kind === 'FLEET_NAVIGATION_CHANGED' || event.kind === 'FLEET_RESOURCES_CONFIGURED') {
      const checked = replayFrameSchemaForDefinition(event, navigation, resources);
      navigation = checked.navigation; resources = checked.resources;
    }
  }
  const owners = new Map(frame.state.owners.map(({ id, ownerId }) => [id, ownerId]));
  if (resources.length !== owners.size || resources.some((r) => !owners.has(r.id))) return fail();
  return { frame, navigation, resources: resources.map((r) => ({ ...r, ownerId: owners.get(r.id) ?? null })) };
}

function replayFrameSchemaForDefinition(event: Event, navigation: Definition['navigation'], resources: Definition['resources']) {
  const payload = event.payload as { navigation?: unknown; resources?: unknown } | null;
  const result = replayDefinitionSchema.safeParse(event.kind === 'FLEET_NAVIGATION_CHANGED'
    ? { navigation: payload?.navigation, resources } : { navigation, resources: payload?.resources });
  return result.success ? result.data : fail();
}

export function replaySeek(timeline: Timeline, index: number): ReplayState {
  let i = index;
  while (i >= 0 && !timeline.frames[i]?.anchor) i--;
  if (i < 0) return fail();
  let state = anchor(timeline.frames[i]!);
  while (i < index) state = replayStep(timeline, state, ++i);
  return state;
}

export async function loadReplay(spaceId: string, warehouseId: string, from: string, to: string, signal: AbortSignal): Promise<ReplayData | null> {
  const path = `/spaces/${spaceId}/warehouses/${warehouseId}/history`;
  const params = new URLSearchParams({ from, to, limit: '100' });
  const pages: HistoryPage[] = [];
  for (let count = 0; count < 16; count++) {
    const result = historyPageSchema.safeParse(await api(path + '?' + params, 'GET', undefined, signal));
    signal.throwIfAborted();
    const page = result.success ? result.data : fail();
    pages.push(page);
    if (page.nextAfter === null) break;
    if (page.through === null || Number(params.get('after')) >= page.nextAfter) return fail();
    params.set('after', String(page.nextAfter)); params.set('through', String(page.through));
  }
  const timeline = buildTimeline(pages, spaceId, warehouseId);
  if (!timeline) return null;
  const ids = [...new Set(timeline.frames.map((f) => f.layoutId))];
  const layouts: Record<string, LayoutResponse> = {};
  for (const id of ids) {
    const result = layoutSchema.safeParse(await api(path + '/layouts/' + id, 'GET', undefined, signal));
    signal.throwIfAborted();
    const layout = result.success ? result.data : fail();
    if (layout.spaceId !== spaceId || layout.warehouseId !== warehouseId || layout.layoutVersion.id !== id) return fail();
    layouts[id] = layout;
  }
  // Preflight the complete loaded segment, so an invalid future frame is never presented as playable.
  let state = replaySeek(timeline, 0);
  for (const [index, frame] of timeline.frames.entries()) {
    if (index) state = replayStep(timeline, state, index);
    const grid = layouts[frame.layoutId]!.layoutVersion;
    const outside = (c: { x: number; z: number }) => c.x >= grid.width || c.z >= grid.depth;
    if (grid.version !== frame.layoutVersion || frame.state.robots.some((r) => outside(r.cell) || outside(r.from))
      || state.navigation.closed.some(outside) || state.resources.some((r) => r.cells.some(outside))) return fail();
  }
  return { timeline, layouts };
}
