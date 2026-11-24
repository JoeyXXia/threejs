async (page) => {
  const origin = 'http://127.0.0.1:15174';
  if (new URL(page.url()).origin !== origin) throw new Error('Isolated QA only');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = origin + '/api/spaces/' + spaceId + '/warehouses/' + warehouseId + '/';
  const read = async (url) => {
    const r = await page.request.get(base + url);
    if (!r.ok()) throw new Error(url + ': ' + r.status());
    return r.json();
  };
  const write = async (url, data) => {
    for (let i = 0; i < 8; i++) {
      const r = await page.request.post(base + url, { data, headers: { 'X-Requested-With': 'WarehouseTwin' } });
      if (r.status() === 201) return r.json();
      if (r.status() !== 409 || i === 7) throw new Error(url + ': ' + r.status() + ' ' + await r.text());
      await page.waitForTimeout(35);
    }
  };
  const poll = async (check, label) => {
    const deadline = Date.now() + 30000;
    do {
      const fleet = await read('fleet');
      if (fleet.robots.some((r) => r.phase === 'ERROR')) throw new Error('Unexpected fleet ERROR');
      if (check(fleet)) return fleet;
      await page.waitForTimeout(75);
    } while (Date.now() < deadline);
    throw new Error(label);
  };
  await page.getByTestId('ops-completion').filter({ hasText: '—（无终态任务）' }).waitFor();
  await page.getByRole('button', { name: '库存热力', exact: true }).click();
  const legend = page.getByTestId('operations-heat-legend');
  await legend.getByText('10–29 件', { exact: true }).waitFor();
  const inventoryCells = Number(await legend.getAttribute('data-cells'));
  if (inventoryCells <= 0) throw new Error('Expected nonempty physical inventory heat');
  const canvas = page.locator('.scene-canvas canvas');
  await canvas.waitFor();
  await canvas.screenshot({ path: 'output/playwright/day-31/inventory.png' });
  await page.getByRole('button', { name: '通道等待热力', exact: true }).click();
  await legend.getByText('暂无该布局的通道拥堵记录。', { exact: true }).waitFor();
  await legend.getByText('>1–5 秒', { exact: true }).waitFor();
  if (Number(await legend.getAttribute('data-cells')) !== 0) throw new Error('Traffic was reported without ticks');

  const { recommendations: [choice] } = await read('outbound-orders');
  const command = () => ({ key: 'day31-' + Date.now() + '-' + Math.random(), reason: 'Day31 热力夹具' });
  const alloc = async () => {
    const order = await write('outbound-orders', { ...command(), skuId: choice.skuId, batchId: choice.batchId, quantity: 1 });
    return (await write('outbound-orders/' + order.id + '/allocate', command())).allocations[0];
  };
  const a = await alloc(), b = await alloc();
  const layout = await read('layout'), goal = (await read('simulation')).staging[0];
  const start = layout.locations.find((r) => r.id === a.locationId).serviceCell;
  const target = layout.locations.find((r) => r.id === goal.id).serviceCell;
  if (start.x !== 5 || start.z !== 4 || target.x !== 27 || target.z !== 3) throw new Error('Unexpected fixture geometry');
  await write('fleet/initialize', { count: 5, reason: 'Day31 热力夹具' });
  await write('fleet/resources', { reason: 'Day31 single-capacity aisle', resources: [
    { id: 'aisle', kind: 'AISLE', cells: [...Array.from({ length: 23 }, (_, i) => ({ x: i + 5, z: 3 })), start] },
    { id: 'dock', kind: 'CHARGING', cells: [{ x: 27, z: 2 }] },
  ] });
  const assign = (robotId, allocationId) => write('fleet/assign', { robotId, kind: 'OUTBOUND', allocationId, stagingLocationId: goal.id, reason: 'Day31 热力夹具' });
  const first = await assign('robot-2', a.id);
  const next = (await read('fleet')).robots[1].route[7];
  await write('fleet/navigation', { cells: [next], closed: true, expectedRevision: 0, reason: 'Day31 固定绕行' });
  await poll((fleet) => fleet.robots[1].carrying && fleet.robots[1].to.x >= 8 && fleet.robots[1].to.x <= 18
    && fleet.resources.some((r) => r.id === 'aisle' && r.ownerId === 'robot-2'), 'Carrier did not reach fixture entrance');
  const fault = await write('fleet/control', { robotId: 'robot-2', expectedTaskId: first.id, action: 'FAULT', reason: 'Day31 故障不计拥堵' });
  await assign('robot-1', b.id);
  const busy = await poll((fleet) => fleet.robots[0].waitReason === 'RESOURCE_BUSY' && fleet.robots[0].resourceWaitId === 'aisle', 'Missing real aisle wait');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="operations-heat-legend"]')?.dataset.cells) > 0);
  await page.getByTestId('ops-pending').filter({ hasText: /^0 \/ 2 \/ 0$/ }).waitFor();
  await page.getByTestId('ops-fleet').filter({ hasText: /故障 1/ }).waitFor();
  await canvas.screenshot({ path: 'output/playwright/day-31/waiting.png' });
  const ops = await read('operations'), actualWait = ops.wait;
  if (actualWait.lastSeq < busy.watermark || actualWait.cells.length < 1) throw new Error('Positive wait was not sampled');
  const expected = new Map(), kinds = new Set(['OCCUPIED', 'EDGE_SWAP', 'TARGET_CONFLICT', 'RESOURCE_BUSY']);
  for (let after = actualWait.firstSeq - 1; after < actualWait.lastSeq;) {
    const chunk = (await read('simulation/events?after=' + after)).events.filter((e) => e.seq <= actualWait.lastSeq);
    if (!chunk.length) throw new Error('Evidence events missing');
    for (const e of chunk) if (e.kind === 'FLEET_TICK' && e.payload.layoutId === layout.layoutVersion.id) {
      for (const bot of e.payload.robots) if (kinds.has(bot.waitReason)) {
        const k = bot.cell.x + ':' + bot.cell.z;
        expected.set(k, (expected.get(k) ?? 0) + 250);
      }
    }
    after = chunk.at(-1).seq;
  }
  if (expected.size !== actualWait.cells.length || actualWait.cells.some((c) => c.ms !== expected.get(c.x + ':' + c.z))) throw new Error('Heat does not match persisted tick sum');
  await page.getByRole('button', { name: '关闭热力', exact: true }).click();
  await legend.waitFor({ state: 'detached' });
  return { passed: true, capturedAt: new Date().toISOString(), inventoryCells, wait: actualWait, pending: ops.pending, queue: ops.queue,
    faultCell: fault.robots[1].to, realWaitCell: busy.robots[0].to, emptyRateDisplayed: true, offClearedLegend: true };
}
