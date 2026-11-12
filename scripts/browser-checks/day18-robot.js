async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  if (await page.getByRole('textbox', { name: '密码', exact: true }).isVisible()) {
    // Public credential belongs exclusively to the disposable QA environment.
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const read = async (path) => { const r = await page.request.get(`${base}/${path}`); if (!r.ok()) throw new Error(`Read failed: ${path}`); return r.json(); };
  const write = async (path, data) => { const r = await page.request.post(`${base}/${path}`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data }); if (!r.ok()) throw new Error(`Write failed: ${path} ${r.status()}`); return r.json(); };
  const listing = await read('outbound-orders');
  const sku = listing.skus.find((s) => s.code === 'SKU-A');
  const batch = listing.recommendations.find((r) => r.skuId === sku.id);
  const order = await write('outbound-orders', { key: `day18-create-${Date.now()}`, skuId: sku.id, batchId: batch.batchId, quantity: 1, reason: 'Day18 browser' });
  const allocated = await write(`outbound-orders/${order.id}/allocate`, { key: `day18-reserve-${Date.now()}`, reason: 'Day18 browser' });
  const allocation = allocated.allocations[0];
  const before = await read('inventory');
  await page.getByRole('combobox', { name: '运输分配', exact: true }).locator(`option[value="${allocation.id}"]`).waitFor({ state: 'attached' });
  await page.getByRole('combobox', { name: '运输分配', exact: true }).selectOption(allocation.id);
  const options = await read('simulation');
  await page.getByRole('combobox', { name: '出库暂存位', exact: true }).selectOption(options.staging[0].id);
  const starting = page.waitForResponse((r) => r.url().endsWith('/simulation/start') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '启动单车搬运', exact: true }).click();
  const response = await starting;
  if (response.status() !== 201) throw new Error('Start failed');
  const started = await response.json();
  await page.waitForFunction((id) => document.querySelector('canvas')?.dataset.robotTask === id, started.taskId);
  const preRefresh = (await read('simulation')).runtime;
  await page.reload();
  await page.getByTestId('robot-status').filter({ hasText: started.taskId }).waitFor();
  const afterRefresh = (await read('simulation')).runtime;
  if (afterRefresh.taskId !== started.taskId || afterRefresh.tick < preRefresh.tick) throw new Error('Reload reset the server task');

  // Pause only browser execution, never the server clock; this is not an FPS benchmark.
  const beforeStall = (await read('simulation')).runtime.tick;
  await page.evaluate(() => { const until = performance.now() + 1100; while (performance.now() < until) { /* bounded QA stall */ } });
  const afterStall = (await read('simulation')).runtime.tick;
  if (afterStall <= beforeStall) throw new Error('Backend progress depended on render frames');

  const carryingResponse = await page.waitForResponse(async (r) => r.url().endsWith('/simulation') && r.request().method() === 'GET' && r.status() === 200 && (await r.json()).runtime?.phase === 'TRANSPORT', { timeout: 20000 });
  const carrying = (await carryingResponse.json()).runtime;
  if (!carrying.carrying) throw new Error('Load phase did not confirm cargo');
  await page.locator('canvas').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/day-18/day-18-carrying.png', fullPage: true });
  await page.route('**/api/spaces/**/simulation', (route) => route.fulfill({ status: 503, json: { message: 'QA polling interruption' } }));
  try {
    await page.getByRole('alert').filter({ hasText: '机器人数据陈旧' }).waitFor();
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.robotStale === 'true', null, { timeout: 10000 });
    const stable = await page.locator('canvas').evaluate((c) => ({ x: c.dataset.robotX, z: c.dataset.robotZ, tick: c.dataset.robotTick }));
    // A later rendering frame must remain at the endpoint, not follow the unconfirmed route.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const later = await page.locator('canvas').evaluate((c) => ({ x: c.dataset.robotX, z: c.dataset.robotZ, tick: c.dataset.robotTick }));
    if (JSON.stringify(stable) !== JSON.stringify(later)) throw new Error('Stale pose extrapolated');
    await page.screenshot({ path: 'output/playwright/day-18/day-18-stale.png', fullPage: true });
  } finally { await page.unroute('**/api/spaces/**/simulation'); }
  await page.getByTestId('robot-status').filter({ hasText: 'COMPLETED' }).waitFor({ timeout: 20000 });
  const done = (await read('simulation')).runtime;
  if (done.taskId !== started.taskId || done.carrying) throw new Error('Task identity/cargo mismatch');
  const after = await read('inventory');
  const target = after.locationTotals.find((r) => r.locationId === options.staging[0].id);
  if (after.summary.onHand !== before.summary.onHand || after.summary.reserved !== before.summary.reserved || target.reserved !== 1) throw new Error('Transport stock conservation failed');
  const reconciled = await read('wms/reconcile');
  if (!reconciled.consistent) throw new Error('Reconciliation failed');
  await page.reload();
  await page.getByTestId('robot-status').filter({ hasText: 'COMPLETED' }).waitFor();
  if ((await read('simulation')).runtime.tick !== done.tick) throw new Error('Completed task progressed or reset');
  await page.waitForFunction((id) => {
    const canvas = document.querySelector('canvas');
    return canvas?.dataset.robotTask === id && canvas.dataset.cameraTransition === 'idle';
  }, done.taskId);
  await page.screenshot({ path: 'output/playwright/day-18/day-18-completed.png', fullPage: true });
  await page.getByRole('link', { name: '演示仓库 B VIEWER', exact: true }).click();
  await page.getByTestId('robot-status').filter({ hasText: '暂无运行任务' }).waitFor();
  if (!(await page.getByRole('button', { name: '启动单车搬运', exact: true }).isDisabled())) throw new Error('Viewer can operate robot');
  const denied = await page.request.post('http://127.0.0.1:15174/api/spaces/10000000-0000-4000-8000-000000000002/warehouses/20000000-0000-4000-8000-000000000002/simulation/start', {
    headers: { 'X-Requested-With': 'WarehouseTwin' }, data: { allocationId: allocation.id, stagingLocationId: options.staging[0].id, reason: 'viewer denial' },
  });
  if (denied.status() !== 403) throw new Error('Viewer server request not denied');
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  await page.getByTestId('robot-status').filter({ hasText: done.taskId }).waitFor();
  return { passed: true, taskId: done.taskId, completedTick: done.tick, browserStall: { beforeStall, afterStall },
    reloadPreservedTask: true, staleEndpointHeld: true, readonlyDenied: true, stock: after.summary, reconcile: reconciled.consistent };
}
