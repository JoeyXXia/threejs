async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('link', { name: '演示仓库 A 盘点与审批', exact: true }).click();
  const create = page.getByRole('form', { name: '开始盘点', exact: true });
  await create.waitFor();
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  async function read(resource) {
    const response = await page.request.get(`${base}/${resource}`);
    if (!response.ok()) throw new Error(`Cannot read ${resource}`);
    return response.json();
  }
  async function send(form, button, endpoint) {
    const pending = page.waitForResponse((response) => response.url().endsWith(endpoint) && response.request().method() === 'POST');
    await form.getByRole('button', { name: button, exact: true }).click();
    const response = await pending;
    if (response.status() !== 201) throw new Error(`POST ${endpoint}: ${response.status()}`);
    return response.json();
  }
  const before = await read('inventory');
  const location = before.locationTotals.find((row) => row.code === 'R02-2-L1' && row.onHand === 9);
  const baseline = before.balances.find((row) => row.locationId === location?.locationId && row.sku.code === 'SKU-A');
  if (!baseline || before.summary.onHand !== 62 || before.summary.reserved !== 0) throw new Error('Use a fresh ordinary QA seed');
  const available = async () => (await read('outbound-orders')).recommendations.find((row) => row.batchId === baseline.batch.id).available;
  if (await available() !== 25) throw new Error('Unexpected initial recommendation');

  async function start(code) {
    const option = create.getByRole('option', { name: code, exact: true });
    await create.getByRole('combobox', { name: '货位', exact: true }).selectOption(await option.getAttribute('value'));
    await create.getByRole('textbox', { name: '开盘原因', exact: true }).fill('Day 11 browser count');
    return send(create, '开始并冻结货位', '/count-orders');
  }

  const order = await start('R02-2-L1');
  const article = page.getByRole('article', { name: `盘点单 ${order.id}`, exact: true });
  await article.getByRole('heading', { name: 'R02-2-L1 · 待录数', exact: true }).waitFor();
  if (await available() !== 16) throw new Error('Frozen stock is still recommended');
  const outboundCommand = (resource, data) => page.request.post(`${base}/${resource}`, {
    headers: { 'X-Requested-With': 'WarehouseTwin' },
    data: { key: globalThis.crypto.randomUUID(), reason: 'Day 11 freeze acceptance', ...data },
  });
  const draft = await outboundCommand('outbound-orders', { skuId: baseline.sku.id, batchId: baseline.batch.id, quantity: 25 });
  if (draft.status() !== 201) throw new Error('Could not create the outbound fixture');
  const denied = await outboundCommand(`outbound-orders/${(await draft.json()).id}/allocate`, {});
  if (denied.status() !== 409) throw new Error('Frozen stock remained allocatable');
  const input = article.getByRole('form', { name: '录入实数', exact: true });
  await input.getByRole('spinbutton').fill('12');
  await input.getByRole('textbox', { name: '录数说明', exact: true }).fill('实物复点 12 件');
  await send(input, '提交实数', `/${order.id}/submit`);
  await article.getByRole('heading', { name: 'R02-2-L1 · 待审批', exact: true }).waitFor();
  if ((await read('inventory')).summary.onHand !== 62) throw new Error('Submission changed physical stock');

  const approve = article.getByRole('form', { name: '批准并调整库存', exact: true });
  await approve.getByRole('textbox', { name: '批准原因', exact: true }).fill('核对盘盈 3 件');
  await send(approve, '批准并调整库存', `/${order.id}/approve`);
  await article.getByRole('heading', { name: 'R02-2-L1 · 已批准', exact: true }).waitFor();
  const after = await read('inventory');
  if (after.summary.onHand !== 65 || after.summary.available !== 58 || await available() !== 28
    || after.locationTotals.find((row) => row.locationId === baseline.locationId).onHand !== 12) {
    throw new Error('Approved count or recommendation did not refresh');
  }

  const empty = await start('OUT-01');
  const emptyArticle = page.getByRole('article', { name: `盘点单 ${empty.id}`, exact: true });
  const reject = emptyArticle.getByRole('form', { name: '拒绝并解冻', exact: true });
  await reject.getByRole('textbox', { name: '拒绝原因', exact: true }).fill('取消空位盘点复核');
  await send(reject, '拒绝并解冻', `/${empty.id}/reject`);
  await page.reload();
  await emptyArticle.getByRole('heading', { name: 'OUT-01 · 已拒绝', exact: true }).waitFor();
  await article.getByRole('heading', { name: 'R02-2-L1 · 已批准', exact: true }).waitFor();
  if (!(await create.getByRole('option', { name: 'OUT-01', exact: true }).isEnabled())) throw new Error('Rejected count remained frozen');
  if ((await read('inventory')).summary.onHand !== 65) throw new Error('Reject changed stock');
  await page.screenshot({ path: 'output/playwright/day-11/day-11-count.png', fullPage: true });
  return { passed: true, before: before.summary, after: after.summary, recommended: [25, 16, 28], actual: 12, rejectionPersisted: true };
}
