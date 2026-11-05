async (page) => {
  // Run only after `expire` in the disposable QA terminal, while on the inbound page.
  await page.getByRole('button', { name: '刷新入库单', exact: true }).click();
  await page.getByRole('textbox', { name: '密码', exact: true }).waitFor();
  if (await page.getByRole('form', { name: '创建入库单', exact: true }).count() || await page.getByRole('article').count()) throw new Error('Order forms or records survived session expiry');
  return { passed: true, returnedToLogin: true, inboundRecordsCleared: true };
}
