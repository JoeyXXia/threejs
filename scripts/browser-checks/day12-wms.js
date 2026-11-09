async (page) => {
  await page.getByRole('link', { name: '演示仓库 A 出库与预占', exact: true }).click();
  const create = page.getByRole('form', { name: '创建出库单', exact: true });
  await create.waitFor();
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  async function read(resource) {
    const response = await page.request.get(`${base}/${resource}`);
    if (!response.ok()) throw new Error(`Cannot read ${resource}`);
    return response.json();
  }
  const before = await read('inventory');
  if (JSON.stringify(before.summary) !== JSON.stringify({ onHand: 67, reserved: 0, available: 58, hold: 9 })) {
    throw new Error('Run day8-inbound.js first on a fresh ordinary QA seed');
  }
  const options = await read('outbound-orders');
  const sku = options.skus.find((row) => row.code === 'SKU-A');
  const batch = options.recommendations.find((row) => row.skuId === sku.id && row.batchCode === 'B01');
  await create.getByRole('combobox', { name: '商品 SKU', exact: true }).selectOption(sku.id);
  await create.getByRole('combobox', { name: '批次（FEFO 推荐顺序）', exact: true }).selectOption(batch.batchId);
  await create.getByRole('spinbutton', { name: '数量（件）', exact: true }).fill('3');
  await create.getByRole('textbox', { name: '创建原因', exact: true }).fill('Day 12 出库验收');
  const pending = page.waitForResponse((r) => r.url().endsWith('/outbound-orders') && r.request().method() === 'POST');
  await create.getByRole('button', { name: '创建出库单', exact: true }).click();
  const response = await pending;
  if (response.status() !== 201) throw new Error('Outbound creation failed');
  const order = await response.json();
  const article = page.getByRole('article', { name: `出库单 ${order.id}`, exact: true });
  const allocate = article.getByRole('form', { name: `预占 ${order.id}`, exact: true });
  await allocate.getByRole('textbox', { name: '预占原因', exact: true }).fill('Day 12 预占 3 件');
  await allocate.getByRole('button', { name: '确认全量预占', exact: true }).click();
  await article.getByRole('heading', { name: 'B01 · 已预占', exact: true }).waitFor();
  const final = (await read('inventory')).summary;
  if (JSON.stringify(final) !== JSON.stringify({ onHand: 67, reserved: 3, available: 55, hold: 9 })) {
    throw new Error('Unexpected stock after allocation');
  }

  await page.getByRole('link', { name: '演示仓库 A 仓库台账', exact: true }).click();
  await page.getByRole('heading', { name: '库存预警', exact: true }).waitFor();
  const dashboard = await read('wms');
  const expired = dashboard.warnings.find((warning) => warning.type === 'EXPIRED' && warning.batch.code.startsWith('DAY8-EXPIRED-'));
  if (!expired || expired.quantity !== 2 || !dashboard.warnings.some((row) =>
    row.batch.id === expired.batch.id && row.type === 'HOLD' && row.quantity === 2)) throw new Error('Expired/HOLD alerts do not match');
  await page.getByRole('combobox', { name: '流水类型', exact: true }).selectOption('RECEIPT');
  const ledger = page.getByRole('table', { name: '库存流水', exact: true });
  await page.waitForFunction(() => document.querySelectorAll('table[aria-label="库存流水"] tbody tr').length === 2);
  await ledger.getByRole('row').filter({ hasText: expired.batch.code }).waitFor();
  if (await ledger.getByRole('row').count() !== 3) throw new Error('Receipt filter should contain two postings plus header');
  await page.getByRole('combobox', { name: '批次', exact: true }).selectOption(expired.batch.id);
  const detail = page.getByRole('region', { name: '批次详情', exact: true });
  await detail.getByRole('heading', { name: `SKU-A / ${expired.batch.code}`, exact: true }).waitFor();
  if (await ledger.getByRole('row').count() !== 2) throw new Error('Batch and type filter should contain one posting plus header');
  await detail.getByRole('row').filter({ hasText: /QC-01.*HOLD.*2/ }).waitFor();
  await page.getByRole('table', { name: '业务审计', exact: true }).getByRole('row').filter({ hasText: order.id })
    .filter({ hasText: 'OUTBOUND_ALLOCATED' }).waitFor();
  await page.getByRole('button', { name: '运行只读对账', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '对账通过 · 现存 0 · 预占与运输 0' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.wms-workspace td')].every((cell) => cell.scrollWidth <= cell.clientWidth + 1));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'output/playwright/day-12/day-12-wms.png', fullPage: true });
  const restricted = await page.request.get(base.replace(spaceId, '10000000-0000-4000-8000-000000000002')
    .replace(warehouseId, '20000000-0000-4000-8000-000000000002') + '/wms');
  if (restricted.status() !== 403) throw new Error('QA viewer could read the WMS diagnostics');
  return { passed: true, final, receiptsAfterCombinedFilter: 1, expiredQuantity: 2, holdQuantity: 2, reconciliationDifferences: 0 };
}
