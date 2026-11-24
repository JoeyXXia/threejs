import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { WarehouseView } from './WarehouseView';
import { useRealtimeSnapshot } from './useRealtimeSnapshot';

vi.mock('./useRealtimeSnapshot');

it('a denied warehouse hides scene and inventory totals and exposes the denial', () => {
  vi.mocked(useRealtimeSnapshot).mockReturnValue({
    data: undefined, status: 'denied', error: new Error('当前会话没有仓库读取权限。'), updatedAt: 0, retry: () => {},
  });
  const client = new QueryClient();
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(WarehouseView, {
    userId: 'user', spaceId: 'space', warehouseId: 'warehouse', name: 'fixture', onUnauthorized: () => {},
  })));
  expect(html).toContain('role="alert"'); expect(html).toContain('没有仓库读取权限');
  expect(html).not.toContain('库存汇总'); expect(html).not.toContain('三维仓库');
  client.clear();
});
