async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`, headers = { 'X-Requested-With': 'WarehouseTwin' };
  const read = async (p) => { const r = await page.request.get(`${base}/${p}`); if (!r.ok()) throw new Error(`${p}: ${r.status()}`); return r.json(); };
  const post = async (p, data) => { const r = await page.request.post(`${base}/${p}`, { headers, data }); if (!r.ok()) throw new Error(`${p}: ${r.status()} ${await r.text()}`); return r.json(); };
  const clickPost = async (p, button) => {
    const response = page.waitForResponse((r) => r.url() === `${base}/fleet/${p}` && r.request().method() === 'POST');
    await button.click(); const r = await response;
    if (r.status() !== 201) throw new Error(`${p}: ${r.status()} ${await r.text()}`);
    return r.json();
  };
  const command = () => ({ key: `day26-${Date.now()}-${Math.random()}`, reason: 'Day26 browser fixture' });
  const initial = page.getByRole('form', { name: '初始化多车', exact: true });
  await initial.getByRole('textbox', { name: '初始化原因', exact: true }).fill('Day26 三车验收');
  await clickPost('initialize', initial.getByRole('button', { name: '初始化多车模式', exact: true }));
  const sim = await read('simulation'), layout = await read('layout'), target = sim.staging[0];
  const dock = layout.locations.find((l) => l.id === target.id).serviceCell;
  // A deterministic fixture puts the charge dock on the delivery cell, so charging can be observed without teleporting.
  const config = page.getByRole('form', { name: '配置单容量资源', exact: true });
  await config.getByRole('textbox', { name: '资源 JSON', exact: true }).fill(JSON.stringify([{ id: 'demo-dock', kind: 'CHARGING', cells: [dock] }]));
  await config.getByRole('textbox', { name: '资源配置原因', exact: true }).fill('Day26 演示充电位');
  await clickPost('resources', config.getByRole('button', { name: '保存单容量资源', exact: true }));
  const batch = (await read('outbound-orders')).recommendations[0];
  const order = await post('outbound-orders', { ...command(), skuId: batch.skuId, batchId: batch.batchId, quantity: 1 });
  const allocation = (await post(`outbound-orders/${order.id}/allocate`, command())).allocations[0];
  const assign = page.getByRole('form', { name: '分配多车任务', exact: true });
  await assign.getByRole('combobox', { name: '多车任务来源', exact: true }).locator(`option[value="${allocation.id}"]`).waitFor({ state: 'attached' });
  await assign.getByRole('combobox', { name: '分配车辆', exact: true }).selectOption('robot-2');
  await assign.getByRole('combobox', { name: '多车任务来源', exact: true }).selectOption(allocation.id);
  await assign.getByRole('combobox', { name: '多车任务目标', exact: true }).selectOption(target.id);
  await assign.getByRole('textbox', { name: '分配原因', exact: true }).fill('测量取放后电量');
  await clickPost('assign', assign.getByRole('button', { name: '确认分配到车辆', exact: true }));
  let state;
  const poll = async (test) => {
    const until = Date.now() + 45000;
    while (Date.now() < until) { state = await read('fleet'); if (test(state)) return; await page.waitForTimeout(75); }
    throw new Error('Fleet observation timeout');
  };
  await poll((s) => s.robots[1].phase === 'COMPLETED');
  const before = state, robot = before.robots[1];
  if (robot.battery >= 10000 || robot.carrying || before.resources[0].ownerId !== 'robot-2') throw new Error('Expected completed, drained, physically docked robot');
  const form = page.getByRole('form', { name: 'robot-2 充电', exact: true });
  await form.getByRole('textbox', { name: 'robot-2 充电原因', exact: true }).fill('Day26 补足电量');
  await clickPost('charge', form.getByRole('button', { name: '申请充电', exact: true }));
  await poll((s) => s.robots[1].battery === 10000 && !s.robots[1].charge);
  const after = state, replenished = after.robots[1];
  if (replenished.taskId !== robot.taskId || after.resources[0].ownerId !== 'robot-2' || JSON.stringify(replenished.to) !== JSON.stringify(dock)) throw new Error('Charge changed claim, position or physical owner');
  const events = (await read('simulation/events?after=0')).events.filter((e) => e.seq <= after.watermark);
  const orderEvent = events.find((e) => e.kind === 'FLEET_ASSIGNED'), chargeEvents = events.filter((e) => e.kind === 'FLEET_CHARGE');
  if (events.length !== after.watermark || chargeEvents.length !== 1 || orderEvent?.payload.requiredBattery !== 10000 - robot.battery + 20 ||
    events.filter((e) => e.kind === 'TRANSPORT_TAKEN').length !== 1 || events.filter((e) => e.kind === 'TRANSPORT_DROPPED').length !== 1 ||
    !(await read('wms/reconcile')).consistent) throw new Error('Energy audit / ledger mismatch');
  await form.getByText(/robot-2 · 100\.00%/).waitFor();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.fleetCount === '3');
  await page.screenshot({ path: 'output/playwright/day-26/day-26-charged.png', fullPage: true });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('viewer@demo.local');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click(); await form.waitFor();
  const denied = await page.request.post(`${base}/fleet/charge`, { headers, data: { robotId: 'robot-2', action: 'START', reason: 'deny viewer' } });
  if (denied.status() !== 403 || !await form.getByRole('button', { name: '申请充电', exact: true }).isDisabled()) throw new Error('Viewer write not blocked');
  return { passed: true, capturedAt: new Date().toISOString(), dock, batteryAfterDelivery: robot.battery, batteryAfterCharge: replenished.battery,
    requiredBattery: orderEvent.payload.requiredBattery, owner: after.resources[0].ownerId, chargeTicks: after.tick - before.tick,
    watermark: after.watermark, viewerStatus: denied.status(), reconciled: true };
}
