async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  if (await page.getByRole('textbox', { name: '密码', exact: true }).isVisible()) {
    await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const scene = page.url(), [, spaceId, warehouseId] = new URL(scene).pathname.split('/').filter(Boolean);
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const read = async (path) => { const r = await page.request.get(`${base}/${path}`); if (!r.ok()) throw new Error(`GET ${path}: ${r.status()}`); return r.json(); };
  const post = async (path, data) => { const r = await page.request.post(`${base}/${path}`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data }); if (!r.ok()) throw new Error(`POST ${path}: ${r.status()} ${await r.text()}`); return r.json(); };
  const request = () => ({ key: `day23-${Date.now()}-${Math.random().toString(16).slice(2)}`, reason: 'Day23 real browser fixture' });
  const initialize = page.getByRole('form', { name: '初始化多车', exact: true });
  await initialize.getByRole('combobox', { name: '车队规模', exact: true }).selectOption('5');
  await initialize.getByRole('textbox', { name: '初始化原因', exact: true }).fill('Day23 初始化五台软件车');
  await initialize.getByRole('button', { name: '初始化多车模式', exact: true }).click();
  await page.getByTestId('fleet-status').filter({ hasText: '车数 5' }).waitFor();
  const initial = await read('fleet');
  if (initial.robots.length !== 5 || new Set(initial.robots.map((r) => `${r.to.x}:${r.to.z}`)).size !== 5) throw new Error('Five distinct parked cells not persisted');
  const definitions = [
    { id: 'charger', kind: 'CHARGING', cells: [initial.robots[0].to] },
    { id: 'parking', kind: 'PARKING', cells: [initial.robots[1].to] },
    { id: 'aisle-main', kind: 'AISLE', cells: Array.from({ length: 20 }, (_, i) => ({ x: i + 7, z: 3 })) },
    { id: 'out-station', kind: 'WORKSTATION', cells: [{ x: 27, z: 3 }] },
  ];
  const config = page.getByRole('form', { name: '配置单容量资源', exact: true });
  await config.getByRole('textbox', { name: '资源 JSON', exact: true }).fill(JSON.stringify(definitions));
  await config.getByRole('textbox', { name: '资源配置原因', exact: true }).fill('Day23 单容量通道及工作站验证');
  await config.getByRole('button', { name: '保存单容量资源', exact: true }).click();
  await page.getByRole('table', { name: '资源许可', exact: true }).waitFor();
  const configured = await read('fleet');
  if (configured.resources.length !== 4 || configured.resources.find((r) => r.id === 'charger').ownerId !== 'robot-1') throw new Error('Idle physical permit missing');
  await page.waitForFunction(() => { const c = document.querySelector('canvas'); return c?.dataset.fleetCount === '5' && c.dataset.cameraTransition === 'idle' && JSON.parse(c.dataset.fleetPositions || '[]').length === 5; });
  const inboundOptions = await read('inbound-orders'), outboundOptions = await read('outbound-orders'), layout = await read('layout');
  const sku = inboundOptions.skus.find((r) => r.code === 'SKU-A'), batch = outboundOptions.recommendations.find((r) => r.skuId === sku.id);
  let observedCarrying = 0;
  async function assign(robotId, kind, source, target) {
    const form = page.getByRole('form', { name: '分配多车任务', exact: true });
    for (let attempt = 0; attempt < 8; attempt++) {
      await form.getByRole('combobox', { name: '分配车辆', exact: true }).selectOption(robotId);
      await form.getByRole('combobox', { name: '多车任务类型', exact: true }).selectOption(kind);
      await form.getByRole('combobox', { name: '多车任务来源', exact: true }).locator(`option[value="${source}"]`).waitFor({ state: 'attached' });
      await form.getByRole('combobox', { name: '多车任务来源', exact: true }).selectOption(source);
      await form.getByRole('combobox', { name: '多车任务目标', exact: true }).selectOption(target);
      await form.getByRole('textbox', { name: '分配原因', exact: true }).fill('Day23 浏览器真实分配');
      const response = page.waitForResponse((r) => r.url() === `${base}/fleet/assign` && r.request().method() === 'POST');
      await form.getByRole('button', { name: '确认分配到车辆', exact: true }).click();
      const result = await response;
      if (result.status() === 201) return result.json();
      if (result.status() !== 409) throw new Error(await result.text());
      await page.waitForTimeout(75);
    }
    throw new Error('Could not assign after version-conflict retries');
  }
  const completedClaims = [];
  for (const [robotId, code] of [['robot-1', 'R02-3-L1'], ['robot-2', 'R02-1-L1'], ['robot-3', 'R02-2-L1']]) {
    const receipt = await post('inbound-orders', { ...request(), skuId: sku.id, batchCode: batch.batchCode, quantity: 1,
      qcLocationId: inboundOptions.qcLocations[0].id, producedAt: null, expiresAt: batch.expiresAt });
    await post(`inbound-orders/${receipt.id}/receive`, request());
    await post(`inbound-orders/${receipt.id}/inspect`, { ...request(), decision: 'PASS' });
    const target = layout.locations.find((r) => r.code === code);
    const claim = await assign(robotId, 'PUTAWAY', receipt.id, target.id); completedClaims.push(claim.id);
    const deadline = Date.now() + 45000;
    let complete = false;
    while (Date.now() < deadline) {
      const data = await read('fleet'), robot = data.robots.find((r) => r.id === robotId);
      if (robot.phase === 'ERROR') throw new Error(robot.error);
      if (robot.carrying) observedCarrying++;
      if (robot.phase === 'COMPLETED' && robot.taskId === claim.id) { complete = true; break; }
      await page.waitForTimeout(100);
    }
    if (!complete) throw new Error('Sequential putaway did not complete');
  }
  if (!observedCarrying) throw new Error('No real carrying state was observed');
  const afterPutaway = await read('inventory');
  if (afterPutaway.summary.onHand !== 65 || afterPutaway.summary.reserved !== 0) throw new Error('Putaway changed stock or left reservations');
  const staging = (await read('simulation')).staging[0];
  const claims = [];
  for (let i = 1; i <= 5; i++) {
    const order = await post('outbound-orders', { ...request(), skuId: sku.id, batchId: batch.batchId, quantity: 1 });
    const allocated = await post(`outbound-orders/${order.id}/allocate`, request());
    claims.push(await assign(`robot-${i}`, 'OUTBOUND', allocated.allocations[0].id, staging.id));
  }
  let state = await read('fleet'), observedWaits = 0, resourceWaitObservations = 0;
  const targetTick = state.tick + 70;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && state.tick < targetTick) {
    await page.waitForTimeout(100); state = await read('fleet');
    if (new Set(state.robots.map((r) => `${r.to.x}:${r.to.z}`)).size !== 5 || state.robots.some((r) => r.phase === 'ERROR')) throw new Error('Collision or fleet error');
    observedWaits += state.robots.filter((r) => r.waitReason).length;
    resourceWaitObservations += state.robots.filter((r) => r.waitReason === 'RESOURCE_BUSY' && r.resourceWaitId).length;
  }
  if (!observedWaits || !state.robots.some((r) => r.waitTicks > 0)) throw new Error('Expected observable contention, not fake completion');
  if (!resourceWaitObservations) throw new Error('No actual resource wait observed');
  if (new Set(state.robots.map((r) => r.taskId)).size !== 5 || !state.robots.every((r) => claims.some((c) => c.id === r.taskId && c.robotId === r.id))) throw new Error('Task ownership differs from API claims');
  const owners = state.robots.map((r) => [r.id, r.taskId]);
  await page.reload();
  await page.getByTestId('fleet-status').waitFor();
  const reloaded = await read('fleet');
  if (reloaded.tick < state.tick || JSON.stringify(reloaded.robots.map((r) => [r.id, r.taskId])) !== JSON.stringify(owners)) throw new Error('Reload reset tick or task owners');
  await page.waitForFunction(() => { const c = document.querySelector('canvas'); return c?.dataset.fleetCount === '5' && c.dataset.cameraTransition === 'idle' && JSON.parse(c.dataset.fleetPositions || '[]').length === 5; });
  await page.screenshot({ path: 'output/playwright/day-23/day-23-resources.png', fullPage: true });
  const events = []; let after = 0;
  while (after < reloaded.watermark) {
    const data = await read(`simulation/events?after=${after}`), bounded = data.events.filter((e) => e.seq <= reloaded.watermark);
    if (!bounded.length) throw new Error('Missing durable events'); events.push(...bounded); after = bounded.at(-1).seq;
  }
  if (events.some((e, i) => e.seq !== i + 1)) throw new Error('Event gap');
  let previous = initial.robots.map((r) => ({ id: r.id, cell: r.to }));
  for (const event of events.filter((e) => e.kind === 'FLEET_TICK')) {
    const robots = event.payload.robots;
    for (const resource of event.payload.resources) {
      const occupants = robots.filter((r) => resource.cells.some((p) => p.x === r.cell.x && p.z === r.cell.z));
      if (occupants.length > 1 || (occupants[0]?.id ?? null) !== resource.ownerId) throw new Error('Durable permit disagrees with occupancy');
    }
    if (new Set(robots.map((r) => `${r.cell.x}:${r.cell.z}`)).size !== 5) throw new Error('Persisted same-cell collision');
    for (const robot of robots) {
      const old = previous.find((r) => r.id === robot.id);
      if ((old.cell.x !== robot.cell.x || old.cell.z !== robot.cell.z) && previous.some((r) => r.id !== robot.id && r.cell.x === robot.cell.x && r.cell.z === robot.cell.z)) throw new Error('Persisted occupied-cell entry / edge swap');
    }
    previous = robots;
  }
  const inventory = await read('inventory'), reconciliation = await read('wms/reconcile');
  if (!reconciliation.consistent || inventory.summary.onHand !== 65 || inventory.summary.reserved !== 5) throw new Error('Fleet ledger mismatch');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('viewer@demo.local');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByTestId('fleet-status').waitFor();
  if ((await read('fleet')).role !== 'VIEWER' || !await page.getByRole('form', { name: '分配多车任务', exact: true }).getByRole('button', { name: '确认分配到车辆', exact: true }).isDisabled()) throw new Error('Viewer controls are writable');
  const forbidden = await page.request.post(`${base}/fleet/resources`, { headers: { 'X-Requested-With': 'WarehouseTwin' }, data: { resources: definitions, reason: 'must reject viewer' } });
  const crossed = await page.request.get(`http://127.0.0.1:15174/api/spaces/10000000-0000-4000-8000-000000000002/warehouses/${warehouseId}/fleet`);
  if (forbidden.status() !== 403 || crossed.status() !== 404) throw new Error('Fleet permission/scope boundary failed');
  return { passed: true, capturedAt: new Date().toISOString(), completedClaims, observedCarrying,
    robots: reloaded.robots.length, tick: reloaded.tick, watermark: reloaded.watermark, observedWaits, resourceWaitObservations,
    state: reloaded, checkedEvents: events.length, checkedTickBatches: events.filter((e) => e.kind === 'FLEET_TICK').length,
    final: inventory.summary, reconciled: true, reloadPreserved: true, allConcurrentJobsCompleted: false,
    viewerReadOnly: true, viewerWriteStatus: forbidden.status(), crossScopeStatus: crossed.status() };
}
