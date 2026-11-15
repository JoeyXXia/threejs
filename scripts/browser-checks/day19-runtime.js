async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  if (await page.getByRole('textbox', { name: '密码', exact: true }).isVisible()) {
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const read = async (path) => { const r = await page.request.get(`${base}/${path}`); if (!r.ok()) throw new Error(`Read failed ${path}`); return r.json(); };
  const write = async (path, data) => { const r = await page.request.post(`${base}/${path}`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data }); if (!r.ok()) throw new Error(`Write failed ${path}`); return r.json(); };
  const options = await read('outbound-orders');
  const sku = options.skus.find((s) => s.code === 'SKU-A');
  const batch = options.recommendations.find((r) => r.skuId === sku.id);
  const order = await write('outbound-orders', { key: `day19-create-${Date.now()}`, skuId: sku.id, batchId: batch.batchId, quantity: 1, reason: 'Day19 browser' });
  const allocated = await write(`outbound-orders/${order.id}/allocate`, { key: `day19-allocate-${Date.now()}`, reason: 'Day19 browser' });
  const allocationId = allocated.allocations[0].id;
  await page.getByRole('combobox', { name: '运输分配', exact: true }).locator(`option[value="${allocationId}"]`).waitFor({ state: 'attached' });
  await page.getByRole('combobox', { name: '运输分配', exact: true }).selectOption(allocationId);
  const staging = (await read('simulation')).staging[0];
  await page.getByRole('combobox', { name: '出库暂存位', exact: true }).selectOption(staging.id);
  await page.getByRole('button', { name: '启动单车搬运', exact: true }).click();
  await page.getByTestId('robot-status').filter({ hasText: 'COMPLETED' }).waitFor({ timeout: 30000 });
  const before = await read('simulation');
  await page.reload();
  await page.getByTestId('robot-status').filter({ hasText: before.runtime.taskId }).waitFor();
  await page.getByText(`已提交事件水位 ${before.watermark} · epoch ${before.epoch} · 状态版本 ${before.stateVersion}`, { exact: true }).waitFor();
  await page.waitForFunction((id) => {
    const canvas = document.querySelector('canvas');
    return canvas?.dataset.robotTask === id && canvas.dataset.cameraTransition === 'idle';
  }, before.runtime.taskId);
  const after = await read('simulation'), inventory = await read('inventory'), events = await read('simulation/events?after=0');
  if (after.runtime.tick !== before.runtime.tick || after.runtime.taskId !== before.runtime.taskId) throw new Error('Reload changed checkpoint');
  if (events.hasMore || events.watermark !== after.watermark || inventory.watermark !== after.watermark) throw new Error('Snapshot/event watermark mismatch');
  if (events.events.some((e, i) => e.seq !== i + 1)) throw new Error('Event stream has holes or duplicates');
  const last = events.events.at(-1);
  if (last.payload.taskId !== after.runtime.taskId || last.payload.tick !== after.runtime.tick) throw new Error('Last event differs from persisted pose');
  if (inventory.summary.onHand !== 62 || inventory.summary.reserved !== 1) throw new Error('Transport changed total stock');
  await page.screenshot({ path: 'output/playwright/day-19/day-19-runtime.png', fullPage: true });
  return { passed: true, taskId: after.runtime.taskId, tick: after.runtime.tick, epoch: after.epoch,
    watermark: after.watermark, events: events.events.length, reloadPreserved: true, stock: inventory.summary };
}
