async (page) => {
  const origin = 'http://127.0.0.1:15174';
  if (new URL(page.url()).origin !== origin) throw new Error('Isolated QA only');
  await page.setViewportSize({ width: 1440, height: 1100 });
  const sockets = [];
  page.on('websocket', (ws) => { if (new URL(ws.url()).pathname.startsWith('/socket.io/')) sockets.push(ws); });
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  await page.reload();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = origin + '/api/spaces/' + spaceId + '/warehouses/' + warehouseId + '/';
  const writer = page.context().request;
  const read = async (path) => {
    const r = await writer.get(base + path);
    if (!r.ok()) throw new Error(path + ': ' + r.status()); return r.json();
  };
  const write = async (path, data) => {
    for (let i = 0; i < 8; i++) {
      const r = await writer.post(base + path, { data, headers: { 'X-Requested-With': 'WarehouseTwin' } });
      if (r.status() === 201) return r.json();
      if (r.status() !== 409 || i === 7) throw new Error(path + ': ' + r.status() + ' ' + await r.text());
      await page.waitForTimeout(35);
    }
  };
  const live = page.locator('[data-testid="warehouse-realtime"][data-status="connected"]');
  await live.waitFor();
  const { recommendations: [choice] } = await read('outbound-orders');
  const command = () => ({ key: 'day33-' + Date.now() + '-' + Math.random(), reason: 'Day33 回放 QA' });
  const allocate = async () => {
    const order = await write('outbound-orders', { ...command(), skuId: choice.skuId, batchId: choice.batchId, quantity: 1 });
    return (await write('outbound-orders/' + order.id + '/allocate', command())).allocations[0];
  };
  const allocation = await allocate();
  await write('fleet/initialize', { count: 3, reason: 'Day33 回放 QA' });
  const staging = (await read('simulation')).staging[0].id;
  const claim = await write('fleet/assign', { robotId: 'robot-2', kind: 'OUTBOUND', allocationId: allocation.id, stagingLocationId: staging, reason: 'Day33 回放 QA' });
  const waitTicks = async (n) => {
    for (let i = 0; i < 160; i++) {
      if ((await read('fleet')).tick >= n) return;
      await page.waitForTimeout(65);
    }
    throw new Error('Fleet did not record ticks');
  };
  await waitTicks(6);
  await write('fleet/navigation', { cells: [{ x: 0, z: 0 }], closed: true, expectedRevision: 0, reason: 'Day33 归档封路' });
  await waitTicks(23);
  const initialSocket = sockets.at(-1);
  if (!initialSocket || initialSocket.isClosed()) throw new Error('Live socket missing');
  const closed = initialSocket.waitForEvent('close', { timeout: 5000 });
  await page.getByRole('link', { name: '演示仓库 A 历史回放', exact: true }).click();
  await closed;
  const socketCount = sockets.length;
  let writes = 0;
  const watchWrites = (r) => { if (r.url().startsWith(base) && !['GET', 'HEAD'].includes(r.method())) writes++; };
  page.on('request', watchWrites);
  const replay = page.getByRole('region', { name: '仓库历史回放' });
  const first = page.getByTestId('replay-position');
  await first.waitFor();
  if (await page.getByRole('button', { name: '确认分配到车辆', exact: true }).count()) throw new Error('Live controls leaked into replay');
  const slider = page.getByRole('slider', { name: '时间轴' });
  const highlight = page.getByLabel('任务高亮');
  await highlight.selectOption(claim.id);
  await replay.locator('tr[data-highlighted="true"]').getByText('robot-2', { exact: true }).waitFor();
  const firstTick = Number(await first.getAttribute('data-tick'));
  await page.getByLabel('速度').selectOption('0.5');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await slider.press('Home');
  await page.getByLabel('速度').selectOption('2');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForFunction(() => {
    const p = document.querySelector('[data-testid="replay-position"]');
    const input = document.querySelector('input[type="range"][aria-label="时间轴"]');
    return p?.getAttribute('data-index') === input?.getAttribute('max');
  });
  const digest = async () => ({
    seq: Number(await first.getAttribute('data-seq')), tick: Number(await first.getAttribute('data-tick')),
    stock: await page.getByTestId('replay-stock').textContent(), navigation: await page.getByTestId('replay-navigation').textContent(),
    robots: await replay.getByRole('table', { name: '全车历史状态' }).innerText(),
  });
  const sequential = await digest();
  if (sequential.tick <= firstTick || !sequential.navigation.includes('封路修订 1') || !sequential.robots.includes('robot-3')) {
    throw new Error('Timeline did not preserve full archived context');
  }
  await slider.press('Home'); await slider.press('End');
  const sought = await digest();
  if (JSON.stringify(sought) !== JSON.stringify(sequential)) throw new Error('Seek and continuous playback disagree');
  const visual = page.getByRole('region', { name: '仓库历史回放' }).locator('canvas');
  await visual.waitFor();
  await visual.screenshot({ path: 'output/playwright/day-33/replay.png' });
  const before = (await read('inventory')).summary.reserved;
  await allocate(); // Test writer uses APIRequestContext; the replay page itself issues no write.
  const committed = (await read('inventory')).watermark;
  if (committed <= sought.seq || JSON.stringify(await digest()) !== JSON.stringify(sought) || sockets.length !== socketCount || writes !== 0) {
    throw new Error('Live commit leaked into replay or replay sent a write');
  }
  let removed = false;
  await page.route(/\/history\?/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (!removed && body.events.length > 1) { body.events.shift(); removed = true; }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: '读取历史', exact: true }).click();
  await replay.getByRole('alert').getByText('历史数据不完整或不可读；未恢复库存与位置。', { exact: true }).waitFor();
  if (!removed || await page.getByTestId('replay-stock').count() || writes !== 0) throw new Error('Incomplete history was rendered');
  page.off('request', watchWrites);
  await page.getByRole('link', { name: '返回实时仓库', exact: true }).click();
  await live.waitFor();
  await page.waitForFunction((seq) => Number(document.querySelector('[data-testid="warehouse-realtime"]')?.dataset.after) >= seq, committed);
  await page.locator('.metrics').getByText('预占', { exact: true }).locator('..').locator('strong')
    .filter({ hasText: new RegExp('^' + (before + 1) + ' 件$') }).waitFor();
  if (sockets.length <= socketCount) throw new Error('Live did not open a new socket');
  return { passed: true, capturedAt: new Date().toISOString(), firstTick, sequential, sought, committed,
    replayWrites: writes, replayOpenedSockets: 0, gapRejected: true, liveReserved: before + 1 };
}
