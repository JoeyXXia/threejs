async (page) => {
  const checked = [];
  const controls = () => page.getByRole('combobox', { name: '区域筛选', exact: true });
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await controls().selectOption('QC');
  const table = page.getByRole('table', { name: '2D库存列表' });
  if (await table.getByRole('row').count() !== 2) throw new Error('QC filter must show one location plus table header');
  await page.getByRole('button', { name: '选择 QC-01', exact: true }).click();
  await controls().selectOption('STORAGE');
  if (!(await page.getByRole('region', { name: '货位详情' }).innerText()).includes('点击场景')) throw new Error('Filtered selection was not cleared');
  if (await table.getByRole('row').count() !== 13) throw new Error('Storage filter should show twelve locations');
  checked.push('zone filter and selection reset');

  await page.getByRole('combobox', { name: '相机视角', exact: true }).selectOption('perspective');
  for (const code of ['R01-1-L1', 'R02-2-L2', 'CH-01']) {
    await page.getByRole('textbox', { name: '货位搜索', exact: true }).fill(code);
    await page.getByRole('button', { name: '搜索并定位', exact: true }).click();
  }
  if (await controls().inputValue() !== 'ALL') throw new Error('Search should reveal its target');
  await page.getByRole('region', { name: '货位详情' }).getByRole('heading', { name: 'CH-01', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle', undefined, { timeout: 5000 });
  const target = await page.locator('canvas').getAttribute('data-camera-target');
  if (!target || JSON.stringify(JSON.parse(target)) !== JSON.stringify([1.5, .5, 16.5])) throw new Error('Camera did not finish at CH-01');
  checked.push('rapid requests finish with one idle transition at the final target');

  await page.setViewportSize({ width: 800, height: 900 });
  await page.getByRole('combobox', { name: '相机视角', exact: true }).selectOption('top');
  await page.waitForTimeout(1100);
  const bounds = await page.locator('canvas').boundingBox();
  if (!bounds || bounds.width > 800 || bounds.height <= 0) throw new Error('Canvas resize failed');
  checked.push('orthographic resize');

  const lost = await page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2'); const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (!ext) return false; ext.loseContext(); return true;
  });
  if (!lost) throw new Error('Driver did not expose context-loss testing');
  await page.getByRole('alert').filter({ hasText: 'WebGL 上下文已丢失' }).waitFor();
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await page.getByRole('table', { name: '2D库存列表' }).waitFor();
  if (await page.locator('canvas').count() !== 0) throw new Error('List view must not depend on WebGL');
  await page.getByRole('button', { name: '选择 QC-01', exact: true }).click();
  checked.push('2D inventory remains usable after real WebGL context loss');

  await page.getByRole('link', { name: '演示仓库 B VIEWER', exact: true }).click();
  await page.getByRole('heading', { name: '演示仓库 B', exact: true }).waitFor();
  await page.getByRole('combobox', { name: '参照货位', exact: true }).waitFor();
  if (await page.getByRole('combobox', { name: '参照货位', exact: true }).inputValue() !== '') throw new Error('Old warehouse selection leaked');
  checked.push('warehouse switch clears UI selection');

  await page.getByRole('link', { name: 'QA 空库存仓库 VIEWER', exact: true }).click();
  await page.getByRole('heading', { name: 'QA 空库存仓库', exact: true }).waitFor();
  await page.getByLabel('库存汇总', { exact: true }).waitFor();
  const numbers = await page.getByLabel('库存汇总', { exact: true }).locator('strong').allTextContents();
  if (numbers.length !== 4 || numbers.some((text) => text.trim() !== '0 件')) throw new Error('Empty warehouse reused old stock');
  checked.push('real empty warehouse shows zero, not cached quantities');

  await page.getByRole('link', { name: '演示仓库 A ADMIN', exact: true }).click();
  await page.getByRole('heading', { name: '演示仓库 A', exact: true }).waitFor();
  await page.getByLabel('库存汇总', { exact: true }).waitFor();
  const pattern = '**/api/spaces/**/inventory';
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '仓库数据不可用' }).waitFor();
  if (await page.getByLabel('库存汇总', { exact: true }).count() || await page.locator('canvas').count()) throw new Error('API error left stale scene/totals visible');
  await page.unroute(pattern);
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByLabel('库存汇总', { exact: true }).waitFor();
  checked.push('HTTP 503 hides cached scene/totals; retry recovers');
  return { passed: true, checked, resize: { width: 800, height: 900 } };
}
