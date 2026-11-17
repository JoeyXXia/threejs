async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  if (await page.getByRole('textbox', { name: '密码', exact: true }).isVisible()) {
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const scene = page.url();
  const [, spaceId, warehouseId] = new URL(scene).pathname.split('/').filter(Boolean);
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const read = async (path) => { const r = await page.request.get(`${base}/${path}`); if (!r.ok()) throw new Error(`Read failed ${path}: ${r.status()}`); return r.json(); };
  const before = await read('inventory'), layout = await read('layout');
  const target = layout.locations.find((l) => l.kind === 'STORAGE' && !before.balances.some((b) => b.locationId === l.id && b.onHand > 0));
  if (!target) throw new Error('Fresh QA fixture requires empty storage');
  const batchCode = `DAY20-${Date.now()}`;
  await page.goto(`${scene}/inbound`);
  const form = page.getByRole('form', { name: '创建入库单', exact: true });
  await form.getByLabel('批次编号', { exact: true }).fill(batchCode);
  await form.getByLabel('数量（件）', { exact: true }).fill('4');
  await form.getByLabel('创建原因', { exact: true }).fill('Day20 browser receipt');
  await form.getByRole('button', { name: '创建入库单', exact: true }).click();
  const article = page.getByRole('article').filter({ hasText: batchCode });
  await article.getByLabel('操作原因', { exact: true }).fill('Day20 receive');
  await article.getByRole('button', { name: '确认全量收货', exact: true }).click();
  await article.getByRole('button', { name: '提交全量质检', exact: true }).waitFor();
  await article.getByLabel('操作原因', { exact: true }).fill('Day20 quality pass');
  await article.getByRole('button', { name: '提交全量质检', exact: true }).click();
  await article.getByRole('heading', { name: `${batchCode} · 质检通过`, exact: true }).waitFor();
  const receipt = (await read('inbound-orders')).orders.find((r) => r.batchCode === batchCode);
  const received = await read('inventory');
  if (received.summary.onHand !== before.summary.onHand + 4) throw new Error('Receipt missing');
  await page.goto(scene);
  await page.getByRole('combobox', { name: '任务类型', exact: true }).selectOption('PUTAWAY');
  await page.getByRole('combobox', { name: '已放行入库单', exact: true }).selectOption(receipt.id);
  await page.getByRole('combobox', { name: '上架储位', exact: true }).selectOption(target.id);
  const putawayResponse = page.waitForResponse((r) => r.url() === `${base}/simulation/start` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '启动单车搬运', exact: true }).click();
  const putaway = await (await putawayResponse).json();
  await page.getByTestId('robot-status').filter({ hasText: putaway.taskId }).filter({ hasText: 'COMPLETED' }).waitFor({ timeout: 45000 });
  const afterPutaway = await read('inventory');
  const stored = afterPutaway.balances.find((b) => b.batch.id === receipt.batchId && b.locationId === target.id && b.quality === 'RELEASED');
  if (stored?.onHand !== 4 || stored.reserved !== 0 || afterPutaway.summary.onHand !== received.summary.onHand) throw new Error('Putaway did not preserve stock/free destination');
  await page.goto(`${scene}/outbound`);
  const outboundForm = page.getByRole('form', { name: '创建出库单', exact: true });
  await outboundForm.getByRole('combobox', { name: '商品 SKU', exact: true }).selectOption(receipt.skuId);
  await outboundForm.getByRole('combobox', { name: '批次（FEFO 推荐顺序）', exact: true }).selectOption(receipt.batchId);
  await outboundForm.getByLabel('数量（件）', { exact: true }).fill('4');
  await outboundForm.getByLabel('创建原因', { exact: true }).fill('Day20 outbound');
  await outboundForm.getByRole('button', { name: '创建出库单', exact: true }).click();
  const orderArticle = page.getByRole('article').filter({ hasText: batchCode });
  await orderArticle.getByLabel('预占原因', { exact: true }).fill('Day20 allocation');
  await orderArticle.getByRole('button', { name: '确认全量预占', exact: true }).click();
  await orderArticle.getByRole('button', { name: '确认发运（扣减现存）', exact: true }).waitFor();
  const order = (await read('outbound-orders')).orders.find((o) => o.batchId === receipt.batchId);
  const premature = await page.request.post(`${base}/outbound-orders/${order.id}/dispatch`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data: { key: `day20-too-early-${Date.now()}`, reason: 'must reject' } });
  if (premature.status() !== 409) throw new Error('Shipment before staging was not rejected');
  await page.goto(scene);
  await page.getByRole('combobox', { name: '运输分配', exact: true }).selectOption(order.allocations[0].id);
  const staging = (await read('simulation')).staging[0];
  await page.getByRole('combobox', { name: '出库暂存位', exact: true }).selectOption(staging.id);
  const transportResponse = page.waitForResponse((r) => r.url() === `${base}/simulation/start` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '启动单车搬运', exact: true }).click();
  const transport = await (await transportResponse).json();
  await page.getByTestId('robot-status').filter({ hasText: transport.taskId }).filter({ hasText: 'COMPLETED' }).waitFor({ timeout: 45000 });
  const staged = await read('inventory');
  if (staged.summary.onHand !== received.summary.onHand || staged.summary.reserved !== 4) throw new Error('Staging must not dispatch');
  await page.reload();
  await page.waitForFunction((id) => {
    const canvas = document.querySelector('canvas');
    return canvas?.dataset.robotTask === id && canvas.dataset.cameraTransition === 'idle';
  }, transport.taskId);
  await page.screenshot({ path: 'output/playwright/day-20/day-20-staged.png', fullPage: true });
  await page.goto(`${scene}/outbound`);
  const dispatchForm = page.getByRole('form', { name: `发运 ${order.id}`, exact: true });
  await dispatchForm.getByLabel('发运原因', { exact: true }).fill('Day20 operator confirmed');
  const path = `${base}/outbound-orders/${order.id}/dispatch`;
  const keys = [];
  const record = (request) => { if (request.url() === path && request.method() === 'POST') keys.push(request.postDataJSON().key); };
  page.on('request', record);
  await page.route(path, async (route) => {
    const committed = await route.fetch();
    if (committed.status() !== 201) throw new Error('Shipment did not commit before dropped response');
    await route.abort('failed');
  }, { times: 1 });
  await dispatchForm.getByRole('button', { name: '确认发运（扣减现存）', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '结果不确定' }).waitFor();
  await dispatchForm.getByRole('button', { name: '确认发运（扣减现存）', exact: true }).click();
  await page.getByRole('article').filter({ hasText: batchCode }).getByRole('heading', { name: `${batchCode} · 已发运`, exact: true }).waitFor();
  page.off('request', record);
  if (keys.length !== 2 || keys[0] !== keys[1]) throw new Error('Uncertain shipment retry changed idempotency key');
  const shipped = await read('inventory'), reconciliation = await read('wms/reconcile');
  if (shipped.summary.onHand !== before.summary.onHand || shipped.summary.reserved !== 0 || !reconciliation.consistent) throw new Error('Shipment/reconciliation mismatch');
  await page.screenshot({ path: 'output/playwright/day-20/day-20-dispatched.png', fullPage: true });
  return { passed: true, batchCode, putawayTaskId: putaway.taskId, transportTaskId: transport.taskId,
    orderId: order.id, before: before.summary, received: received.summary, afterPutaway: afterPutaway.summary,
    staged: staged.summary, shipped: shipped.summary, prematureStatus: premature.status(),
    lostResponseRetriedWithSameKey: true, reconciled: reconciliation.consistent, capturedAt: new Date().toISOString() };
}
