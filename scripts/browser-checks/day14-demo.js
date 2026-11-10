async (page) => {
  // Run after logging in on a fresh, ordinary QA seed. Pauses are for the recording only.
  const warehouse = page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true });
  const inbound = page.getByRole('link', { name: '演示仓库 A 入库与质检', exact: true });
  const counts = page.getByRole('link', { name: '演示仓库 A 盘点与审批', exact: true });
  const wms = page.getByRole('link', { name: '演示仓库 A 仓库台账', exact: true });
  const details = page.getByRole('region', { name: '货位详情', exact: true });
  const batch = `DAY14-${Date.now()}`;
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  async function inventory(expected) {
    const response = await page.request.get(`${base}/inventory`);
    if (!response.ok()) throw new Error('Inventory unavailable');
    const { summary } = await response.json();
    const actual = [summary.onHand, summary.available, summary.reserved, summary.hold];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${expected}, got ${actual}`);
  }
  async function clickWrite(form, button, path) {
    const pending = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(path));
    await form.getByRole('button', { name: button, exact: true }).click();
    const result = await pending;
    if (result.status() !== 201) throw new Error(`Write ${path} failed: ${result.status()}`);
    return result.json();
  }
  async function pauseAt(locator) {
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1400);
  }
  async function sceneDetails(text, status, screenshot) {
    await details.getByRole('heading', { name: 'QC-01', exact: true }).waitFor();
    if (!(await details.innerText()).includes(text) || await details.locator('.status-badge').innerText() !== status) {
      throw new Error('Scene stock did not reflect the latest operation');
    }
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle');
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    await pauseAt(page.locator('canvas'));
    await pauseAt(details);
  }

  await inventory([62, 55, 0, 7]);
  await pauseAt(page.getByLabel('库存汇总', { exact: true }));
  await inbound.click();
  const create = page.getByRole('form', { name: '创建入库单', exact: true });
  await create.getByRole('textbox', { name: '批次编号', exact: true }).fill(batch);
  await create.getByRole('spinbutton', { name: '数量（件）', exact: true }).fill('3');
  await create.getByRole('textbox', { name: '创建原因', exact: true }).fill('WMS 演示：入库 3 件');
  const order = await clickWrite(create, '创建入库单', '/inbound-orders');
  const article = page.getByRole('article', { name: `入库单 ${batch} ${order.id}`, exact: true });
  const receive = article.getByRole('form', { name: `收货 ${order.id}`, exact: true });
  await receive.getByRole('textbox', { name: '操作原因', exact: true }).fill('到货数量核对为 3 件');
  await clickWrite(receive, '确认全量收货', `/${order.id}/receive`);
  await inventory([65, 55, 0, 10]);
  await wms.click();
  await page.getByRole('listitem').filter({ hasText: batch }).getByRole('link', { name: '在场景定位', exact: true }).click();
  await sceneDetails('3 / 0 / 0 件', '待检');

  await inbound.click();
  const inspect = article.getByRole('form', { name: `质检 ${order.id}`, exact: true });
  await inspect.getByRole('textbox', { name: '操作原因', exact: true }).fill('外观和数量复核通过');
  await clickWrite(inspect, '提交全量质检', `/${order.id}/inspect`);
  await inventory([65, 58, 0, 7]);
  await warehouse.click();
  await page.getByRole('combobox', { name: '批次筛选', exact: true }).selectOption(order.batchId);
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await page.getByRole('button', { name: '定位 QC-01', exact: true }).click();
  await sceneDetails('3 / 0 / 3 件', '可用', 'day-14-preview.png');

  await counts.click();
  const start = page.getByRole('form', { name: '开始盘点', exact: true });
  const location = start.getByRole('option', { name: 'R02-2-L1', exact: true });
  await start.getByRole('combobox', { name: '货位', exact: true }).selectOption(await location.getAttribute('value'));
  await start.getByRole('textbox', { name: '开盘原因', exact: true }).fill('例行复盘');
  const count = await clickWrite(start, '开始并冻结货位', '/count-orders');
  if (count.lines.length !== 1 || count.lines[0].expected !== 9) throw new Error('Count fixture does not start at nine');
  const card = page.getByRole('article', { name: `盘点单 ${count.id}`, exact: true });
  const enter = card.getByRole('form', { name: '录入实数', exact: true });
  await enter.getByRole('spinbutton').fill('11');
  await enter.getByRole('textbox', { name: '录数说明', exact: true }).fill('同批次复点为 11 件');
  await clickWrite(enter, '提交实数', `/${count.id}/submit`);
  await inventory([65, 58, 0, 7]);
  await pauseAt(card.getByRole('heading', { name: 'R02-2-L1 · 待审批', exact: true }));
  const approve = card.getByRole('form', { name: '批准并调整库存', exact: true });
  await approve.getByRole('textbox', { name: '批准原因', exact: true }).fill('批准盘盈 2 件');
  await clickWrite(approve, '批准并调整库存', `/${count.id}/approve`);
  await inventory([67, 60, 0, 7]);
  await pauseAt(card.getByRole('heading', { name: 'R02-2-L1 · 已批准', exact: true }));

  await wms.click();
  await page.getByRole('combobox', { name: '流水类型', exact: true }).selectOption('COUNT_ADJUSTMENT');
  const ledger = page.getByRole('table', { name: '库存流水', exact: true });
  const posting = ledger.getByRole('row').filter({ hasText: count.id });
  await posting.waitFor();
  const columns = await posting.getByRole('cell').allTextContents();
  if (columns[3] !== '2' || !columns[2].includes('R02-2-L1')) throw new Error('Wrong adjustment amount or location');
  await pauseAt(ledger);
  await page.getByRole('button', { name: '运行只读对账', exact: true }).click();
  await pauseAt(page.getByRole('status').filter({ hasText: '对账通过 · 现存 0 · 预占与运输 0' }));
  await page.reload();
  await page.getByRole('heading', { name: '库存预警', exact: true }).waitFor();
  await inventory([67, 60, 0, 7]);
  return { passed: true, received: 3, released: 3, count: [9, 11], movement: 2, final: [67, 60, 0, 7], reload: true };
}
