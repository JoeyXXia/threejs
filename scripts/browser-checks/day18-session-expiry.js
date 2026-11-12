async (page) => {
  await page.getByRole('textbox', { name: '密码', exact: true }).waitFor();
  if (await page.getByRole('region', { name: '软件机器人', exact: true }).count()) throw new Error('Expired session retained robot controls');
  if (await page.locator('canvas').count()) throw new Error('Expired session retained old robot scene');
  return { passed: true, expiredSessionRemovedRobotAndScene: true };
}
