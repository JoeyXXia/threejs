async (page) => {
  await page.getByRole('link', { name: '演示仓库 B 出库与预占', exact: true }).click();
  await page.getByRole('heading', { name: '演示仓库 B · 出库与预占', exact: true }).waitFor();
  const form = page.getByRole('form', { name: '创建出库单', exact: true }); await form.waitFor();
  if (!await form.getByRole('button', { name: '创建出库单', exact: true }).isDisabled() || !await form.getByRole('textbox', { name: '创建原因', exact: true }).isDisabled()) throw new Error('Viewer form is writable');
  if (await page.getByRole('article').count()) throw new Error('Orders leaked between warehouses');
  await page.getByRole('link', { name: '演示仓库 A 出库与预占', exact: true }).click();
  await page.getByRole('article').first().waitFor();
  return { passed: true, viewerReadOnly: true, crossWarehouseListIsolated: true };
}
