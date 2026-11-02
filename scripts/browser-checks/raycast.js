async (page) => {
  await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  await page.getByRole('combobox', { name: '相机视角', exact: true }).selectOption('perspective');
  const checked = [];
  for (const code of ['R01-1-L1', 'R02-3-L2']) {
    await page.getByRole('textbox', { name: '货位搜索', exact: true }).fill(code);
    await page.getByRole('button', { name: '搜索并定位', exact: true }).click();
    await page.getByRole('region', { name: '货位详情' }).getByRole('heading', { name: code, exact: true }).waitFor();
    await page.waitForTimeout(1100); // bounded by the documented .65s camera transition
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    const bounds = await page.locator('canvas').boundingBox();
    await page.locator('canvas').scrollIntoViewIfNeeded();
    const box = await page.locator('canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByRole('region', { name: '货位详情' }).getByRole('heading', { name: code, exact: true }).waitFor({ timeout: 3000 });
    checked.push({ code, raycastSelected: true, canvasWidth: bounds.width });
  }
  await page.getByRole('combobox', { name: '相机视角', exact: true }).selectOption('top');
  await page.getByRole('button', { name: '重置相机', exact: true }).click();
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const layout = await (await page.request.get(`http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}/layout`)).json();
  const grid = layout.layoutVersion;
  await page.locator('canvas').scrollIntoViewIfNeeded();
  const box = await page.locator('canvas').boundingBox();
  const halfHeight = Math.max(grid.depth * grid.cellSize / 2, grid.width * grid.cellSize / (2 * (box.width / box.height))) * 1.15;
  const centerX = grid.origin.x + grid.width * grid.cellSize / 2;
  const centerZ = grid.origin.z + grid.depth * grid.cellSize / 2;
  const clickCell = async (location) => {
    const x = grid.origin.x + (location.grid.x + .5) * grid.cellSize;
    const z = grid.origin.z + (location.grid.z + .5) * grid.cellSize;
    await page.mouse.click(box.x + box.width * (.5 + (x - centerX) / (2 * halfHeight * box.width / box.height)),
      box.y + box.height * (.5 + (z - centerZ) / (2 * halfHeight)));
  };
  await clickCell(layout.locations.find((row) => row.code === 'R01-1-L1'));
  if (!(await page.getByRole('region', { name: '货位详情' }).innerText()).includes('点击场景')) throw new Error('Rack roof selected a hidden location behind it');
  await clickCell(layout.locations.find((row) => row.code === 'CH-01'));
  await page.getByRole('region', { name: '货位详情' }).getByRole('heading', { name: 'CH-01', exact: true }).waitFor({ timeout: 3000 });
  return { passed: true, checked, rackOcclusionStopsPick: true, topViewEmptyRaycast: true };
}
