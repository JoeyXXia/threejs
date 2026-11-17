async (page) => {
  // Fresh ordinary QA seed; log in and start recording before this callback.
  // Delays only make the video readable. Business assertions use committed API state.
  const scene = page.url();
  const [, spaceId, warehouseId] = new URL(scene).pathname.split('/').filter(Boolean);
  if (!spaceId || !warehouseId || !scene.endsWith(warehouseId)) throw new Error('Start from the warehouse scene after login');
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const began = Date.now(), checkpoints = [], chapters = [];
  const read = async (path) => { const r = await page.request.get(`${base}/${path}`); if (!r.ok()) throw new Error(`${path}: ${r.status()}`); return r.json(); };
  async function show(locator, milliseconds = 1000) {
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(milliseconds);
  }
  async function write(form, button, suffix) {
    const pending = page.waitForResponse((r) => r.request().method() === 'POST' && r.url() === `${base}/${suffix}`);
    await form.getByRole('button', { name: button, exact: true }).click();
    const r = await pending;
    if (r.status() !== 201) throw new Error(`${suffix}: ${r.status()} ${await r.text()}`);
    return r.json();
  }
  // Three reads avoid mixing inventory from one tick with pose from the next.
  async function confirmed(phase, taskId) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await read('simulation'), inventory = await read('inventory'), after = await read('simulation');
      if (after.runtime?.phase === 'ERROR') throw new Error(after.runtime.error);
      if (state.watermark === inventory.watermark && state.watermark === after.watermark
        && (!phase || state.runtime?.phase === phase) && (!taskId || state.runtime?.taskId === taskId)) return { state, inventory };
      await page.waitForTimeout(20);
    }
    throw new Error(`No coherent snapshot for ${phase ?? 'current state'}`);
  }
  const initial = await confirmed();
  if (initial.inventory.summary.onHand !== 62 || initial.state.runtime !== null) throw new Error('Use a new QA seed, not a partially executed demo');
  const layout = await read('layout');
  const storage = layout.locations.find((l) => l.kind === 'STORAGE' && !initial.inventory.balances.some((b) => b.locationId === l.id && b.onHand > 0));
  if (!storage) throw new Error('No empty storage in fixture');
  const label = (id) => layout.locations.find((l) => l.id === id)?.code ?? 'TRANSIT';
  function chapter(name, inventory) {
    chapters.push({ name, scriptSeconds: Number(((Date.now() - began) / 1000).toFixed(3)), summary: inventory.summary });
  }
  chapter('初始库存', initial.inventory);
  await show(page.getByLabel('库存汇总', { exact: true }));
  await page.goto(`${scene}/inbound`);
  const batchCode = `DAY21-${Date.now()}`;
  const create = page.getByRole('form', { name: '创建入库单', exact: true });
  await create.getByRole('textbox', { name: '批次编号', exact: true }).fill(batchCode);
  await create.getByRole('spinbutton', { name: '数量（件）', exact: true }).fill('4');
  await create.getByRole('textbox', { name: '创建原因', exact: true }).fill('Day21 单车演示：收货 4 件');
  const receipt = await write(create, '创建入库单', 'inbound-orders');
  const article = page.getByRole('article', { name: `入库单 ${batchCode} ${receipt.id}`, exact: true });
  await article.getByRole('textbox', { name: '操作原因', exact: true }).fill('到货核对 4 件，进入 QC HOLD');
  await write(article, '确认全量收货', `inbound-orders/${receipt.id}/receive`);
  const received = (await confirmed()).inventory;
  if (received.summary.onHand !== 66 || received.summary.hold !== 11) throw new Error('Receipt did not enter HOLD');
  chapter('收货进入 QC HOLD', received);
  await show(article);
  await article.getByRole('textbox', { name: '操作原因', exact: true }).fill('质量检验通过，仍在 QC，尚未上架');
  await write(article, '提交全量质检', `inbound-orders/${receipt.id}/inspect`);
  const passed = (await confirmed()).inventory;
  if (passed.summary.onHand !== 66 || passed.summary.hold !== 7) throw new Error('Inspection changed total or failed to release');
  chapter('质检放行，货物仍在 QC', passed);
  await show(article);

  async function inspect(kind, phase, taskId, sourceId, targetId) {
    const { state, inventory } = await confirmed(phase, taskId);
    const cargo = inventory.balances.filter((b) => b.batch.id === receipt.batchId && b.onHand > 0);
    const moving = ['TRANSPORT', 'UNLOADING'].includes(phase), complete = phase === 'COMPLETED';
    if (cargo.length !== 1 || cargo[0].onHand !== 4 || Boolean(cargo[0].transit) !== moving
      || cargo[0].reserved !== (complete && kind === 'PUTAWAY' ? 0 : 4) || inventory.summary.onHand !== 66
      || (!moving && cargo[0].locationId !== (complete ? targetId : sourceId))) throw new Error(`${kind}/${phase}: cargo identity, quantity or reservation mismatch`);
    const sample = { kind, phase, taskId, tick: state.runtime.tick, watermark: state.watermark,
      locationId: cargo[0].locationId, location: label(cargo[0].locationId), transit: Boolean(cargo[0].transit),
      onHand: cargo[0].onHand, reserved: cargo[0].reserved, warehouseOnHand: inventory.summary.onHand,
      capturedAt: inventory.asOf, scriptSeconds: Number(((Date.now() - began) / 1000).toFixed(3)) };
    checkpoints.push(sample);
    return { state, inventory };
  }
  async function transitView(kind, taskId) {
    // The live runner keeps progressing. No fabricated pause, direct DB write or route stub.
    await page.goto(`${scene}/wms`);
    await page.getByRole('combobox', { name: '批次', exact: true }).selectOption(receipt.batchId);
    const row = page.getByRole('table', { name: '批次余额', exact: true }).getByRole('row')
      .filter({ hasText: kind === 'PUTAWAY' ? 'PUTAWAY-' : 'TRANSIT-' });
    await row.waitFor();
    const cells = await row.getByRole('cell').allTextContents();
    if (cells[2] !== '4' || cells[3] !== '4') throw new Error('Transit UI did not show four physical/reserved pieces while carrying');
    await page.screenshot({ path: `output/playwright/day-21/day-21-${kind.toLowerCase()}-transit.png`, fullPage: true });
    await show(row, 700);
    await page.goto(scene);
    await page.getByTestId('robot-status').filter({ hasText: taskId }).waitFor();
    await page.locator('canvas').scrollIntoViewIfNeeded();
  }
  async function run(kind, startInput, sourceId, targetId) {
    await page.goto(scene);
    await page.getByRole('combobox', { name: '任务类型', exact: true }).selectOption(kind);
    if (kind === 'PUTAWAY') {
      await page.getByRole('combobox', { name: '已放行入库单', exact: true }).selectOption(receipt.id);
      await page.getByRole('combobox', { name: '上架储位', exact: true }).selectOption(targetId);
    } else {
      await page.getByRole('combobox', { name: '运输分配', exact: true }).selectOption(startInput.allocationId);
      await page.getByRole('combobox', { name: '出库暂存位', exact: true }).selectOption(targetId);
    }
    const started = await write(page.getByRole('region', { name: '软件机器人', exact: true }), '启动单车搬运', 'simulation/start');
    for (const phase of ['APPROACH', 'LOADING', 'TRANSPORT', 'UNLOADING', 'COMPLETED']) {
      const { state, inventory } = await inspect(kind, phase, started.taskId, sourceId, targetId);
      if (phase === 'TRANSPORT') await transitView(kind, started.taskId);
      if (phase === 'COMPLETED') {
        await page.getByTestId('robot-status').filter({ hasText: started.taskId }).filter({ hasText: 'COMPLETED' }).waitFor();
        await page.waitForFunction((id) => {
          const canvas = document.querySelector('canvas');
          return canvas?.dataset.robotTask === id && canvas.dataset.cameraTransition === 'idle';
        }, started.taskId);
        chapter(kind === 'PUTAWAY' ? '上架完成：储位可分配' : '到出库暂存：尚未扣现存', inventory);
        await show(page.getByRole('region', { name: '软件机器人', exact: true }));
        await show(page.locator('canvas'));
        await page.screenshot({ path: `output/playwright/day-21/day-21-${kind.toLowerCase()}-complete.png`, fullPage: true });
        if (state.runtime.carrying) throw new Error('Completed robot still carries cargo');
      }
    }
    return started;
  }
  const putaway = await run('PUTAWAY', {}, receipt.qcLocationId, storage.id);
  await page.goto(`${scene}/outbound`);
  const createOutbound = page.getByRole('form', { name: '创建出库单', exact: true });
  await createOutbound.getByRole('combobox', { name: '商品 SKU', exact: true }).selectOption(receipt.skuId);
  await createOutbound.getByRole('combobox', { name: '批次（FEFO 推荐顺序）', exact: true }).selectOption(receipt.batchId);
  await createOutbound.getByRole('spinbutton', { name: '数量（件）', exact: true }).fill('4');
  await createOutbound.getByRole('textbox', { name: '创建原因', exact: true }).fill('出库同一新批次 4 件');
  const order = await write(createOutbound, '创建出库单', 'outbound-orders');
  const outboundArticle = page.getByRole('article', { name: `出库单 ${order.id}`, exact: true });
  await outboundArticle.getByRole('textbox', { name: '预占原因', exact: true }).fill('整单预占，不扣现存');
  const allocated = await write(outboundArticle, '确认全量预占', `outbound-orders/${order.id}/allocate`);
  if (allocated.allocations.length !== 1) throw new Error('Expected one allocation for this newly stored batch');
  chapter('出库预占', (await confirmed()).inventory);
  await show(outboundArticle);
  const stagingId = (await read('simulation')).staging[0].id;
  const transport = await run('OUTBOUND', { allocationId: allocated.allocations[0].id }, storage.id, stagingId);
  await page.goto(`${scene}/outbound`);
  const dispatch = page.getByRole('form', { name: `发运 ${order.id}`, exact: true });
  await dispatch.getByRole('textbox', { name: '发运原因', exact: true }).fill('暂存区整单到齐，操作员确认发运 4 件');
  await write(dispatch, '确认发运（扣减现存）', `outbound-orders/${order.id}/dispatch`);
  await outboundArticle.getByRole('heading', { name: `${batchCode} · 已发运`, exact: true }).waitFor();
  const shipped = (await confirmed()).inventory;
  if (shipped.summary.onHand !== 62 || shipped.summary.reserved !== 0) throw new Error('Shipment did not deduct exactly four pieces');
  chapter('操作员发运，现存才减少', shipped);
  await show(outboundArticle);
  await page.goto(`${scene}/wms`);
  await page.getByRole('combobox', { name: '批次', exact: true }).selectOption(receipt.batchId);
  await show(page.getByRole('table', { name: '库存流水', exact: true }), 1300);
  await page.getByRole('button', { name: '运行只读对账', exact: true }).click();
  await show(page.getByRole('status').filter({ hasText: '对账通过 · 现存 0 · 预占与运输 0' }), 1500);
  await page.screenshot({ path: 'output/playwright/day-21/day-21-reconciled.png', fullPage: true });
  const reconciliation = await read('wms/reconcile'), ledger = await read(`wms?batchId=${receipt.batchId}`);
  if (!reconciliation.consistent || ledger.movements.length !== 7
    || ledger.movements.filter((m) => m.kind === 'DISPATCH').length !== 1
    || ledger.movements.some((m) => m.quantity !== 4)) throw new Error('Final ledger/reconciliation mismatch');
  const finalState = await read('simulation'), events = [];
  let after = 0;
  while (after < finalState.watermark) {
    const page = await read(`simulation/events?after=${after}`);
    if (!page.events.length) throw new Error('Event stream unexpectedly empty');
    events.push(...page.events); after = page.events.at(-1).seq;
  }
  if (events.some((e, i) => e.seq !== i + 1) || events.length !== finalState.watermark
    || checkpoints.some((c) => !events.some((e) => e.seq === c.watermark && e.payload.taskId === c.taskId && e.payload.tick === c.tick))) throw new Error('Saved cargo snapshots lack matching committed tick events');
  await page.reload();
  await page.getByRole('heading', { name: '库存预警', exact: true }).waitFor();
  const reloaded = (await confirmed()).inventory;
  if (reloaded.summary.onHand !== 62 || reloaded.watermark !== finalState.watermark) throw new Error('Reload changed committed state');
  return { passed: true, capturedAt: new Date().toISOString(), batchCode, receiptId: receipt.id, orderId: order.id,
    putawayTaskId: putaway.taskId, transportTaskId: transport.taskId, checkpoints, chapters,
    events: events.length, watermark: finalState.watermark, movements: ledger.movements.length,
    final: shipped.summary, reconciled: reconciliation.consistent, reloaded: true,
    productPauseApi: false, directDatabaseWrites: false };
}
