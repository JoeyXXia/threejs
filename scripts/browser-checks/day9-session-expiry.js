async (page) => {
  // Run after `expire` in the QA terminal, with the outbound page open.
  await page.getByRole('button', { name: '刷新出库与推荐', exact: true }).click();
  await page.getByRole('textbox', { name: '密码', exact: true }).waitFor();
  if (await page.getByRole('article').count() || await page.getByRole('form', { name: '创建出库单', exact: true }).count()) throw new Error('Outbound data survived expiry');
  return { passed: true, returnedToLogin: true, outboundRecordsCleared: true };
}
