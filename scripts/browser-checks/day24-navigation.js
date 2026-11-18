async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const read = async (p) => { const r = await page.request.get(`${base}/${p}`); if (!r.ok()) throw new Error(`${p}: ${r.status()}`); return r.json(); };
  const post = async (p, data) => { const r = await page.request.post(`${base}/${p}`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data }); if (!r.ok()) throw new Error(`${p}: ${r.status()} ${await r.text()}`); return r.json(); };
  const init = page.getByRole('form', { name: '初始化多车', exact: true });
  await init.getByRole('textbox', { name: '初始化原因', exact: true }).fill('Day24 三车封锁验证');
  await init.getByRole('button', { name: '初始化多车模式', exact: true }).click();
  await page.getByTestId('fleet-status').waitFor();
  const initial = await read('fleet');
  const invalid = await page.request.post(`${base}/fleet/navigation`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data: { cells: [initial.robots[1].to], closed: true, expectedRevision: 0, reason: 'reject occupied' } });
  if (invalid.status() !== 409) throw new Error('Occupied closure accepted');
  const options = await read('outbound-orders'), batch = options.recommendations[0], sim = await read('simulation');
  const command = () => ({ key: `day24-${Date.now()}-${Math.random()}`, reason: 'Day24 real browser fixture' });
  const order = await post('outbound-orders', { ...command(), skuId: batch.skuId, batchId: batch.batchId, quantity: 1 });
  const allocation = (await post(`outbound-orders/${order.id}/allocate`, command())).allocations[0];
  const form = page.getByRole('form', { name: '分配多车任务', exact: true });
  await form.getByRole('combobox', { name: '多车任务来源', exact: true }).locator(`option[value="${allocation.id}"]`).waitFor({ state: 'attached' });
  await form.getByRole('combobox', { name: '分配车辆', exact: true }).selectOption('robot-2');
  await form.getByRole('combobox', { name: '多车任务来源', exact: true }).selectOption(allocation.id);
  await form.getByRole('combobox', { name: '多车任务目标', exact: true }).selectOption(sim.staging[0].id);
  await form.getByRole('textbox', { name: '分配原因', exact: true }).fill('Day24 closure assignment');
  await form.getByRole('button', { name: '确认分配到车辆', exact: true }).click();
  let state;
  const poll = async (check, limit = 45000) => { const deadline = Date.now() + limit; while (Date.now() < deadline) { state = await read('fleet'); if (state.robots.some((r) => r.phase === 'ERROR')) throw new Error('Fleet error'); if (check(state)) return; await page.waitForTimeout(80); } throw new Error('Timed out waiting for fleet'); };
  await poll((s) => s.robots[1].taskId && s.robots[1].route.length > 7);
  const claim = state.robots[1].taskId, detourCell = state.robots[1].route[6];
  const change = async (cell, close) => {
    const f = page.getByRole('form', { name: '修改通道封锁', exact: true });
    for (let i = 0; i < 12; i++) {
      await f.getByRole('spinbutton', { name: '封锁格 X', exact: true }).fill(String(cell.x));
      await f.getByRole('spinbutton', { name: '封锁格 Z', exact: true }).fill(String(cell.z));
      await f.getByRole('combobox', { name: '封锁操作', exact: true }).selectOption(close ? 'CLOSE' : 'OPEN');
      await f.getByRole('textbox', { name: '封锁操作原因', exact: true }).fill('Day24 浏览器空闲格变更');
      const response = page.waitForResponse((r) => r.url() === `${base}/fleet/navigation` && r.request().method() === 'POST');
      await f.getByRole('button', { name: '提交地图变更', exact: true }).click();
      const r = await response; if (r.status() === 201) return r.json();
      if (r.status() !== 409) throw new Error(await r.text()); await page.waitForTimeout(60);
    }
    throw new Error('Repeated closure conflict');
  };
  const detour = await change(detourCell, true);
  if (detour.navigation.revision !== 1 || detour.robots[1].navigationIssue || detour.robots[1].route.some((p) => p.x === detourCell.x && p.z === detourCell.z)) throw new Error('No legal detour');
  const stale = await page.request.post(`${base}/fleet/navigation`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data: { cells: [detourCell], closed: false, expectedRevision: 0, reason: 'reject old revision' } });
  if (stale.status() !== 409) throw new Error('Old revision accepted');
  const layout = await read('layout'), target = layout.locations.find((r) => r.id === sim.staging[0].id);
  const goal = target.serviceCell;
  // Closing an unoccupied future endpoint forces NO_PATH before pickup or while carrying.
  const paused = await change(goal, true);
  if (paused.robots[1].navigationIssue?.reason !== 'NO_PATH') throw new Error('Closed destination did not pause');
  const pose = paused.robots[1].to, carrying = paused.robots[1].carrying;
  await poll((s) => s.tick >= paused.tick + 8);
  if (JSON.stringify(state.robots[1].to) !== JSON.stringify(pose) || state.robots[1].carrying !== carrying || state.robots[1].taskId !== claim) throw new Error('Blocked car changed pose/cargo/owner');
  await page.getByRole('alert').filter({ hasText: 'NO_PATH' }).waitFor();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.fleetCount === '3');
  await page.screenshot({ path: 'output/playwright/day-24/day-24-paused.png', fullPage: true });
  await page.reload(); await page.getByTestId('navigation-status').waitFor();
  const reload = await read('fleet'); if (reload.navigation.revision !== 2 || !reload.robots[1].navigationIssue || reload.robots[1].taskId !== claim) throw new Error('Reload lost closure/pause');
  await change(goal, false);
  await poll((s) => s.robots[1].phase === 'COMPLETED');
  const completed = state;
  await change(detourCell, false);
  const inventory = await read('inventory'), reconciliation = await read('wms/reconcile'), final = await read('fleet');
  if (!reconciliation.consistent || inventory.summary.onHand !== 62 || inventory.summary.reserved !== 1 || final.navigation.revision !== 4) throw new Error('Final ledger/map mismatch');
  await page.screenshot({ path: 'output/playwright/day-24/day-24-completed.png', fullPage: true });
  const events = []; let after = 0;
  while (after < final.watermark) { const result = await read(`simulation/events?after=${after}`); const batch = result.events.filter((e) => e.seq <= final.watermark); if (!batch.length) throw new Error('Event gap'); events.push(...batch); after = batch.at(-1).seq; }
  const changes = events.filter((e) => e.kind === 'FLEET_NAVIGATION_CHANGED');
  if (changes.length !== 4 || changes.some((e, i) => e.payload.navigation.revision !== i + 1)) throw new Error('Missing revision history');
  for (const e of events.filter((e) => e.kind === 'FLEET_TICK')) if (e.payload.robots.some((r) => e.payload.navigation.closed.some((c) => c.x === r.cell.x && c.z === r.cell.z))) throw new Error('Durable tick entered closure');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('viewer@demo.local');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByTestId('navigation-status').waitFor();
  if (!await page.getByRole('button', { name: '提交地图变更', exact: true }).isDisabled()) throw new Error('Viewer controls enabled');
  const denied = await page.request.post(`${base}/fleet/navigation`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data: { cells: [{ x: 0, z: 0 }], closed: true, expectedRevision: 4, reason: 'deny viewer' } });
  if (denied.status() !== 403) throw new Error('Viewer map command accepted');
  return { passed: true, capturedAt: new Date().toISOString(), robots: 3, detourCell, pausedPose: pose, pausedCarrying: carrying,
    pausedTick: paused.tick, completedTick: completed.tick, finalTick: final.tick, watermark: final.watermark, mapChanges: changes.length,
    checkedEvents: events.length, checkedTickBatches: events.filter((e) => e.kind === 'FLEET_TICK').length, final: inventory.summary,
    reconciled: true, reloadPreserved: true, viewerWriteStatus: denied.status(), occupiedStatus: invalid.status(), staleRevisionStatus: stale.status() };
}
