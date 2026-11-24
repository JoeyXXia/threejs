async (page) => {
  const origin = 'http://127.0.0.1:15174';
  if (new URL(page.url()).origin !== origin) throw new Error('Isolated QA only');
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const url = page.url();
  const [, spaceId, warehouseId] = new URL(url).pathname.split('/').filter(Boolean);
  const base = origin + '/api/spaces/' + spaceId + '/warehouses/' + warehouseId;
  const browser = page.context().browser();
  if (!browser) throw new Error('QA needs a second browser context');
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  const observer = await other.newPage();
  const captured = Promise.withResolvers(), release = Promise.withResolvers();
  let mode = 'hold';
  const seqs = new Set();
  observer.on('websocket', (ws) => {
    if (!new URL(ws.url()).pathname.startsWith('/socket.io/')) return;
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.startsWith('42') || payload.indexOf('[') < 0) return;
      const [event, batch] = JSON.parse(payload.slice(payload.indexOf('[')));
      if (event === 'warehouse:events') for (const { seq } of batch.events) seqs.add(seq);
    });
  });
  const read = async (path) => {
    const r = await page.request.get(base + '/' + path);
    if (!r.ok()) throw new Error(path + ': ' + r.status());
    return r.json();
  };
  const write = async (path, data) => {
    const r = await page.request.post(base + '/' + path, { data, headers: { 'X-Requested-With': 'WarehouseTwin' } });
    if (r.status() !== 201) throw new Error(path + ': ' + r.status() + ' ' + await r.text());
    return r.json();
  };
  const allocate = async (label) => {
    const { recommendations: [choice] } = await read('outbound-orders');
    const command = (action) => ({ key: 'day30-' + label + '-' + action + '-' + Date.now(), reason: 'Day30 恢复 QA' });
    const order = await write('outbound-orders', { ...command('create'), skuId: choice.skuId, batchId: choice.batchId, quantity: 1 });
    return (await write('outbound-orders/' + order.id + '/allocate', command('allocate'))).allocations[0];
  };
  const status = (value) => observer.locator('[data-testid="warehouse-realtime"][data-status="' + value + '"]');
  const reserved = (qty) => observer.locator('.metrics').getByText('预占', { exact: true }).locator('..').locator('strong')
    .filter({ hasText: new RegExp('^' + qty + ' 件$') });
  try {
    await observer.route('**/snapshot', async (route) => {
      if (mode === 'fail') { await route.abort(); return; }
      if (mode !== 'hold') { await route.continue(); return; }
      mode = 'pass';
      const response = await route.fetch();
      captured.resolve(await response.json());
      await release.promise;
      await route.fulfill({ response });
    });
    await observer.goto(url);
    const initial = await Promise.race([captured.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('No initial snapshot')), 10000))]);
    await status('syncing').waitFor();
    await allocate('during-snapshot');
    const during = (await read('inventory')).watermark;
    for (let i = 0; !seqs.has(during) && i < 100; i++) await observer.waitForTimeout(30);
    if (!seqs.has(during)) throw new Error('No live event arrived while the first snapshot was held');
    release.resolve();
    const quantity = initial.inventory.summary.reserved + 1;
    await reserved(quantity).waitFor();
    await status('connected').waitFor();

    await other.setOffline(true);
    await status('offline').waitFor();
    const allocation = await allocate('offline');
    await write('fleet/initialize', { count: 3, reason: 'Day30 恢复 QA' });
    const staging = (await read('simulation')).staging[0].id;
    const claim = await write('fleet/assign', { robotId: 'robot-2', kind: 'OUTBOUND', allocationId: allocation.id, stagingLocationId: staging, reason: 'Day30 恢复 QA' });
    await reserved(quantity).waitFor(); // Offline retains the last confirmed stock.
    const offlineWatermark = (await read('inventory')).watermark;
    await other.setOffline(false);
    await reserved(quantity + 1).waitFor();
    await status('connected').waitFor();
    await observer.getByRole('row').filter({ hasText: 'robot-2' }).filter({ hasText: claim.id.slice(0, 8) }).waitFor();
    const recovered = Number(await status('connected').getAttribute('data-after'));
    if (recovered < offlineWatermark) throw new Error('Recovered snapshot missed the offline boundary');

    mode = 'fail';
    await observer.getByRole('button', { name: '刷新数据', exact: true }).click();
    await status('stale').waitFor();
    await reserved(quantity + 1).waitFor();
    if (!await observer.getByRole('button', { name: '确认分配到车辆', exact: true }).isDisabled()) throw new Error('Stale UI allowed a command');
    mode = 'pass';
    await observer.getByRole('button', { name: '刷新数据', exact: true }).click();
    await status('connected').waitFor();
    return { passed: true, capturedAt: new Date().toISOString(), initialWatermark: initial.watermark,
      bufferedReservationSeq: during, offlineWatermark, recovered, stock: [quantity - 1, quantity, quantity + 1],
      confirmedTask: true, staleVisible: true, retryRecovered: true };
  } finally { release.resolve(); await other.close(); }
}
