import { expect, it, vi, afterEach } from 'vitest';
import { createInboundSchema } from '@warehouse-twin/contracts';
import { commandAttempts, inboundKey, loadInbound } from './data';
import { fixtureId } from '../warehouse/test-fixtures';

afterEach(() => vi.unstubAllGlobals());
it('retains a command key after an uncertain response and replaces it only after success or changed parameters', () => {
  let sequence = 0; const attempts = commandAttempts(() => String(++sequence));
  expect(attempts.forRequest('/receive', { reason: 'same' })).toBe('1');
  expect(attempts.forRequest('/receive', { reason: 'same' })).toBe('1');
  expect(attempts.forRequest('/receive', { reason: 'changed' })).toBe('2');
  attempts.completed();
  expect(attempts.forRequest('/receive', { reason: 'changed' })).toBe('3');
});
it('scopes inbound queries by identity and warehouse', () => {
  expect(inboundKey('u1', 's', 'w')).not.toEqual(inboundKey('u2', 's', 'w'));
  expect(inboundKey('u', 's', 'w1')).not.toEqual(inboundKey('u', 's', 'w2'));
});
it('rejects a valid but wrong-scope list response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ spaceId: fixtureId(1), warehouseId: fixtureId(9), role: 'VIEWER', skus: [], qcLocations: [], orders: [], hasMore: false }))));
  await expect(loadInbound(fixtureId(1), fixtureId(2), new AbortController().signal)).rejects.toThrow('归属');
});
it('rejects zero quantity, unknown actor fields and reversed batch dates before submitting', () => {
  const input = { key: 'request-key', skuId: fixtureId(1), qcLocationId: fixtureId(2), batchCode: 'B', quantity: 1, reason: 'test', producedAt: null, expiresAt: null };
  expect(createInboundSchema.safeParse(input).success).toBe(true);
  for (const invalid of [{ ...input, quantity: 0 }, { ...input, actorId: fixtureId(3) }, { ...input, producedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2024-01-01T00:00:00.000Z' }]) expect(createInboundSchema.safeParse(invalid).success).toBe(false);
});
