async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const warehouseA = page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true });
  const warehouseB = page.getByRole('link', { name: '演示仓库 B VIEWER', exact: true });
  const inbound = page.getByRole('link', { name: '演示仓库 A 入库与质检', exact: true });
  const wms = page.getByRole('link', { name: '演示仓库 A 仓库台账', exact: true });
  const details = page.getByRole('region', { name: '货位详情', exact: true });
  const metrics = page.getByLabel('库存汇总', { exact: true });
  const area = page.getByRole('combobox', { name: '区域筛选', exact: true });
  const batchSelect = page.getByRole('combobox', { name: '批次筛选', exact: true });
  const batchCode = `DAY13-${Date.now()}`;

  async function assertMetrics(expected) {
    await metrics.waitFor();
    const actual = (await metrics.locator('strong').allTextContents()).map((value) => Number.parseInt(value, 10));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Stock totals mismatch: ${actual}`);
  }
  async function capture(name) {
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle');
    const target = await page.locator('canvas').getAttribute('data-camera-target');
    const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
    const response = await page.request.get(new URL(`/api/spaces/${spaceId}/warehouses/${warehouseId}/layout`, page.url()).href);
    const layout = await response.json();
    const qc = layout.locations.find((row) => row.code === 'QC-01');
    const grid = layout.layoutVersion;
    const expected = [grid.origin.x + (qc.grid.x + 0.5) * grid.cellSize, grid.cellSize / 2, grid.origin.z + (qc.grid.z + 0.5) * grid.cellSize];
    if (!target || JSON.stringify(JSON.parse(target)) !== JSON.stringify(expected)) throw new Error(`Camera target mismatch: ${target}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `output/playwright/day-13/${name}.png`, fullPage: true });
  }

  await assertMetrics([62, 55, 0, 7]);
  await inbound.click();
  const create = page.getByRole('form', { name: '创建入库单', exact: true });
  await create.getByRole('textbox', { name: '批次编号', exact: true }).fill(batchCode);
  await create.getByRole('spinbutton', { name: '数量（件）', exact: true }).fill('3');
  await create.getByRole('textbox', { name: '创建原因', exact: true }).fill('Day 13 scene acceptance');
  const pending = page.waitForResponse((response) => response.url().endsWith('/inbound-orders') && response.request().method() === 'POST');
  await create.getByRole('button', { name: '创建入库单', exact: true }).click();
  const response = await pending;
  if (response.status() !== 201) throw new Error('Inbound creation failed');
  const order = await response.json();
  const article = page.getByRole('article', { name: `入库单 ${batchCode} ${order.id}`, exact: true });
  const receive = article.getByRole('form', { name: `收货 ${order.id}`, exact: true });
  await receive.getByRole('textbox', { name: '操作原因', exact: true }).fill('Receive 3 into QC');
  await receive.getByRole('button', { name: '确认全量收货', exact: true }).click();
  await article.getByRole('form', { name: `质检 ${order.id}`, exact: true }).waitFor();

  await wms.click();
  await page.getByRole('listitem').filter({ hasText: batchCode }).getByRole('link', { name: '在场景定位', exact: true }).click();
  await details.getByRole('heading', { name: 'QC-01', exact: true }).waitFor();
  if (await batchSelect.inputValue() !== order.batchId) throw new Error('Warning did not select its batch');
  if (!(await details.innerText()).includes('3 / 0 / 0 件') || await details.locator('.status-badge').innerText() !== '待检') {
    throw new Error('Scene selection did not reflect received HOLD stock');
  }
  await assertMetrics([65, 55, 0, 10]);
  await capture('day-13-hold');
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await area.selectOption('STORAGE');
  await page.getByText('当前筛选没有货位。', { exact: true }).waitFor();
  await assertMetrics([65, 55, 0, 10]);
  await area.selectOption('QC');
  await page.getByRole('button', { name: '选择 QC-01', exact: true }).click();
  if (await details.locator('.batch-detail').count() !== 1) throw new Error('Unrelated batch leaked into the selected detail');

  await inbound.click();
  const inspect = article.getByRole('form', { name: `质检 ${order.id}`, exact: true });
  await inspect.getByRole('textbox', { name: '操作原因', exact: true }).fill('Release QC stock');
  await inspect.getByRole('button', { name: '提交全量质检', exact: true }).click();
  await article.getByRole('heading', { name: `${batchCode} · 质检通过`, exact: true }).waitFor();
  await warehouseA.click();
  await batchSelect.selectOption(order.batchId);
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await page.getByRole('button', { name: '定位 QC-01', exact: true }).click();
  await details.getByRole('heading', { name: 'QC-01', exact: true }).waitFor();
  if (!(await details.innerText()).includes('3 / 0 / 3 件') || await details.locator('.status-badge').innerText() !== '可用') {
    throw new Error('The selected batch still has stale HOLD state after inspection');
  }
  await assertMetrics([65, 58, 0, 7]);
  await capture('day-13-released');

  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const pathA = `**/api/spaces/${spaceId}/warehouses/${warehouseId}/inventory`;
  let begin;
  const started = new Promise((resolve) => { begin = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(pathA, async (route) => {
    begin();
    await gate;
    try { await route.continue(); } catch { /* the browser already canceled A */ }
  });
  try {
    const cancelled = page.waitForEvent('requestfailed', {
      predicate: (request) => request.url().endsWith(`/${warehouseId}/inventory`), timeout: 8000,
    });
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await started;
    await page.getByText('同步中，显示上次成功快照', { exact: true }).waitFor();
    await warehouseB.click();
    const failed = await cancelled;
    if (!failed.failure()?.errorText.includes('ABORTED')) throw new Error('Old inventory request did not abort');
    await page.getByRole('heading', { name: '演示仓库 B', exact: true }).waitFor();
    await assertMetrics([62, 55, 0, 7]);
    if (await batchSelect.inputValue() !== '') throw new Error('The old batch filter leaked into warehouse B');
  } finally {
    release();
    await page.unroute(pathA);
  }
  await page.route('**/api/spaces/**/inventory', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '仓库数据不可用' }).waitFor();
  if (await metrics.count() || await page.locator('canvas').count()) throw new Error('Warehouse error left stale inventory visible');
  await page.unroute('**/api/spaces/**/inventory');
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await assertMetrics([62, 55, 0, 7]);
  return { passed: true, held: [65, 55, 0, 10], released: [65, 58, 0, 7], oldRequestAborted: true, emptyFilterAndError: true };
}
