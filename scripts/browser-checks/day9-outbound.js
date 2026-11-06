async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('link', { name: '演示仓库 A 出库与预占', exact: true }).click();
  await page.getByRole('form', { name: '创建出库单', exact: true }).waitFor();
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const read = async (resource) => { const r = await page.request.get(`${base}/${resource}`); if (!r.ok()) throw new Error('API unavailable'); return r.json(); };
  const before = await read('inventory');
  const beforeList = await read('outbound-orders');
  const sku = beforeList.skus.find((row) => row.code === 'SKU-A');
  const batch = beforeList.recommendations.find((row) => row.skuId === sku.id);
  if (!batch || batch.available < 25) throw new Error('Use a fresh QA database with ordinary seed');
  const create = async (quantity) => {
    const form = page.getByRole('form', { name: '创建出库单', exact: true });
    await form.getByRole('combobox', { name: '商品 SKU', exact: true }).selectOption(sku.id);
    await form.getByRole('combobox', { name: '批次（FEFO 推荐顺序）', exact: true }).selectOption(batch.batchId);
    await form.getByRole('spinbutton', { name: '数量（件）', exact: true }).fill(String(quantity));
    await form.getByRole('textbox', { name: '创建原因', exact: true }).fill('Day 9 browser acceptance');
    const pending = page.waitForResponse((r) => r.url().endsWith('/outbound-orders') && r.request().method() === 'POST');
    await form.getByRole('button', { name: '创建出库单', exact: true }).click();
    const response = await pending; if (response.status() !== 201) throw new Error('Create failed');
    const order = await response.json();
    await page.getByRole('article', { name: `出库单 ${order.id}`, exact: true }).waitFor(); return order;
  };
  const order = await create(18);
  const article = page.getByRole('article', { name: `出库单 ${order.id}`, exact: true });
  const form = article.getByRole('form', { name: `预占 ${order.id}`, exact: true });
  await form.getByRole('textbox', { name: '预占原因', exact: true }).fill('Allocate once after lost response');
  const keys = [], capture = (req) => { if (req.url().endsWith(`/${order.id}/allocate`)) keys.push(req.postDataJSON().key); };
  page.on('request', capture);
  const pattern = `**/outbound-orders/${order.id}/allocate`;
  await page.route(pattern, async (route) => { const result = await route.fetch(); if (result.status() !== 201) throw new Error('Allocation did not commit'); await route.abort('failed'); });
  await form.getByRole('button', { name: '确认全量预占', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '结果不确定' }).waitFor();
  await page.unroute(pattern);
  await form.getByRole('button', { name: '确认全量预占', exact: true }).click();
  await article.getByRole('heading', { name: `${order.batchCode} · 已预占`, exact: true }).waitFor(); page.off('request', capture);
  if (keys.length !== 2 || keys[0] !== keys[1]) throw new Error('Uncertain allocation did not reuse the key');
  const allocated = (await read('outbound-orders')).orders.find((row) => row.id === order.id);
  if (allocated.allocations.length < 3 || allocated.allocations.reduce((sum, row) => sum + row.quantity, 0) !== 18) throw new Error('Missing multi-location allocation records');
  const after = await read('inventory');
  if (after.summary.onHand !== before.summary.onHand || after.summary.reserved !== before.summary.reserved + 18 || after.summary.available !== before.summary.available - 18) throw new Error('Reserved quantity changed onHand or duplicated');
  for (const old of before.balances) if (after.balances.find((row) => row.id === old.id)?.onHand !== old.onHand) throw new Error('An inventory location moved physically');

  const insufficient = await create(8); // Selected batch now has 7, not an automatic cross-batch split.
  const insufficientArticle = page.getByRole('article', { name: `出库单 ${insufficient.id}`, exact: true });
  const insufficientForm = insufficientArticle.getByRole('form', { name: `预占 ${insufficient.id}`, exact: true });
  await insufficientForm.getByRole('textbox', { name: '预占原因', exact: true }).fill('Must reject insufficient batch');
  await insufficientForm.getByRole('button', { name: '确认全量预占', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '请减少数量或拆单' }).waitFor();
  if (JSON.stringify((await read('inventory')).summary) !== JSON.stringify(after.summary)) throw new Error('Failed allocation retained a partial reservation');
  await page.reload();
  await page.getByRole('article', { name: `出库单 ${order.id}`, exact: true }).getByRole('table', { name: `分配明细 ${order.id}`, exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/day-09/day-09-outbound.png', fullPage: true });
  await page.getByRole('link', { name: '查看场景与库存', exact: true }).click();
  await page.getByLabel('库存汇总', { exact: true }).waitFor();
  const numbers = await page.getByLabel('库存汇总', { exact: true }).locator('strong').allTextContents();
  if (JSON.stringify(numbers.map((x) => x.trim())) !== JSON.stringify([after.summary.onHand, after.summary.available, after.summary.reserved, after.summary.hold].map((x) => `${x} 件`))) throw new Error('Scene summary mismatch');
  const selected = allocated.allocations[0];
  await page.getByRole('combobox', { name: '参照货位', exact: true }).selectOption(selected.locationId);
  const details = page.getByRole('region', { name: '货位详情' });
  await details.getByRole('heading', { name: selected.locationCode, exact: true }).waitFor();
  const total = after.locationTotals.find((row) => row.locationId === selected.locationId);
  const sceneDetail = await details.innerText();
  if (!sceneDetail.includes(`预占 ${total.reserved}`)) throw new Error('3D details missed reserved quantity');
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await page.getByRole('button', { name: `选择 ${selected.locationCode}`, exact: true }).click();
  if (await details.innerText() !== sceneDetail) throw new Error('2D and 3D selected different inventory');
  await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/day-09/day-09-scene.png', fullPage: true });
  return { passed: true, lostResponseRetryReusedKey: true, allocatedQuantity: 18, allocationRecords: allocated.allocations.length,
    insufficientOrderStayedCreated: true, noPartialReservation: true, afterReloadMatches: true, sceneAnd2DMatch: true,
    summary: after.summary, orders: [order.id, insufficient.id] };
}
