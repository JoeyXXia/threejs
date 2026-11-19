async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`, headers = { 'X-Requested-With': 'WarehouseTwin' };
  const read = async (p) => { const r = await page.request.get(`${base}/${p}`); if (!r.ok()) throw new Error(`${p}: ${r.status()}`); return r.json(); };
  const post = async (p, data) => { const r = await page.request.post(`${base}/${p}`, { headers, data }); if (!r.ok()) throw new Error(`${p}: ${r.status()} ${await r.text()}`); return r.json(); };
  const command = () => ({ key: `day25-${Date.now()}-${Math.random()}`, reason: 'Day25 real browser fixture' });
  const options = await read('outbound-orders'), batch = options.recommendations[0], sim = await read('simulation'), layout = await read('layout');
  const allocate = async () => { const order = await post('outbound-orders', { ...command(), skuId: batch.skuId, batchId: batch.batchId, quantity: 1 }); return (await post(`outbound-orders/${order.id}/allocate`, command())).allocations[0]; };
  const first = await allocate();
  const init = page.getByRole('form', { name: '初始化多车', exact: true });
  await init.getByRole('textbox', { name: '初始化原因', exact: true }).fill('Day25 三车恢复验收');
  await init.getByRole('button', { name: '初始化多车模式', exact: true }).click(); await page.getByTestId('fleet-status').waitFor();
  const source = layout.locations.find((l) => l.id === first.locationId).serviceCell, goal = layout.locations.find((l) => l.id === sim.staging[0].id).serviceCell;
  const cells = [];
  for (let z = goal.z; z <= source.z; z++) cells.push({ x: source.x, z });
  for (let x = source.x + 1; x <= goal.x; x++) cells.push({ x, z: goal.z });
  const config = page.getByRole('form', { name: '配置单容量资源', exact: true });
  await config.getByRole('textbox', { name: '资源 JSON', exact: true }).fill(JSON.stringify([{ id: 'loaded-lane', kind: 'AISLE', cells }]));
  await config.getByRole('textbox', { name: '资源配置原因', exact: true }).fill('Day25 loaded physical permit');
  await config.getByRole('button', { name: '保存单容量资源', exact: true }).click();
  let state;
  const poll = async (test, ms = 45000) => { const until = Date.now() + ms; while (Date.now() < until) { state = await read('fleet'); if (state.robots.some((r) => r.phase === 'ERROR')) throw new Error('Unexpected fleet ERROR'); if (test(state)) return; await page.waitForTimeout(60); } throw new Error('Fleet observation timed out'); };
  await poll((s) => s.resources.length === 1);
  const assign = async (allocation) => {
    const f = page.getByRole('form', { name: '分配多车任务', exact: true });
    await f.getByRole('combobox', { name: '多车任务来源', exact: true }).locator(`option[value="${allocation.id}"]`).waitFor({ state: 'attached' });
    await f.getByRole('combobox', { name: '分配车辆', exact: true }).selectOption('robot-2');
    await f.getByRole('combobox', { name: '多车任务来源', exact: true }).selectOption(allocation.id);
    await f.getByRole('combobox', { name: '多车任务目标', exact: true }).selectOption(sim.staging[0].id);
    await f.getByRole('textbox', { name: '分配原因', exact: true }).fill('Day25 UI assignment');
    const pending = page.waitForResponse((r) => r.url() === `${base}/fleet/assign` && r.request().method() === 'POST');
    await f.getByRole('button', { name: '确认分配到车辆', exact: true }).click(); const r = await pending;
    if (r.status() !== 201) throw new Error(await r.text());
  };
  const ui = async (button) => {
    const f = page.getByRole('form', { name: 'robot-2 故障恢复', exact: true });
    await f.getByRole('textbox', { name: 'robot-2 操作原因', exact: true }).fill('Day25 人工确认故障恢复');
    const pending = page.waitForResponse((r) => r.url() === `${base}/fleet/control` && r.request().method() === 'POST');
    await f.getByRole('button', { name: button, exact: true }).click(); const r = await pending;
    if (r.status() !== 201) throw new Error(`${button}: ${r.status()} ${await r.text()}`); return r.json();
  };
  await assign(first); const firstFault = await ui('注入故障');
  if (!['APPROACH', 'LOADING'].includes(firstFault.robots[1].phase)) throw new Error('Missed before-pickup fixture');
  const cancelled = await ui('取消未取货运输');
  if (cancelled.robots[1].taskId || !cancelled.robots[1].deviceFault || (await read('inventory')).summary.reserved !== 0) throw new Error('Cancellation did not release reservation or lost fault');
  const cancelledTaskId = firstFault.robots[1].taskId;
  await ui('维修继续');
  const second = await allocate(); await assign(second);
  await poll((s) => s.robots[1].carrying && s.robots[1].phase === 'TRANSPORT');
  const loaded = await ui('注入故障'), robot = loaded.robots[1];
  if (!robot.carrying || robot.recoveryStatus !== 'NEEDS_RECOVERY' || loaded.resources[0].ownerId !== 'robot-2') throw new Error('Lost loaded physical resource');
  const rejected = await page.request.post(`${base}/fleet/control`, { headers, data: { robotId: 'robot-2', expectedTaskId: robot.taskId, action: 'CANCEL', reason: 'reject loaded cancellation' } });
  if (rejected.status() !== 409) throw new Error('Loaded cancellation allowed');
  await poll((s) => s.tick >= loaded.tick + 8);
  if (JSON.stringify(state.robots[1].to) !== JSON.stringify(robot.to) || state.robots[1].battery !== robot.battery || !state.robots[1].carrying || state.resources[0].ownerId !== 'robot-2') throw new Error('Fault lost pose/cargo/permit');
  if (!(await read('wms/reconcile')).consistent) throw new Error('Paused reconciliation failed');
  await page.getByRole('alert').filter({ hasText: 'NEEDS_RECOVERY' }).waitFor();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.fleetCount === '3');
  if (!await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)) throw new Error('Recovery page overflows viewport');
  await page.screenshot({ path: 'output/playwright/day-25/day-25-loaded-fault.png', fullPage: true });
  await page.reload(); await page.getByTestId('fleet-status').waitFor();
  const reload = await read('fleet'); if (reload.robots[1].taskId !== robot.taskId || !reload.robots[1].deviceFault || !reload.robots[1].carrying) throw new Error('Reload lost recovery');
  await ui('维修继续'); await poll((s) => s.robots[1].phase === 'COMPLETED');
  const final = await read('fleet'), inventory = await read('inventory'), reconciliation = await read('wms/reconcile');
  if (!reconciliation.consistent || inventory.summary.onHand !== 62 || inventory.summary.reserved !== 1 || final.resources[0].ownerId !== 'robot-2') throw new Error('Final ledger/occupancy mismatch');
  await page.getByRole('row').filter({ hasText: 'robot-2' }).filter({ hasText: 'COMPLETED' }).waitFor();
  await page.screenshot({ path: 'output/playwright/day-25/day-25-repaired.png', fullPage: true });
  const events = []; let after = 0;
  while (after < final.watermark) { const b = (await read(`simulation/events?after=${after}`)).events.filter((e) => e.seq <= final.watermark); if (!b.length) throw new Error('History gap'); events.push(...b); after = b.at(-1).seq; }
  const controls = events.filter((e) => ['FLEET_FAULT', 'FLEET_REPAIR', 'FLEET_CANCEL'].includes(e.kind));
  if (controls.length !== 5 || controls.some((e) => !e.payload.actorId || !e.payload.reason)) throw new Error('Control audit history missing');
  if (events.filter((e) => e.kind === 'TRANSPORT_TAKEN').length !== 1 || events.filter((e) => e.kind === 'TRANSPORT_DROPPED').length !== 1 || events.filter((e) => e.kind === 'TRANSPORT_CANCELLED').length !== 1) throw new Error('Duplicate ledger stages');
  for (const e of events.filter((e) => e.kind === 'FLEET_TICK')) {
    const rs = e.payload.robots; if (new Set(rs.map((r) => `${r.cell.x}:${r.cell.z}`)).size !== 3) throw new Error('Overlapping cars');
    const r = rs[1]; if (r.deviceFault && r.taskId === robot.taskId && JSON.stringify(r.cell) !== JSON.stringify(robot.to)) throw new Error('Durable fault moved');
  }
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('viewer@demo.local');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByTestId('fleet-status').waitFor();
  if (!await page.getByRole('form', { name: 'robot-2 故障恢复', exact: true }).getByRole('button', { name: '注入故障', exact: true }).isDisabled()) throw new Error('Viewer writable');
  const denied = await page.request.post(`${base}/fleet/control`, { headers, data: { robotId: 'robot-2', expectedTaskId: robot.taskId, action: 'FAULT', reason: 'deny viewer' } });
  if (denied.status() !== 403) throw new Error('Viewer control accepted');
  return { passed: true, capturedAt: new Date().toISOString(), robots: 3, cancelledTaskId, resumedClaim: robot.taskId, loadedFaultTick: loaded.tick,
    loadedFaultPhase: robot.phase, loadedPose: robot.to, completedTick: final.tick, watermark: final.watermark, checkedEvents: events.length,
    checkedTickBatches: events.filter((e) => e.kind === 'FLEET_TICK').length, controls: controls.map((e) => e.kind), cargoPreserved: true, reloadPreserved: true,
    permitPreserved: true, final: inventory.summary, reconciled: true, loadedCancelStatus: rejected.status(), viewerStatus: denied.status() };
}
