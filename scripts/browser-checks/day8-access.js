async (page) => {
  await page.getByRole('link', { name: '演示仓库 B 入库与质检', exact: true }).click();
  await page.getByRole('heading', { name: '演示仓库 B · 入库与质检', exact: true }).waitFor();
  const form = page.getByRole('form', { name: '创建入库单', exact: true });
  await form.waitFor();
  if (!await form.getByRole('button', { name: '创建入库单', exact: true }).isDisabled()
    || !await form.getByRole('textbox', { name: '批次编号', exact: true }).isDisabled()) throw new Error('Viewer can edit creation form');
  if (!await page.getByText('当前为只读账户，可查看入库与质检记录。', { exact: true }).isVisible()) throw new Error('Viewer role not visible');
  if (await page.getByRole('article').count() !== 0) throw new Error('A warehouse orders leaked into B');
  await page.getByRole('link', { name: '演示仓库 A 入库与质检', exact: true }).click();
  await page.getByRole('article').first().waitFor();
  if (await page.getByRole('form', { name: '创建入库单', exact: true }).getByRole('button', { name: '创建入库单', exact: true }).isDisabled()) throw new Error('Admin was incorrectly read-only');
  return { passed: true, viewerReadOnly: true, crossWarehouseListIsolated: true, adminFormRestored: true };
}
