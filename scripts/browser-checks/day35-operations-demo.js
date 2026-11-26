async (page) => {
  const origin = 'http://127.0.0.1:18136';
  if (new URL(page.url()).origin !== origin) throw new Error('Isolated Day35 QA only');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const sockets = [];
  page.on('websocket', (ws) => { if (new URL(ws.url()).pathname.startsWith('/socket.io/')) sockets.push(ws); });
  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  const [, spaceId, warehouseId] = new URL(page.url()).pathname.split('/').filter(Boolean);
  const base = `${origin}/api/spaces/${spaceId}/warehouses/${warehouseId}/`;
  // The fixture writer is independent of browser network emulation. It never assigns a task.
  const writer = page.context().request;
  const read = async (path) => {
    const r = await writer.get(base + path);
    assert(r.ok(), `${path}: ${r.status()}`); return r.json();
  };
  const post = async (path, data) => {
    const r = await writer.post(base + path, { data, headers: { 'X-Requested-With': 'WarehouseTwin' } });
    assert(r.status() === 201, `${path}: ${r.status()} ${await r.text()}`); return r.json();
  };
  const uiWrites = [], archiveReads = [];
  let replaying = false;
  page.on('request', (request) => {
    if (!request.url().startsWith(base)) return;
    const path = request.url().slice(base.length);
    if (!['GET', 'HEAD'].includes(request.method())) uiWrites.push({ path, replaying });
    else if (replaying) archiveReads.push(path);
  });
  const status = (name) => page.locator(`[data-testid="warehouse-realtime"][data-status="${name}"]`);
  const metric = (name, n) => page.getByLabel('库存汇总').getByText(name, { exact: true }).locator('..').locator('strong')
    .filter({ hasText: new RegExp(`^${n} 件$`) });
  const liveRow = page.getByRole('table', { name: '车队状态' }).getByRole('row').filter({ hasText: 'robot-2' });
  const checkbox = page.getByRole('button', { name: '确认分配到车辆', exact: true });
  const chapters = [], started = Date.now();
  const show = async (title, detail, focus) => {
    if (focus) await focus.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.evaluate(({ title, detail }) => {
      let card = document.getElementById('day35-caption');
      if (!card) {
        card = document.createElement('aside'); card.id = 'day35-caption';
        card.style.cssText = 'position:fixed;left:22px;right:22px;top:18px;z-index:9999;padding:14px 20px;background:#092331;color:#fff;border:2px solid #46c5ba;border-radius:10px;pointer-events:none;font:20px/1.5 system-ui';
        document.body.append(card);
      }
      const caption = document.createElement('strong'); caption.textContent = title;
      const line = document.createElement('div'); line.textContent = detail;
      card.replaceChildren(caption, line);
    }, { title, detail });
    chapters.push({ title, elapsedMs: Date.now() - started });
    await page.waitForTimeout(2800);
  };
  const waitFleet = async (predicate) => {
    for (let i = 0; i < 180; i++) {
      const fleet = await read('fleet');
      assert(fleet.robots.every((r) => r.phase !== 'ERROR'), 'Fleet entered ERROR');
      if (predicate(fleet)) return fleet;
      await page.waitForTimeout(100);
    }
    throw new Error('Fleet did not reach expected state');
  };
  await status('connected').waitFor();
  const { layoutVersion, locations } = await read('layout');
  const initial = (await read('inventory')).summary;
  const staging = (await read('simulation')).staging[0].id;
  const goal = locations.find((entry) => entry.id === staging).serviceCell;
  const allocate = async (label) => {
    const { recommendations: [item] } = await read('outbound-orders');
    const command = (action) => ({ key: `day35-${label}-${action}-${Date.now()}`, reason: 'Day35 隔离运营演练' });
    const order = await post('outbound-orders', { ...command('order'), skuId: item.skuId, batchId: item.batchId, quantity: 1 });
    return (await post(`outbound-orders/${order.id}/allocate`, command('allocate'))).allocations[0];
  };
  await post('fleet/initialize', { count: 3, reason: 'Day35 隔离运营演练' });
  const allocation = await allocate('first');
  const form = page.getByRole('form', { name: '分配多车任务', exact: true });
  const source = form.getByLabel('多车任务来源');
  await source.locator(`option[value="${allocation.id}"]`).waitFor({ state: 'attached' });
  await form.getByLabel('分配车辆').selectOption('robot-2');
  await source.selectOption(allocation.id);
  await form.getByLabel('多车任务目标').selectOption(staging);
  await form.getByLabel('分配原因').fill('运营演练：搬运一件至暂存');
  await show('01 / 实时仓库 · 分配一次任务', '把 1 件出库货交给 robot-2 搬到暂存；此时没有发运。', form);
  const assigned = page.waitForResponse((r) => r.url() === base + 'fleet/assign' && r.request().method() === 'POST');
  await checkbox.click();
  const assignment = await assigned;
  assert(assignment.status() === 201, 'Assignment did not commit');
  const claim = (await assignment.json()).id;
  await liveRow.getByText(claim, { exact: false }).waitFor();
  const ledgerTask = (await read('fleet')).robots.find((r) => r.id === 'robot-2')?.ledgerTaskId;
  assert(ledgerTask && (await liveRow.innerText()).includes(ledgerTask), 'Live ledger task missing');
  await show('02 / 实时任务确认', `robot-2 的车队认领号 ${claim.slice(0, 8)}；回放菜单按同一单的账本编号 ${ledgerTask.slice(0, 8)} 查找。`, liveRow);

  const navigation = (closed, revision) => post('fleet/navigation', { cells: [goal], closed, expectedRevision: revision, reason: 'Day35 暂存入口演练' });
  const paused = await navigation(true, 0);
  assert(paused.robots.find((r) => r.id === 'robot-2')?.navigationIssue?.reason === 'NO_PATH', 'Closure did not pause the original task');
  const alert = page.getByRole('alert').filter({ hasText: 'robot-2 路径暂停：NO_PATH' });
  await alert.waitFor();
  const pausedStock = (await read('inventory')).summary;
  assert(pausedStock.onHand === initial.onHand && pausedStock.reserved === initial.reserved + 1, 'Unexpected paused stock');
  await show('03 / 封路告警 · 原任务暂停', `暂存入口 (${goal.x},${goal.z}) 封锁；NO_PATH 表示不能继续走，不等于取消任务。`, alert);

  let offlineWatermark;
  try {
    await page.context().setOffline(true);
    await status('offline').waitFor();
    await page.getByText('显示最后确认快照', { exact: true }).waitFor();
    assert(await checkbox.isDisabled(), 'Offline write control enabled');
    await show('04 / 浏览器离线 · 最后确认快照', `仍显示预占 ${pausedStock.reserved}；操作禁用。这不是仓库停止运行。`, status('offline'));
    await allocate('external');
    const reopened = await navigation(false, 1);
    assert(reopened.navigation.revision === 2, 'External reopen failed');
    offlineWatermark = (await read('inventory')).watermark;
    await metric('预占', pausedStock.reserved).waitFor();
  } finally { await page.context().setOffline(false); }
  await status('connected').waitFor();
  await page.waitForFunction((min) => Number(document.querySelector('[data-testid="warehouse-realtime"]')?.dataset.after) >= min, offlineWatermark);
  await metric('预占', pausedStock.reserved + 1).waitFor();
  await liveRow.getByText(claim, { exact: false }).waitFor();
  const latest = (await read('inventory')).summary;
  const liveAfter = Number(await status('connected').getAttribute('data-after'));
  assert(latest.onHand === pausedStock.onHand && latest.reserved === pausedStock.reserved + 1, 'Recovered summary diverged');
  await show('05 / 重连 · 补齐断线期间的提交', `独立测试端解除封路并新增 1 件预占；当前预占 ${latest.reserved}。搬运仍是原任务。`, page.getByLabel('库存汇总'));

  const connection = sockets.findLast((ws) => !ws.isClosed());
  assert(connection, 'No active live socket');
  const closed = connection.waitForEvent('close', { timeout: 5000 });
  const socketCount = sockets.length;
  replaying = true;
  await page.getByRole('link', { name: '演示仓库 A 历史回放', exact: true }).click();
  await closed;
  const replay = page.getByRole('region', { name: '仓库历史回放' });
  await replay.getByText('回放 · 只读', { exact: true }).waitFor();
  const position = page.getByTestId('replay-position');
  const stock = page.getByTestId('replay-stock');
  const slider = page.getByRole('slider', { name: '时间轴' });
  const row = replay.getByRole('table', { name: '全车历史状态' }).getByRole('row').filter({ hasText: 'robot-2' });
  const nav = page.getByTestId('replay-navigation');
  await slider.waitFor();
  await replay.getByLabel('任务高亮').selectOption(claim);
  await slider.press('Home');
  const first = Number(await position.getAttribute('data-index'));
  const max = Number(await slider.getAttribute('max'));
  let found = false;
  for (let index = first; index <= max; index++) {
    if ((await nav.textContent()).includes('封路修订 1') && (await row.getAttribute('data-highlighted')) === 'true') { found = true; break; }
    await slider.press('ArrowRight');
  }
  assert(found, 'Cannot seek to the original task in the closure archive');
  const archivedVersion = await position.innerText();
  const archive = await read(`history/layouts/${layoutVersion.id}`);
  const playbackStock = `现存 ${pausedStock.onHand} · 预占 ${pausedStock.reserved} · 可用 ${pausedStock.available} · 待检 ${pausedStock.hold}`;
  assert(archivedVersion.includes(`归档布局 v${archive.layoutVersion.version} ·`) && archive.layoutVersion.id === layoutVersion.id, 'Wrong archived layout');
  assert(await stock.innerText() === playbackStock && (await row.innerText()).includes(ledgerTask), 'Wrong archived inventory or ledger task');
  await replay.getByLabel('历史三维仓库').locator('canvas').waitFor();
  await show('06 / 历史回放 · 只读时间轴', `同一账本任务 ${ledgerTask.slice(0, 8)}：封路时使用归档布局 v${archive.layoutVersion.version}、预占 ${pausedStock.reserved}，不受实时预占 ${latest.reserved} 影响。`, position);
  assert(!await checkbox.count() && sockets.length === socketCount && sockets.every((ws) => ws.isClosed()) && !uiWrites.some((r) => r.replaying), 'Replay opened a live socket or write');
  assert(archiveReads.includes(`history/layouts/${layoutVersion.id}`) && archiveReads.every((path) => path.startsWith('history')), 'Replay did not isolate archive GETs');
  const replaySeq = Number(await position.getAttribute('data-seq'));
  replaying = false;
  await replay.getByRole('link', { name: '返回实时仓库', exact: true }).click();
  await status('connected').waitFor();
  await metric('预占', latest.reserved).waitFor();
  await liveRow.getByText(claim, { exact: false }).waitFor();
  const final = await waitFleet((f) => f.robots.find((r) => r.id === 'robot-2')?.taskId === claim && f.robots.find((r) => r.id === 'robot-2')?.phase === 'COMPLETED');
  const events = [];
  while (events.length < final.watermark) {
    const chunk = (await read(`simulation/events?after=${events.length}`)).events.filter((e) => e.seq <= final.watermark);
    assert(chunk.length && chunk.every((e, i) => e.seq === events.length + i + 1), 'Durable event gap');
    events.push(...chunk);
  }
  const counts = Object.fromEntries(['FLEET_ASSIGNED', 'FLEET_NAVIGATION_CHANGED', 'TRANSPORT_TAKEN', 'TRANSPORT_DROPPED', 'OUTBOUND_DISPATCHED']
    .map((kind) => [kind, events.filter((e) => e.kind === kind).length]));
  assert(uiWrites.length === 1 && uiWrites[0].path === 'fleet/assign' && counts.FLEET_ASSIGNED === 1 && counts.FLEET_NAVIGATION_CHANGED === 2
    && counts.TRANSPORT_TAKEN === 1 && counts.TRANSPORT_DROPPED === 1 && counts.OUTBOUND_DISPATCHED === 0, 'Duplicate assignment, incorrect navigation or stock posting');
  assert((await read('wms/reconcile')).consistent, 'Stock reconciliation failed');
  await show('07 / 返回实时 · 原任务只落货一次', `仓内取放各 1 次，不等于发运；现存仍 ${latest.onHand} 件，库存对账通过。`, liveRow);
  return { passed: true, capturedAt: new Date().toISOString(), claim, ledgerTask,
    goal, offlineWatermark, liveAfter, replaySeq, archiveVersion: archive.layoutVersion.version, archiveReaders: [...new Set(archiveReads)].map((path) => path.split('?')[0]),
    stock: { offline: pausedStock.reserved, recovered: latest.reserved, replay: pausedStock.reserved, onHand: latest.onHand },
    historyWrites: 0, archiveOpenedSockets: 0, uiWrites, counts, watermark: final.watermark, chapters };
}
