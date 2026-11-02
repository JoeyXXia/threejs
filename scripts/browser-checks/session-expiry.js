async (page) => {
  // Run after the QA terminal's `expire` command, while a warehouse is open.
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByRole('textbox', { name: '密码', exact: true }).waitFor();
  if (await page.locator('canvas').count()) throw new Error('Scene retained after expiry');
  if (await page.locator('[aria-label="库存汇总"]').count()) throw new Error('Summary retained after expiry');
  return { passed: true, expiredSession: true, sceneCleared: true, summaryCleared: true };
}
