import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, isCancelledError } from '@tanstack/react-query';
import { inventorySchema, layoutSchema, validateSnapshot } from '@warehouse-twin/contracts';
import { loadSnapshot, warehouseKey } from './data';
import { fixtureId, fixtureSnapshot } from './test-fixtures';
import { createSceneStore } from './scene-store';
import { ApiError } from '../api';

afterEach(() => { vi.unstubAllGlobals(); });
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('runtime contracts and paired snapshots', () => {
  it('accepts the API shape and a legitimate zero-stock response', () => {
    const value = fixtureSnapshot();
    expect(validateSnapshot(layoutSchema.parse(value.layout), inventorySchema.parse(value.inventory), value.layout.spaceId, value.layout.warehouseId)).toEqual(value);
    value.inventory.balances = [];
    value.inventory.locationTotals.forEach((row) => { row.onHand = 0; row.available = 0; });
    value.inventory.summary.onHand = 0; value.inventory.summary.available = 0;
    expect(inventorySchema.parse(value.inventory).summary.onHand).toBe(0);
  });
  it('rejects missing inventory rather than making up zeroes', async () => {
    const value = fixtureSnapshot();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/layout') ? value.layout : {})));
    await expect(loadSnapshot(value.layout.spaceId, value.layout.warehouseId, new AbortController().signal)).rejects.toThrow('响应格式');
  });
  it('loads fully reserved transit stock into the warehouse summary without putting it on the layout', async () => {
    const value = fixtureSnapshot();
    const balance = value.inventory.balances[0]!;
    balance.locationId = fixtureId(42);
    balance.transit = true;
    balance.reserved = 5;
    balance.available = 0;
    Object.assign(value.inventory.locationTotals[0]!, { onHand: 0, available: 0 });
    Object.assign(value.inventory.summary, { reserved: 5, available: 0 });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/layout') ? value.layout : value.inventory)));
    const loaded = await loadSnapshot(value.layout.spaceId, value.layout.warehouseId, new AbortController().signal);
    expect(loaded.inventory.summary).toEqual({ onHand: 5, reserved: 5, available: 0, hold: 0 });
    delete balance.transit;
    await expect(loadSnapshot(value.layout.spaceId, value.layout.warehouseId, new AbortController().signal)).rejects.toThrow('库存货位与布局不匹配');
  });
  it('rejects malformed quantities, unknown locations and inconsistent totals', () => {
    const value = fixtureSnapshot();
    value.inventory.balances[0]!.onHand = -1;
    expect(inventorySchema.safeParse(value.inventory).success).toBe(false);
    const next = fixtureSnapshot(); next.inventory.summary.onHand = 99;
    expect(inventorySchema.safeParse(next.inventory).success).toBe(false);
    const missing = fixtureSnapshot(); missing.inventory.locationTotals.pop();
    expect(() => validateSnapshot(missing.layout, missing.inventory, missing.layout.spaceId, missing.layout.warehouseId)).toThrow('location');
  });
  it('rejects duplicate location identity and geometry outside the layout', () => {
    const value = fixtureSnapshot(); value.layout.locations[1]!.id = value.layout.locations[0]!.id;
    expect(layoutSchema.safeParse(value.layout).success).toBe(false);
    const next = fixtureSnapshot(); next.layout.locations[0]!.serviceCell.x = 10;
    expect(layoutSchema.safeParse(next.layout).success).toBe(false);
  });
  it('retries both endpoints once on a version mismatch and never returns a mixed pair', async () => {
    const value = fixtureSnapshot(); let inventoryCalls = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/layout')) return response(value.layout);
      inventoryCalls++;
      return response({ ...value.inventory, layoutId: inventoryCalls === 1 ? fixtureId(99) : value.inventory.layoutId });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await loadSnapshot(value.layout.spaceId, value.layout.warehouseId, new AbortController().signal)).toEqual(value);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('bounds a persistent version mismatch to two pairs', async () => {
    const value = fixtureSnapshot(); value.inventory.layoutVersion = 2;
    const fetcher = vi.fn(async (url: string) => response(url.endsWith('/layout') ? value.layout : value.inventory));
    vi.stubGlobal('fetch', fetcher);
    await expect(loadSnapshot(value.layout.spaceId, value.layout.warehouseId, new AbortController().signal)).rejects.toThrow('布局版本');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('rejects a cross-warehouse response immediately', async () => {
    const value = fixtureSnapshot(); value.layout.warehouseId = fixtureId(77);
    const fetcher = vi.fn(async (url: string) => response(url.endsWith('/layout') ? value.layout : value.inventory));
    vi.stubGlobal('fetch', fetcher);
    await expect(loadSnapshot(value.inventory.spaceId, value.inventory.warehouseId, new AbortController().signal)).rejects.toThrow('归属');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves HTTP authentication errors without hidden retries', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 })); vi.stubGlobal('fetch', fetcher);
    await expect(loadSnapshot(fixtureId(1), fixtureId(2), new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('query and UI ownership', () => {
  it('keys include user, space and warehouse', () => {
    expect(warehouseKey('u1', 's1', 'w1')).not.toEqual(warehouseKey('u2', 's1', 'w1'));
    expect(warehouseKey('u1', 's1', 'w1')).not.toEqual(warehouseKey('u1', 's2', 'w1'));
    expect(warehouseKey('u1', 's1', 'w1')).not.toEqual(warehouseKey('u1', 's1', 'w2'));
  });
  it('query cancellation aborts both HTTP requests and does not cache a late response', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal; signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    const client = new QueryClient(); const key = warehouseKey('u', fixtureId(1), fixtureId(2));
    const pending = client.fetchQuery({ queryKey: key, queryFn: ({ signal }) => loadSnapshot(fixtureId(1), fixtureId(2), signal) }).catch((error: unknown) => error);
    await client.cancelQueries({ queryKey: key });
    expect(isCancelledError(await pending)).toBe(true);
    expect(signals).toHaveLength(2); expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(client.getQueryData(key)).toBeUndefined(); client.clear();
  });
  it('a late old-scope result cannot replace the new-scope cache', async () => {
    const client = new QueryClient(); const a = warehouseKey('u', 'a', 'wa'), b = warehouseKey('u', 'b', 'wb');
    let release!: (value: string) => void;
    const old = client.fetchQuery({ queryKey: a, queryFn: () => new Promise<string>((resolve) => { release = resolve; }) }).catch((error: unknown) => error);
    await client.cancelQueries({ queryKey: a });
    await client.fetchQuery({ queryKey: b, queryFn: async () => 'warehouse-b' });
    release('late-warehouse-a'); await old;
    expect(client.getQueryData(b)).toBe('warehouse-b'); expect(client.getQueryData(a)).toBeUndefined(); client.clear();
  });
  it('per-view Zustand stores isolate UI choices and cannot mutate query inventory', () => {
    const a = createSceneStore(), b = createSceneStore(); const value = fixtureSnapshot();
    const before = structuredClone(value);
    a.getState().selectLocation(fixtureId(6)); a.getState().toggleZones(); a.getState().toggleServiceCells();
    expect(b.getState()).toMatchObject({ selectedLocationId: null, showZones: true, showServiceCells: false });
    expect(value).toEqual(before); expect(a.getState()).not.toHaveProperty('inventory');
  });
});
