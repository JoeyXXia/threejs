async (page) => {
  const origin = 'http://127.0.0.1:18146';
  if (new URL(page.url()).origin !== origin) throw new Error('Isolated Day40 QA only');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (read, label) => {
    for (let i = 0; i < 160; i++) { const value = await read(); if (value) return value; await page.waitForTimeout(35); }
    throw new Error(label);
  };
  const bounded = async (promise, label) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 8000); })]); }
    finally { clearTimeout(timer); }
  };
  const a = { spaceId: '10000000-0000-4000-8000-000000000001', warehouseId: '20000000-0000-4000-8000-000000000001' };
  const b = { spaceId: '10000000-0000-4000-8000-000000000002', warehouseId: '20000000-0000-4000-8000-000000000002' };
  const path = (scope) => `/api/spaces/${scope.spaceId}/warehouses/${scope.warehouseId}/`;
  const writer = page.context().request;
  const get = async (scope, suffix) => {
    const response = await writer.get(origin + path(scope) + suffix);
    assert(response.ok(), `${suffix}: ${response.status()}`); return response.json();
  };
  const write = async (suffix, data) => {
    const response = await writer.post(origin + path(a) + suffix, { data, headers: { 'X-Requested-With': 'WarehouseTwin' } });
    assert(response.status() === 201, `${suffix}: ${response.status()} ${await response.text()}`); return response.json();
  };
  const allocate = async (label) => {
    const { recommendations: [item] } = await get(a, 'outbound-orders');
    const command = (action) => ({ key: `day40-${label}-${action}-${Date.now()}`, reason: 'Day40 isolated fault matrix' });
    const order = await write('outbound-orders', { ...command('make'), skuId: item.skuId, batchId: item.batchId, quantity: 1 });
    await write(`outbound-orders/${order.id}/allocate`, command('reserve'));
    return get(a, 'inventory');
  };
  const status = (value) => page.locator(`[data-testid="warehouse-realtime"][data-status="${value}"]`);
  const reserved = (qty) => page.getByLabel('库存汇总').getByText('预占', { exact: true }).locator('..').locator('strong')
    .filter({ hasText: new RegExp(`^${qty} 件$`) });
  const watermark = () => status('connected').getAttribute('data-after').then(Number);
  const linkB = page.getByRole('link', { name: '演示仓库 B VIEWER', exact: true });
  const fallback = () => ({ seen: false, captured: Promise.withResolvers(), release: Promise.withResolvers(), finished: Promise.withResolvers() });
  let hold = fallback(), fault;
  const subscriptions = [], arrived = new Set();
  const decode = (message) => {
    if (typeof message !== 'string') return;
    const start = message.indexOf('[');
    if (start < 0 || !/^42\d*$/.test(message.slice(0, start))) return;
    const header = message.slice(0, start);
    return { header, values: JSON.parse(message.slice(start)) };
  };
  await page.routeWebSocket(/\/socket\.io\//, (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const data = decode(message);
      if (data?.values[0] === 'warehouse:subscribe') subscriptions.push(data.values[1]);
      server.send(message);
    });
    server.onMessage((message) => {
      const data = decode(message), packet = data?.values[1];
      if (data?.values[0] !== 'warehouse:events' || packet?.warehouseId !== a.warehouseId) { browser.send(message); return; }
      for (const e of packet.events) arrived.add(e.seq);
      if (!fault || fault.forwarded) { browser.send(message); return; }
      const events = [...packet.events];
      if (fault.dropped === undefined) {
        fault.dropped = events.shift().seq;
        if (!events.length) {
          // ACK the intercepted packet so the real relay can send the next real page.
          assert(data.header.length > 2, 'Missing Socket.IO packet ACK id');
          server.send(`43${data.header.slice(2)}[true]`);
          return;
        }
      }
      fault.forwarded = events[0].seq;
      browser.send(data.header + JSON.stringify(['warehouse:events', { ...packet, events: [events[0], ...events] }]));
    });
  });
  await page.route('**/snapshot', async (route) => {
    const pending = hold;
    if (!pending || pending.seen || new URL(route.request().url()).pathname !== path(a) + 'snapshot') { await route.continue(); return; }
    pending.seen = true;
    try {
      const response = await route.fetch();
      assert(response.ok(), 'Cannot hold a real A snapshot');
      pending.captured.resolve(await response.json());
      await pending.release.promise;
      try { await route.fulfill({ response }); pending.finished.resolve('delivered'); }
      catch { pending.finished.resolve('aborted'); }
    } catch (error) { pending.captured.reject(error); pending.finished.resolve('failed'); }
  });
  await page.route(/\/simulation\/events\?after=\d+$/, async (route) => {
    const probe = fault;
    if (!probe || new URL(route.request().url()).pathname !== path(a) + 'simulation/events' || probe.history) { await route.continue(); return; }
    if (probe.mode === 'expired') {
      probe.history = { status: 410, includesMissing: false };
      await route.fulfill({ status: 410, json: { message: 'Day40 injected expired cursor' } });
      return;
    }
    const response = await route.fetch(), body = await response.json();
    probe.history = { status: response.status(), includesMissing: body.events?.some((e) => e.seq === probe.dropped) };
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${origin}/warehouses/${a.spaceId}/${a.warehouseId}`);
    const first = await bounded(hold.captured.promise, 'Initial A snapshot not captured');
    const race = await allocate('snapshot-in-flight');
    await until(() => arrived.has(race.watermark), 'No real event reached the proxy while A snapshot was held');
    await status('syncing').waitFor();
    hold.release.resolve();
    await reserved(race.summary.reserved).waitFor(); await status('connected').waitFor();
    assert(await watermark() >= race.watermark, 'Late initial snapshot silently kept older stock');
    hold = undefined;

    fault = { mode: 'gap' };
    const afterGap = await allocate('gap');
    await until(() => fault.history, 'Missing packet did not trigger HTTP history');
    await reserved(afterGap.summary.reserved).waitFor(); await status('connected').waitFor();
    assert(fault.history.status === 200 && fault.history.includesMissing && fault.forwarded > fault.dropped, 'HTTP did not fill the real missing sequence');
    assert(await watermark() >= afterGap.watermark, 'Gap recovery did not cover the allocation');
    const gap = fault;

    const aFreshCount = () => subscriptions.filter((s) => s.warehouseId === a.warehouseId && s.after === undefined).length;
    const initialFresh = aFreshCount();
    fault = { mode: 'expired' };
    const expired = await allocate('expired');
    await until(() => fault.history, 'Expired cursor injection not observed');
    await until(() => aFreshCount() > initialFresh, '410 did not open a fresh subscription');
    await reserved(expired.summary.reserved).waitFor(); await status('connected').waitFor();
    assert(await watermark() >= expired.watermark, 'Fresh resync did not catch up');
    const expiry = fault;
    fault = undefined;

    await page.context().setOffline(true); await status('offline').waitFor();
    const afterOffline = await allocate('offline');
    await reserved(expired.summary.reserved).waitFor();
    await page.context().setOffline(false);
    await reserved(afterOffline.summary.reserved).waitFor(); await status('connected').waitFor();
    const recovered = await watermark();
    assert(recovered >= afterOffline.watermark, 'Reconnect left stock behind');

    hold = fallback();
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    const late = await bounded(hold.captured.promise, 'Late A snapshot not captured');
    const bInventory = await get(b, 'inventory');
    assert(late.inventory.summary.reserved !== bInventory.summary.reserved, 'Fixture did not differentiate A and B');
    await linkB.click(); await status('connected').waitFor(); await reserved(bInventory.summary.reserved).waitFor();
    hold.release.resolve();
    const lateOutcome = await bounded(hold.finished.promise, 'Late A response did not settle');
    assert(lateOutcome !== 'failed', 'Late-response fixture failed');
    await page.getByRole('heading', { name: '演示仓库 B', exact: true }).waitFor();
    await reserved(bInventory.summary.reserved).waitFor();
    assert(await watermark() === bInventory.watermark && !await reserved(late.inventory.summary.reserved).count(), 'Old A request contaminated B');

    const logout = await writer.post(origin + '/api/auth/logout', { headers: { 'X-Requested-With': 'WarehouseTwin' }, data: {} });
    assert(logout.status() === 201, 'Server did not revoke the session');
    await page.getByRole('button', { name: '登录', exact: true }).waitFor();
    assert(!await page.getByLabel('库存汇总').count(), 'Warehouse data remains visible after revocation');
    const when = new Date().toISOString();
    const historyStatus = (await writer.get(origin + path(b) + 'history?' + new URLSearchParams({ from: when, to: when }))).status();
    assert(historyStatus === 401, `History after session revocation: ${historyStatus}`);
    return { passed: true, capturedAt: when, initialHeldSeq: first.watermark, commitDuringSnapshot: race.watermark,
      gap, injectedExpiry: expiry, freshResubscriptions: aFreshCount() - initialFresh, offlineRecovery: recovered,
      stock: { initial: first.inventory.summary.reserved, afterGap: afterGap.summary.reserved, afterOffline: afterOffline.summary.reserved, warehouseB: bInventory.summary.reserved },
      lateA: { watermark: late.watermark, outcome: lateOutcome }, warehouseBWatermark: bInventory.watermark, historyAfterSessionRevocation: historyStatus };
  } finally { hold?.release.resolve(); await page.context().setOffline(false); }
}
