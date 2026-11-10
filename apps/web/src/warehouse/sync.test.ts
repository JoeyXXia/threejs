import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { outboundKey } from '../outbound/data';
import { warehouseKey } from './data';
import { reconciliationKey, refreshWarehouseViews, wmsKey } from './sync';

it('invalidates current warehouse views and all ledger pages without touching a different user or warehouse', async () => {
  const client = new QueryClient();
  const scope = ['u1', 's1', 'w1'] as const;
  const countKey = ['count-orders', ...scope];
  const current = [countKey, outboundKey(...scope), warehouseKey(...scope), reconciliationKey(...scope),
    [...wmsKey(...scope), ''], [...wmsKey(...scope), 'kind=RECEIPT']];
  const outside = [warehouseKey('u1', 's1', 'w2'), [...wmsKey('u2', 's1', 'w1'), ''], ['inbound-orders', ...scope]];
  for (const key of [...current, ...outside]) client.setQueryData(key, { committed: true });
  await refreshWarehouseViews(client, ...scope, countKey, true);
  for (const key of current) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  for (const key of outside) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  expect(client.getQueryData(warehouseKey(...scope))).toEqual({ committed: true });
  client.clear();
});
