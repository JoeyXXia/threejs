async (page) => {
  const [, , spaceId, warehouseId] = new URL(page.url()).pathname.split('/');
  const base = `http://127.0.0.1:15174/api/spaces/${spaceId}/warehouses/${warehouseId}`;
  const backend = await (await page.request.get(`${base}/layout`)).json();
  if (backend.layoutVersion.version !== 2 || backend.racks.find((rack) => rack.code === 'R01').gridX !== 8) throw new Error('QA layout v2 was not published');
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByText('布局 v2 · 17 个货位', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.cameraTransition === 'idle');
  return { passed: true, backendVersion: 2, displayedVersion: 2, movedRack: { code: 'R01', gridX: 8 }, canvasCount: await page.locator('canvas').count() };
}
