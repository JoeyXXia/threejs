async (page) => {
  // Run in the dedicated QA environment after login. No fixture mutation commands.
  await page.setViewportSize({ width: 1440, height: 1100 });
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const read = async (resource) => {
    const response = await page.request.get(`${base}/${resource}`);
    if (!response.ok()) throw new Error(`${resource}: HTTP ${response.status()}`);
    return response.json();
  };
  const [layout, before] = await Promise.all([read('layout'), read('inventory')]);
  if (layout.layoutVersion.id !== before.layoutId || layout.layoutVersion.version !== before.layoutVersion) throw new Error('Unpaired layout/inventory');
  const canonical = (inventory) => JSON.stringify(Object.fromEntries(Object.entries(inventory).filter(([key]) => key !== 'asOf')));
  const assertDetails = async (location) => {
    const details = page.getByRole('region', { name: '货位详情' });
    await details.getByRole('heading', { name: location.code, exact: true }).waitFor();
    const text = await details.innerText(), total = before.locationTotals.find((row) => row.locationId === location.id);
    if (!text.includes(location.id) || !text.includes(`现存 ${total.onHand} / 容量 ${total.capacity} 件 · 预占 ${total.reserved} · 可用 ${total.available}`)) throw new Error(`Detail identity/total mismatch: ${location.code}`);
    for (const balance of before.balances.filter((row) => row.locationId === location.id)) {
      for (const value of [balance.sku.code, balance.batch.code, balance.quality, `${balance.onHand} / ${balance.reserved} / ${balance.available} 件`]) {
        if (!text.includes(value)) throw new Error(`Missing batch detail ${location.code}: ${value}`);
      }
    }
    return text;
  };
  const assertList = async () => {
    await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
    const table = page.getByRole('table', { name: '2D库存列表' });
    await table.waitFor();
    if (await table.getByRole('row').count() !== layout.locations.length + 1) throw new Error('List location count mismatch');
    for (const location of layout.locations) {
      const row = table.getByRole('row').filter({ has: page.getByRole('button', { name: `选择 ${location.code}`, exact: true }) });
      const cells = await row.getByRole('cell').allTextContents();
      const total = before.locationTotals.find((entry) => entry.locationId === location.id);
      if (JSON.stringify(cells.slice(1, 4)) !== JSON.stringify([total.onHand, total.reserved, total.available].map(String))) throw new Error(`List quantities mismatch: ${location.code}`);
    }
  };
  const picked = [];
  await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  await page.getByRole('combobox', { name: '相机视角', exact: true }).selectOption('perspective');
  for (const code of ['R01-1-L1', 'R02-3-L2']) {
    const location = layout.locations.find((entry) => entry.code === code);
    await page.getByRole('textbox', { name: '货位搜索', exact: true }).fill(code);
    await page.getByRole('button', { name: '搜索并定位', exact: true }).click();
    await assertDetails(location);
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle');
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.locator('canvas').scrollIntoViewIfNeeded();
    const box = await page.locator('canvas').boundingBox();
    if (!box) throw new Error('No drawable canvas');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const sceneDetail = await assertDetails(location);
    await page.getByRole('region', { name: '货位详情' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000); // Recording pace only; assertions above establish readiness.
    await assertList();
    await page.getByRole('button', { name: `选择 ${code}`, exact: true }).click();
    if (await assertDetails(location) !== sceneDetail) throw new Error(`3D/2D detail mismatch: ${code}`);
    await page.getByRole('table', { name: '2D库存列表' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000); // Allow a viewer to inspect the list.
    picked.push({ code, locationId: location.id, raycast: true, detailMatches2D: true });
    await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  }
  await page.reload(); // A full document reload, not merely Query.refetch().
  await page.getByLabel('库存汇总', { exact: true }).waitFor();
  const after = await read('inventory'), layoutAfter = await read('layout');
  if (canonical(before) !== canonical(after) || JSON.stringify(layout) !== JSON.stringify(layoutAfter)) throw new Error('Persisted data changed after full reload');
  const numbers = await page.getByLabel('库存汇总', { exact: true }).locator('strong').allTextContents();
  if (JSON.stringify(numbers.map((text) => text.trim())) !== JSON.stringify([before.summary.onHand, before.summary.available, before.summary.reserved, before.summary.hold].map((value) => `${value} 件`))) throw new Error('Reloaded UI summary mismatch');
  await assertList();
  const qc = layout.locations.find((entry) => entry.code === 'QC-01');
  await page.getByRole('button', { name: '选择 QC-01', exact: true }).click();
  await assertDetails(qc);
  await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  await page.getByRole('button', { name: '重置相机', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'day-07-preview.png', fullPage: true });
  await page.waitForTimeout(1000); // End the recording on the restored scene.
  return { passed: true, picked, checkedListLocations: layout.locations.length, fullDocumentReload: true,
    inventoryUnchangedExceptAsOf: true, layoutUnchanged: true, summary: before.summary,
    screenshot: 'output/playwright/day-07/day-07-preview.png' };
}
