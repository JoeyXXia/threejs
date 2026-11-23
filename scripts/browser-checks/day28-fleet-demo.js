async (page) => {
  // Start from the administrator's logged-in warehouse picker in a fresh QA session.
  const origin = 'http://127.0.0.1:15174';
  if (new URL(page.url()).origin !== origin) throw new Error('Isolated QA only');
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  if (new URL(page.url()).origin !== origin || !spaceId || !warehouseId) throw new Error('Unexpected QA warehouse link');
  const base = origin + '/api/spaces/' + spaceId + '/warehouses/' + warehouseId;
  const read = async (p) => {
    const r = await page.request.get(base + '/' + p);
    if (!r.ok()) throw new Error(p + ': ' + r.status());
    return r.json();
  };
  const write = async (p, body, retries = 0) => {
    for (let i = 0; i <= retries; i++) {
      const r = await page.request.post(base + '/' + p, { data: body, headers: { 'X-Requested-With': 'WarehouseTwin' } });
      if (r.status() === 201) return r.json();
      if (r.status() !== 409 || i === retries) throw new Error(p + ': ' + r.status() + ' ' + await r.text());
      await page.waitForTimeout(35);
    }
  };
  const key = (c) => c.x + ':' + c.z;
  const require = (ok, why) => { if (!ok) throw new Error(why); };
  const options = await read('outbound-orders'), batch = options.recommendations[0], goal = (await read('simulation')).staging[0];
  const layout = await read('layout'), target = layout.locations.find((r) => r.id === goal.id).serviceCell;
  const cmd = () => ({ key: 'day28-' + Date.now() + '-' + Math.random(), reason: 'Day28 隔离演示' });
  async function allocate() {
    const order = await write('outbound-orders', { ...cmd(), skuId: batch.skuId, batchId: batch.batchId, quantity: 1 });
    return (await write('outbound-orders/' + order.id + '/allocate', cmd())).allocations[0];
  }
  const a = await allocate(), b = await allocate();
  const initial = await write('fleet/initialize', { count: 5, reason: '演示五台软件车' });
  const start = layout.locations.find((r) => r.id === a.locationId).serviceCell;
  require(key(start) === '5:4' && key(target) === '27:3', 'Unexpected warehouse demo geometry');
  const charger = { x: 27, z: 2 };
  const lane = [...Array.from({ length: 23 }, (_, i) => ({ x: i + 5, z: 3 })), start];
  await write('fleet/resources', { reason: '窄道与充电位容量为一', resources: [
    { id: 'aisle', kind: 'AISLE', cells: lane }, { id: 'dock', kind: 'CHARGING', cells: [charger] },
  ] });
  await page.waitForFunction(() => document.querySelector('canvas[data-fleet-count]')?.dataset.fleetCount === '5');
  await page.locator('canvas[data-fleet-count]').scrollIntoViewIfNeeded();
  const show = (title, explanation, state) => page.evaluate(({ title, explanation, state }) => {
    let hud = document.querySelector('#day28-hud');
    if (!hud) {
      hud = document.createElement('aside'); hud.id = 'day28-hud';
      hud.style.cssText = 'position:fixed;z-index:9999;inset:0 0 auto;background:#142f32;color:white;padding:16px 24px;border-bottom:4px solid #80b79a;font:18px Microsoft YaHei,sans-serif;pointer-events:none';
      document.body.append(hud);
      const canvas = document.querySelector('canvas[data-fleet-count]');
      window.scrollTo(0, window.scrollY + canvas.getBoundingClientRect().top - 235);
    }
    const caption = document.createElement('strong'); caption.textContent = 'WarehouseTwin · ' + title;
    const info = document.createElement('div'); info.textContent = explanation + '  |  已提交 tick ' + state.tick + ' · 水位 ' + state.watermark;
    const lines = state.robots.map((r) => {
      const el = document.createElement('div');
      el.textContent = r.id + ' (' + r.to.x + ',' + r.to.z + ') · ' + r.phase + (r.carrying ? ' 载货' : ' 空载') +
        ' · ' + (r.battery / 100).toFixed(2) + '% ' + [r.waitReason, r.resourceWaitId, r.blockerId, r.recoveryStatus].filter(Boolean).join(' / ');
      return el;
    });
    hud.replaceChildren(caption, info, ...lines);
  }, { title, explanation, state });
  const hold = async (title, subtitle, ms = 2800) => {
    const deadline = Date.now() + ms;
    do { await show(title, subtitle, await read('fleet')); await page.waitForTimeout(160); } while (Date.now() < deadline);
  };
  const poll = async (title, subtitle, predicate) => {
    const end = Date.now() + 40000;
    let s;
    do {
      s = await read('fleet');
      if (s.robots.some((r) => r.phase === 'ERROR')) throw new Error('Fleet ERROR: ' + JSON.stringify(s.robots));
      await show(title, subtitle, s); if (predicate(s)) return s;
      await page.waitForTimeout(90);
    } while (Date.now() < end);
    throw new Error(title + ' timed out: ' + JSON.stringify(s.robots.map((r) => [r.id, r.to, r.waitReason, r.phase])));
  };
  const assign = (robotId, allocationId) => write('fleet/assign', { robotId, kind: 'OUTBOUND', allocationId, stagingLocationId: goal.id, reason: 'Day28 分配' }, 8);
  await hold('01 / 五台离散软件车', '脚本字幕读自已提交的 API 快照；场景为原应用，非实体设备。');
  const first = await assign('robot-2', a.id);
  const routed = await read('fleet'), next = routed.robots[1].route[7];
  require(next, 'No future route to close');
  const detour = await write('fleet/navigation', { cells: [next], closed: true, expectedRevision: 0, reason: '封闭未来路线格' }, 8);
  require(detour.navigation.revision === 1 && !detour.robots[1].navigationIssue && !detour.robots[1].route.some((c) => key(c) === key(next)), 'Route did not detour');
  const arrival = await poll('02 / 封路后走新路线', '红框为封锁格；新路径不走 (' + next.x + ',' + next.z + ')。', (s) =>
    s.robots[1].carrying && s.robots[1].to.x >= 8 && s.robots[1].to.x <= 18 && s.resources.find((r) => r.id === 'aisle').ownerId === 'robot-2');
  const control = (action) => write('fleet/control', { robotId: 'robot-2', expectedTaskId: first.id, action, reason: 'Day28 载货故障演示' }, 8);
  const fault = await control('FAULT'), fixed = fault.robots[1];
  require(fixed.taskId === first.id && fixed.carrying && fixed.recoveryStatus === 'NEEDS_RECOVERY'
    && fault.resources.find((r) => r.id === 'aisle').ownerId === 'robot-2', 'Did not preserve carrying task and permit');
  const second = await assign('robot-1', b.id);
  const waiting = await poll('03 / 载货故障，窄道不释放', '故障车不动也不卸货；第二台车等待单容量通道。', (s) =>
    s.robots[0].waitReason === 'RESOURCE_BUSY' && s.robots[0].resourceWaitId === 'aisle');
  require(waiting.robots[0].blockerId === 'robot-2' && key(waiting.robots[1].to) === key(fixed.to)
    && waiting.robots[1].carrying && waiting.robots[1].battery === fixed.battery,
    'Fault changed committed pose, battery or cargo');
  await hold('03 / 安全等待，不伪造完成', 'RESOURCE_BUSY · aisle 的物理 owner 仍是 robot-2。');
  await control('REPAIR');
  const delivered = await poll('04 / 维修后接续原任务', '同一个 claim 续跑，只允许一次卸货；到站不等于腾出通道。', (s) => s.robots[1].phase === 'COMPLETED');
  require(delivered.robots[1].taskId === first.id && delivered.resources.find((r) => r.id === 'aisle').ownerId === 'robot-2', 'Repair reset claim or released occupied aisle');
  const started = await write('fleet/charge', { robotId: 'robot-2', action: 'START', reason: '空车去相邻充电位' }, 8);
  require(started.robots[1].charge, 'Charge did not start');
  const full = await poll('05 / 空车离开通道并充电', '真实移动后才释放窄道；充满电后停车仍占充电位。', (s) =>
    s.robots[1].battery === 10000 && !s.robots[1].charge);
  require(key(full.robots[1].to) === key(charger) && full.resources.find((r) => r.id === 'dock').ownerId === 'robot-2'
    && full.resources.find((r) => r.id === 'aisle').ownerId !== 'robot-2', 'Charging did not release the aisle or retain the physical dock');
  await hold('05 / 已充满，仍占充电位', 'robot-2：' + (delivered.robots[1].battery / 100).toFixed(2) + '% → 100.00%；robot-1 可继续申请通行。');
  const final = await poll('06 / 等待第二单落货', '仓内取放不等于发运；落货后查库存、对账与持久事件。', (s) => s.robots[0].phase === 'COMPLETED');
  require(final.robots[0].taskId === second.id, 'Second owner changed');
  const inventory = await read('inventory');
  require(inventory.summary.onHand === 62 && inventory.summary.reserved === 2 && (await read('wms/reconcile')).consistent, 'Ledger mismatch');
  const events = [];
  while (events.length < final.watermark) {
    const chunk = (await read('simulation/events?after=' + events.length)).events.filter((e) => e.seq <= final.watermark);
    require(chunk.length > 0 && chunk.every((e, i) => e.seq === events.length + i + 1), 'Missing or duplicate durable events');
    events.push(...chunk);
  }
  let prev = initial.robots.map((r) => ({ id: r.id, cell: r.to })), ticks = 0;
  for (const { payload } of events.filter((e) => e.kind === 'FLEET_TICK')) {
    const robots = payload.robots;
    require(payload.tick === ++ticks && robots.length === 5 && new Set(robots.map((r) => key(r.cell))).size === 5, 'Tick gap or same-cell collision');
    for (const r of robots) {
      const before = prev.find((p) => p.id === r.id).cell;
      require(r.cell.x >= 0 && r.cell.z >= 0 && r.cell.x < layout.layoutVersion.width && r.cell.z < layout.layoutVersion.depth
        && Math.abs(before.x - r.cell.x) + Math.abs(before.z - r.cell.z) <= 1
        && !prev.some((p) => p.id !== r.id && key(p.cell) === key(r.cell))
        && !payload.navigation.closed.some((p) => key(p) === key(r.cell)), 'Invalid movement or closure entry');
      require(!layout.racks.some((p) => r.cell.x >= p.gridX && r.cell.x < p.gridX + p.sizeX
        && r.cell.z >= p.gridZ && r.cell.z < p.gridZ + p.sizeZ), 'Entered a rack');
    }
    for (const res of payload.resources) {
      const cars = robots.filter((r) => res.cells.some((c) => key(c) === key(r.cell)));
      require(cars.length <= 1 && (cars[0]?.id ?? null) === res.ownerId, 'Resource owner/pose mismatch');
    }
    prev = robots;
  }
  const counts = Object.fromEntries(['TRANSPORT_TAKEN', 'TRANSPORT_DROPPED', 'OUTBOUND_DISPATCHED', 'FLEET_FAULT', 'FLEET_REPAIR', 'FLEET_CHARGE'].map((k) => [k, events.filter((e) => e.kind === k).length]));
  require(counts.TRANSPORT_TAKEN === 2 && counts.TRANSPORT_DROPPED === 2 && counts.FLEET_FAULT === 1
    && counts.FLEET_REPAIR === 1 && counts.FLEET_CHARGE === 1 && counts.OUTBOUND_DISPATCHED === 0 && ticks === final.tick, 'Durable action count mismatch');
  await hold('06 / 两单搬运完成，对账一致', '现存 ' + inventory.summary.onHand + '，预占 ' + inventory.summary.reserved + '；已核对 ' + ticks + ' 个提交 tick。未发运。', 4000);
  await page.screenshot({ path: 'output/playwright/day-28/day-28-final.png' });
  return { passed: true, capturedAt: new Date().toISOString(), closed: next, detourTick: detour.tick, arrivalTick: arrival.tick, faultTick: fault.tick, faultCell: fixed.to,
    waitTick: waiting.tick, deliveredTick: delivered.tick, fullTick: full.tick, batteryBefore: delivered.robots[1].battery,
    batteryAfter: full.robots[1].battery, finalTick: final.tick, watermark: final.watermark, counts, inventory: inventory.summary };
}
