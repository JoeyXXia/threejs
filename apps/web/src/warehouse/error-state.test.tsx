import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it } from 'vitest';
import { WarehouseView } from './WarehouseView';
import { fixtureSnapshot } from './test-fixtures';
import { warehouseKey } from './data';

it('an error hides a previously cached scene and inventory totals', () => {
  const value = fixtureSnapshot(); const client = new QueryClient();
  const key = warehouseKey('user', value.layout.spaceId, value.layout.warehouseId);
  client.setQueryData(key, value);
  client.getQueryCache().find({ queryKey: key })!.setState({ status: 'error', error: new Error('API offline') });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(WarehouseView, {
    userId: 'user', spaceId: value.layout.spaceId, warehouseId: value.layout.warehouseId, name: 'fixture', onUnauthorized: () => {},
  })));
  expect(html).toContain('role="alert"'); expect(html).toContain('API offline');
  expect(html).not.toContain('库存汇总'); expect(html).not.toContain('三维仓库'); client.clear();
});
