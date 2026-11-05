const { test, expect, openPanel } = require('./fixtures.cjs');
test('deletion displays acknowledged and unknown cleanup outcomes as safe text', async ({ page, mock }) => {
    await openPanel(page);
    await page.route('**/api/delete_worker', route => route.fulfill({ json: { success: true, partial: true, kvWarnings: 'Worker 已删除，后续清理未知；不要盲目重试', results: [{ resource: '<worker>', status: 'deleted' }, { resource: 'KV', status: 'retained' }, { resource: '配置', status: 'unknown' }] } }));
    await page.evaluate(() => { state.accounts = [{ accountId: 'test-account', alias: 'test' }]; void confirmDeleteWorker('one', 0); });
    await page.getByLabel('输入 Worker 名称确认删除').fill('one');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-html-container')).toContainText('<worker>：已删除');
    await expect(page.locator('.swal2-html-container')).toContainText('KV：已保留');
    await expect(page.locator('.swal2-html-container')).toContainText('配置：结果未知');
    await expect(page.locator('.swal2-html-container worker')).toHaveCount(0);
});
