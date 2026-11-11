async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const url = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}/layout`;
  const response = await page.request.get(url);
  if (!response.ok()) throw new Error('Layout unavailable');
  const layout = await response.json();
  const debug = page.getByRole('region', { name: '导航调试网格', exact: true });
  const image = debug.getByRole('img', { name: '导航单元格分布图', exact: true });
  const toggle = page.getByRole('button', { name: '导航调试', exact: true });
  await toggle.click();
  await debug.getByText('布局 v1 · 30 × 20 · 可走 594 格 · 连通分区 1 · 合法服务货位 17/17', { exact: true }).waitFor();

  const cells = await image.evaluate((canvas) => {
    const { width, height } = canvas;
    return Array.from(canvas.getContext('2d').getImageData(0, 0, width, height).data);
  });
  const rgb = ({ x, z }) => cells.slice(4 * (z * 30 + x), 4 * (z * 30 + x) + 3).join(',');
  for (const blocked of layout.blockedCells) {
    if (rgb(blocked) !== '62,77,96') throw new Error('Rack footprint is not rendered as blocked');
  }
  const serviceCells = new Set();
  for (const { serviceCell, kind } of layout.locations) {
    if (rgb(serviceCell) !== (kind === 'STORAGE' ? '13,116,107' : '199,119,40')) throw new Error('Service point color mismatch');
    serviceCells.add(`${serviceCell.x},${serviceCell.z}`);
  }
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await page.getByRole('combobox', { name: '区域筛选', exact: true }).selectOption('QC');
  const filtered = await image.evaluate((canvas) => Array.from(canvas.getContext('2d').getImageData(0, 0, 30, 20).data));
  if (JSON.stringify(cells) !== JSON.stringify(filtered)) throw new Error('Inventory filters changed navigation cells');
  await debug.screenshot({ path: 'output/playwright/day-15/day-15-navigation.png' });

  const barrier = Array.from({ length: layout.layoutVersion.width }, (_, x) => ({ x, z: 10 }));
  await page.route('**/api/spaces/**/layout', (route) => route.fulfill({ json: { ...layout, blockedCells: [...layout.blockedCells, ...barrier] } }));
  try {
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await debug.getByRole('status').filter({ hasText: '地图不连通' }).waitFor();
    await debug.getByText('布局 v1 · 30 × 20 · 可走 564 格 · 连通分区 2 · 合法服务货位 17/17', { exact: true }).waitFor();
  } finally {
    await page.unroute('**/api/spaces/**/layout');
  }
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await debug.getByText('布局 v1 · 30 × 20 · 可走 594 格 · 连通分区 1 · 合法服务货位 17/17', { exact: true }).waitFor();
  await toggle.click();
  await debug.waitFor({ state: 'hidden' });
  return { passed: true, walkable: 594, rackCells: layout.blockedCells.length, locations: layout.locations.length,
    uniqueServiceCells: serviceCells.size, components: [1, 2, 1], unchangedByFilters: true };
}
