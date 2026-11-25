async (page) => {
  const origin = 'http://127.0.0.1:15174';
  if (new URL(page.url()).origin !== origin) throw new Error('Isolated QA only');
  const sockets = [];
  page.on('websocket', (ws) => { if (new URL(ws.url()).pathname.startsWith('/socket.io/')) sockets.push(ws); });
  const aLink = page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true });
  const bLink = page.getByRole('link', { name: '演示仓库 B VIEWER', exact: true });
  await aLink.click(); await page.reload();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = origin + '/api/spaces/' + spaceId + '/warehouses/' + warehouseId + '/';
  const client = page.context().request;
  const get = async (path) => {
    const response = await client.get(base + path);
    if (!response.ok()) throw new Error(path + ': ' + response.status()); return response.json();
  };
  const post = async (path, data) => {
    for (let i = 0; i < 8; i++) {
      const r = await client.post(base + path, { data, headers: { 'X-Requested-With': 'WarehouseTwin' } });
      if (r.status() === 201) return r.json();
      if (r.status() !== 409 || i === 7) throw new Error(path + ': ' + r.status() + ' ' + await r.text());
      await page.waitForTimeout(40);
    }
  };
  const live = page.locator('[data-testid="warehouse-realtime"][data-status="connected"]');
  const active = () => sockets.filter((ws) => !ws.isClosed()).length;
  const settled = async (count) => {
    for (let i = 0; i < 60 && active() !== count; i++) await page.waitForTimeout(50);
    if (active() !== count) throw new Error('Open realtime sockets: ' + active() + ', expected ' + count);
  };
  await live.waitFor(); await settled(1);
  const seed = (await get('outbound-orders')).recommendations[0];
  const command = () => ({ key: 'day34-' + Date.now() + '-' + Math.random(), reason: 'Day34 位置采样 QA' });
  const order = await post('outbound-orders', { ...command(), skuId: seed.skuId, batchId: seed.batchId, quantity: 1 });
  const allocation = (await post('outbound-orders/' + order.id + '/allocate', command())).allocations[0];
  await post('fleet/initialize', { count: 3, reason: 'Day34 位置采样 QA' });
  const staging = (await get('simulation')).staging[0].id;
  await post('fleet/assign', { robotId: 'robot-2', kind: 'OUTBOUND', allocationId: allocation.id, stagingLocationId: staging, reason: 'Day34 位置采样 QA' });
  await page.waitForFunction(() => {
    const value = document.querySelector('canvas[data-fleet-count]')?.dataset.fleetPositions;
    return value && JSON.parse(value)[0]?.tick >= 5;
  });
  let snapshotGets = 0, posePackets = 0;
  const observe = (r) => { if (r.method() === 'GET' && r.url() === base + 'snapshot') snapshotGets++; };
  page.on('request', observe);
  sockets.at(-1).on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string' || !payload.startsWith('42') || payload.indexOf('[') < 0) return;
    const [name, batch] = JSON.parse(payload.slice(payload.indexOf('[')));
    if (name === 'warehouse:events' && batch.pose) posePackets++;
  });
  const measured = await page.evaluate(async () => {
    const section = document.querySelector('section[aria-label="仓库场景"]');
    const before = Number(section?.dataset.reactCommits), ticks = new Set();
    const start = performance.now();
    while (performance.now() - start < 3200) {
      const value = document.querySelector('canvas[data-fleet-count]')?.dataset.fleetPositions;
      if (value) ticks.add(JSON.parse(value)[0]?.tick);
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    return { meshTicks: ticks.size, reactCommits: Number(section?.dataset.reactCommits) - before, sampledMs: Math.round(performance.now() - start) };
  });
  page.off('request', observe);
  if (measured.meshTicks < 6 || posePackets < 4 || snapshotGets >= measured.meshTicks
    || !Number.isFinite(measured.reactCommits) || measured.reactCommits >= measured.meshTicks) {
    throw new Error('Pose and UI rates were not separated: ' + JSON.stringify({ ...measured, snapshotGets, posePackets }));
  }
  const routeCounts = [];
  for (let i = 0; i < 2; i++) {
    await bLink.click(); await live.waitFor(); await settled(1); routeCounts.push(active());
    await aLink.click(); await live.waitFor(); await settled(1); routeCounts.push(active());
  }
  await page.getByRole('link', { name: '演示仓库 A 历史回放', exact: true }).click();
  await page.getByText('回放 · 只读', { exact: true }).waitFor(); await settled(0); routeCounts.push(active());
  await page.getByRole('link', { name: '返回实时仓库', exact: true }).click();
  await live.waitFor(); await settled(1); routeCounts.push(active());
  await page.context().setOffline(true);
  await page.locator('[data-testid="warehouse-realtime"][data-status="offline"]').waitFor();
  await settled(0); routeCounts.push(active());
  await page.context().setOffline(false);
  await live.waitFor(); await settled(1); routeCounts.push(active());
  return { passed: true, capturedAt: new Date().toISOString(), ...measured, snapshotGets, posePackets,
    routeCounts, testedInStrictModeDev: true };
}
