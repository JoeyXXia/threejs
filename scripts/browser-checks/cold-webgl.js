async (page) => {
  await page.getByRole('textbox', { name: '邮箱', exact: true }).fill('admin@demo.local');
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('browser-fixture-only-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('库存汇总', { exact: true }).waitFor();
  await page.getByRole('alert').waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '2D 库存列表', exact: true }).click();
  const table = page.getByRole('table', { name: '2D库存列表' });
  await table.waitFor();
  const rows = await table.getByRole('row').count();
  if (rows !== 18 || await page.locator('canvas').count() !== 0) throw new Error('Cold no-WebGL list failed');
  const webgl = await page.evaluate(() => document.createElement('canvas').getContext('webgl2') !== null);
  if (webgl) throw new Error('Browser launch did not actually disable WebGL');
  await page.getByRole('button', { name: '选择 QC-01', exact: true }).click();
  if (!(await page.getByRole('region', { name: '货位详情' }).innerText()).includes('待检 HOLD')) throw new Error('No-WebGL details failed');
  return { passed: true, webglAvailable: false, displayedLocations: rows - 1, holdDetail: true };
}
