import { afterEach, expect, it, vi } from 'vitest';
import { createOutboundSchema, outboundOrderSchema } from '@warehouse-twin/contracts';
import { commandAttempts, loadOutbound, outboundKey } from './data';
import { fixtureId } from '../warehouse/test-fixtures';
afterEach(() => vi.unstubAllGlobals());
it('rejects zero, fractions and client-supplied availability or identity', () => {
  const body = { key: 'request-key', skuId: fixtureId(1), batchId: fixtureId(2), quantity: 3, reason: 'test' };
  expect(createOutboundSchema.safeParse(body).success).toBe(true);
  for (const invalid of [{ ...body, quantity: 0 }, { ...body, quantity: 1.5 }, { ...body, available: 999 }, { ...body, actorId: fixtureId(3) }]) expect(createOutboundSchema.safeParse(invalid).success).toBe(false);
});
it('keeps keys scoped and reuses a key for an uncertain allocation', () => {
  expect(outboundKey('u1', 's', 'w')).not.toEqual(outboundKey('u2', 's', 'w'));
  expect(outboundKey('u', 's', 'w1')).not.toEqual(outboundKey('u', 's', 'w2'));
  let next = 0; const attempts = commandAttempts(() => String(++next));
  expect(attempts.forRequest('/order/allocate', { reason: 'same' })).toBe('1');
  expect(attempts.forRequest('/order/allocate', { reason: 'same' })).toBe('1');
  expect(attempts.forRequest('/other/allocate', { reason: 'same' })).toBe('2');
});
it('rejects a valid response from a different warehouse', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ spaceId: fixtureId(1), warehouseId: fixtureId(9), role: 'VIEWER', asOf: '2026-01-01T00:00:00.000Z', skus: [], recommendations: [], orders: [], hasMore: false }))));
  await expect(loadOutbound(fixtureId(1), fixtureId(2), new AbortController().signal)).rejects.toThrow('归属');
});
it('rejects allocated orders without complete per-balance quantity records', () => {
  const order = { id: fixtureId(1), spaceId: fixtureId(2), warehouseId: fixtureId(3), skuId: fixtureId(4), skuCode: 'A', batchId: fixtureId(5), batchCode: 'B', expiresAt: null,
    quantity: 3, status: 'ALLOCATED', version: 1, reason: 'create', allocationReason: 'allocate', createdById: fixtureId(6), allocatedById: fixtureId(6), createdAt: '2026-01-01T00:00:00.000Z', allocatedAt: '2026-01-01T00:00:00.000Z', allocations: [] };
  expect(outboundOrderSchema.safeParse(order).success).toBe(false);
  const allocation = { id: fixtureId(7), balanceId: fixtureId(8), locationId: fixtureId(9), locationCode: 'L', quantity: 3 };
  expect(outboundOrderSchema.safeParse({ ...order, allocations: [allocation] }).success).toBe(true);
  expect(outboundOrderSchema.safeParse({ ...order, allocations: [allocation, { ...allocation, id: fixtureId(10) }] }).success).toBe(false);
});
