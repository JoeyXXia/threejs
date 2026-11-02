async (page) => {
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const layout = await (await page.request.get(`${base}/layout`)).json();
  const inventory = await (await page.request.get(`${base}/inventory`)).json();
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await page.getByRole('table', { name: '2D库存列表' }).waitFor();
  const locations = [...layout.locations];
  let seed = 20261102;
  for (let i = locations.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [locations[i], locations[j]] = [locations[j], locations[i]];
  }
  const sampled = locations.slice(0, 10), checked = [];
  for (const location of sampled) {
    await page.getByRole('button', { name: `选择 ${location.code}`, exact: true }).click();
    const details = page.getByRole('region', { name: '货位详情' });
    await details.getByRole('heading', { name: location.code, exact: true }).waitFor();
    const text = await details.innerText();
    const totals = inventory.locationTotals.find((row) => row.locationId === location.id);
    if (!text.includes(location.id) || !text.includes(`现存 ${totals.onHand} / 容量 ${totals.capacity}`)) throw new Error(`Wrong total/identity for ${location.code}`);
    for (const balance of inventory.balances.filter((row) => row.locationId === location.id)) {
      if (!text.includes(balance.sku.code) || !text.includes(balance.batch.code) || !text.includes(balance.quality)
        || !text.includes(`${balance.onHand} / ${balance.reserved} / ${balance.available} 件`)) throw new Error(`Wrong batch detail for ${location.code}`);
    }
    checked.push({ code: location.code, onHand: totals.onHand, reserved: totals.reserved, available: totals.available });
  }
  await page.getByRole('button', { name: '选择 CH-01', exact: true }).click();
  if (!(await page.getByRole('region', { name: '货位详情' }).innerText()).includes('空货位')) throw new Error('Empty location not selectable');
  await page.getByRole('button', { name: '选择 QC-01', exact: true }).click();
  if (!(await page.getByRole('region', { name: '货位详情' }).innerText()).includes('待检 HOLD')) throw new Error('HOLD missing');
  return { passed: true, sampleSeed: 20261102, checked, emptySelectable: true, holdDetail: true };
}
