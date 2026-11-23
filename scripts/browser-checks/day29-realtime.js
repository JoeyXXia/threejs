async (page) => {
  const origin = 'http://127.0.0.1:15174';
  if (new URL(page.url()).origin !== origin) throw new Error('Isolated QA only');
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const url = page.url();
  const [, spaceId, warehouseId] = new URL(url).pathname.split('/').filter(Boolean);
  const base = origin + '/api/spaces/' + spaceId + '/warehouses/' + warehouseId;
  const browser = page.context().browser();
  if (!browser) throw new Error('QA needs a browser that supports independent contexts');
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  const peer = await other.newPage();
  try {
    const streams = [page, peer].map((tab) => {
      const events = [];
      const sockets = [];
      tab.on('websocket', (ws) => {
        if (!new URL(ws.url()).pathname.startsWith('/socket.io/')) return;
        sockets.push(ws);
        ws.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string' || !payload.startsWith('42')) return;
          const index = payload.indexOf('[');
          if (index < 0) return;
          const [kind, batch] = JSON.parse(payload.slice(index));
          if (kind === 'warehouse:events') events.push(...batch.events);
        });
      });
      return { events, sockets };
    });
    await Promise.all([page.reload(), peer.goto(url)]);
    await Promise.all([page, peer].map((tab) => tab.locator('[data-testid="warehouse-realtime"][data-status="connected"]').waitFor()));
    const baseline = await page.getByTestId('warehouse-realtime').getAttribute('data-after');
    if (baseline !== await peer.getByTestId('warehouse-realtime').getAttribute('data-after')) throw new Error('Different initial cursors');
    const read = async (path) => {
      const r = await page.request.get(base + '/' + path);
      if (!r.ok()) throw new Error(path + ': ' + r.status()); return r.json();
    };
    const write = async (path, data) => {
      const r = await page.request.post(base + '/' + path, { data, headers: { 'X-Requested-With': 'WarehouseTwin' } });
      if (r.status() !== 201) throw new Error(path + ': ' + r.status() + ' ' + await r.text()); return r.json();
    };
    const reserved = (tab) => tab.locator('.metrics').getByText('预占', { exact: true }).locator('..').locator('strong');
    await Promise.all([page, peer].map((tab) => reserved(tab).waitFor()));
    const before = (await read('inventory')).summary.reserved;
    const suggestion = (await read('outbound-orders')).recommendations[0];
    const input = (label) => ({ key: 'day29-' + label + '-' + Date.now(), reason: 'Day29 双浏览器 QA' });
    const order = await write('outbound-orders', { ...input('create'), skuId: suggestion.skuId, batchId: suggestion.batchId, quantity: 1 });
    await write('outbound-orders/' + order.id + '/allocate', input('allocate'));
    const committed = (await read('inventory')).watermark;
    for (const tab of [page, peer]) {
      await tab.waitForFunction((seq) => Number(document.querySelector('[data-testid="warehouse-realtime"]')?.dataset.after) >= seq, committed);
      await reserved(tab).filter({ hasText: new RegExp('^' + (before + 1) + ' 件$') }).waitFor();
    }
    const profiles = streams.map((stream) => stream.events.filter((event) => event.seq > Number(baseline) && event.seq <= committed));
    if (profiles[0].length < 2 || !profiles[0].some((event) => event.kind === 'OUTBOUND_ALLOCATE')
      || JSON.stringify(profiles[0]) !== JSON.stringify(profiles[1])) throw new Error('Browser streams did not agree');
    const latestSockets = streams.map(({ sockets }) => sockets.at(-1));
    if (!latestSockets.every((ws) => ws && !ws.isClosed())) throw new Error('No active WebSocket in one browser');
    const closed = Promise.all(latestSockets.map((ws) => ws.waitForEvent('close', { timeout: 5000 })));
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await closed;
    await Promise.all([page, peer].map((tab) => tab.getByRole('button', { name: '登录', exact: true }).waitFor()));
    return { passed: true, capturedAt: new Date().toISOString(), contexts: 2, baseline: Number(baseline), seq: committed, reservedBefore: before,
      reservedAfter: before + 1, kinds: profiles[0].map((event) => event.kind), bothSocketsClosed: true };
  } finally { await other.close(); }
}
