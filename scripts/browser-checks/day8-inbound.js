async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const origin = 'http://127.0.0.1:15174';
  await page.getByRole('link', { name: '演示仓库 A 入库与质检', exact: true }).click();
  await page.getByRole('form', { name: '创建入库单', exact: true }).waitFor();
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const base = `${origin}/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const inventory = async () => { const r = await page.request.get(`${base}/inventory`); if (!r.ok()) throw new Error('Inventory unavailable'); return r.json(); };
  const before = await inventory();
  const create = async (batch, quantity, expires) => {
    const form = page.getByRole('form', { name: '创建入库单', exact: true });
    await form.getByRole('textbox', { name: '批次编号', exact: true }).fill(batch);
    await form.getByRole('spinbutton', { name: '数量（件）', exact: true }).fill(String(quantity));
    await form.locator('input[name="expires"]').fill(expires);
    await form.getByRole('textbox', { name: '创建原因', exact: true }).fill('Day 8 browser acceptance');
    const response = page.waitForResponse((r) => r.url().endsWith('/inbound-orders') && r.request().method() === 'POST');
    await form.getByRole('button', { name: '创建入库单', exact: true }).click();
    const result = await response;
    if (result.status() !== 201) throw new Error(`Create failed: ${result.status()}`);
    const order = await result.json();
    await page.getByRole('article', { name: `入库单 ${batch} ${order.id}`, exact: true }).waitFor();
    return order;
  };
  const suffix = Date.now();
  const first = await create(`DAY8-PASS-${suffix}`, 3, '2030-01-01');
  const firstArticle = page.getByRole('article', { name: `入库单 ${first.batchCode} ${first.id}`, exact: true });
  const receipt = firstArticle.getByRole('form', { name: `收货 ${first.id}`, exact: true });
  await receipt.getByRole('textbox', { name: '操作原因', exact: true }).fill('Lost response retry');
  const keys = [];
  const capture = (req) => { if (req.url().endsWith(`/${first.id}/receive`)) keys.push(req.postDataJSON().key); };
  page.on('request', capture);
  const pattern = `**/inbound-orders/${first.id}/receive`;
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    if (response.status() !== 201) throw new Error('Backend receipt did not commit before simulated lost response');
    await route.abort('failed'); // Only this browser loses the response; the DB has committed.
  });
  await receipt.getByRole('button', { name: '确认全量收货', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '结果不确定' }).waitFor();
  await page.unroute(pattern);
  await receipt.getByRole('button', { name: '确认全量收货', exact: true }).click();
  const inspection = firstArticle.getByRole('form', { name: `质检 ${first.id}`, exact: true });
  await inspection.waitFor(); page.off('request', capture);
  if (keys.length !== 2 || keys[0] !== keys[1]) throw new Error('UI did not reuse the uncertain command key');
  const held = await inventory();
  if (held.summary.onHand !== before.summary.onHand + 3 || held.summary.hold !== before.summary.hold + 3 || held.summary.available !== before.summary.available) throw new Error('Duplicate receipt or HOLD availability error');
  await inspection.getByRole('textbox', { name: '操作原因', exact: true }).fill('Visual QC passed');
  await inspection.getByRole('button', { name: '提交全量质检', exact: true }).click();
  await firstArticle.getByRole('heading', { name: `${first.batchCode} · 质检通过`, exact: true }).waitFor();
  const passed = await inventory();
  if (passed.summary.onHand !== held.summary.onHand || passed.summary.hold !== before.summary.hold || passed.summary.available !== before.summary.available + 3) throw new Error('Quality transfer changed warehouse total');

  const second = await create(`DAY8-EXPIRED-${suffix}`, 2, '2000-01-01');
  const secondArticle = page.getByRole('article', { name: `入库单 ${second.batchCode} ${second.id}`, exact: true });
  const receiveSecond = secondArticle.getByRole('form', { name: `收货 ${second.id}`, exact: true });
  await receiveSecond.getByRole('textbox', { name: '操作原因', exact: true }).fill('Expired quarantine');
  await receiveSecond.getByRole('button', { name: '确认全量收货', exact: true }).click();
  const inspectSecond = secondArticle.getByRole('form', { name: `质检 ${second.id}`, exact: true });
  await inspectSecond.waitFor();
  await inspectSecond.getByRole('textbox', { name: '操作原因', exact: true }).fill('Must not release expired batch');
  await inspectSecond.getByRole('button', { name: '提交全量质检', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '过期批次不能放行' }).waitFor();
  await inspectSecond.getByRole('combobox', { name: '质检决定', exact: true }).selectOption('REJECT');
  await inspectSecond.getByRole('textbox', { name: '操作原因', exact: true }).fill('Expired batch rejected');
  await inspectSecond.getByRole('button', { name: '提交全量质检', exact: true }).click();
  await secondArticle.getByRole('heading', { name: `${second.batchCode} · 质检拒绝 / HOLD`, exact: true }).waitFor();
  const finalStock = await inventory();
  const expected = { onHand: before.summary.onHand + 5, reserved: before.summary.reserved, available: before.summary.available + 3, hold: before.summary.hold + 2 };
  if (JSON.stringify(finalStock.summary) !== JSON.stringify(expected)) throw new Error('Final inventory mismatch');
  await page.reload();
  await page.getByRole('heading', { name: `${second.batchCode} · 质检拒绝 / HOLD`, exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/day-08/day-08-inbound.png', fullPage: true });
  await page.getByRole('link', { name: '查看场景与库存', exact: true }).click();
  await page.getByLabel('库存汇总', { exact: true }).waitFor();
  const metrics = await page.getByLabel('库存汇总', { exact: true }).locator('strong').allTextContents();
  if (JSON.stringify(metrics.map((v) => v.trim())) !== JSON.stringify([expected.onHand, expected.available, expected.reserved, expected.hold].map((v) => `${v} 件`))) throw new Error('Scene summary is stale after mutations');
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await page.getByRole('button', { name: '选择 QC-01', exact: true }).click();
  const detail = await page.getByRole('region', { name: '货位详情' }).innerText();
  if (!detail.includes(first.batchCode) || !detail.includes(second.batchCode) || !detail.includes('3 / 0 / 3 件') || !detail.includes('2 / 0 / 0 件')) throw new Error('2D detail omitted receipt batches');
  await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/day-08/day-08-scene.png', fullPage: true });
  return { passed: true, lostResponseRetryReusedKey: true, receiptPostedOnce: true, passedQuantity: 3, rejectedQuantity: 2,
    expiredPassRejected: true, afterReloadMatches: true, sceneAnd2DMatch: true, summary: finalStock.summary,
    orders: [first.id, second.id] };
}
