async (page) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="库存汇总"] strong')].some((el) => el.textContent.trim() === '2 件'));
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  await page.getByRole('button', { name: '选择 R02-2-L2', exact: true }).click();
  const details = await page.getByRole('region', { name: '货位详情' }).innerText();
  if (!details.includes('10 / 2 / 8 件') || !details.includes('预占')) throw new Error('Reserved fixture detail mismatch');
  await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  await page.getByRole('combobox', { name: '相机视角', exact: true }).selectOption('perspective');
  await page.getByRole('button', { name: '重置相机', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '../../../reports/day-06-preview.png', fullPage: true });
  const renderer = await page.locator('canvas').evaluate((canvas) => {
    const gl = canvas.getContext('webgl2'), extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });
  return { passed: true, reservedFixture: { onHand: 10, reserved: 2, available: 8 }, renderer, screenshot: 'reports/day-06-preview.png' };
}
