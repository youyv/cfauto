const { test, expect, openPanel } = require('./fixtures.cjs');
async function start(page) {
    await openPanel(page);
    await page.evaluate(() => {
        state.accounts = [{ accountId: 'original-account', alias: '<target>' }];
        currentManageAccountId = 'original-account';
        $('manage_subdomain_display').innerText = 'old-name';
        void promptChangeSubdomain();
    });
    await expect(page.locator('.swal2-html-container')).toContainText('original-account');
    await page.getByLabel('新子域名前缀', { exact: true }).fill('new-name');
    await page.locator('.swal2-confirm').click();
    await expect(page.getByLabel('精确输入新子域名前缀确认')).toBeVisible();
}
test('subdomain rejects wrong confirmation and cancellation without mutation', async ({ page, mock }) => {
    const writes = [];
    await page.route('**/api/change_subdomain', route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true } }); });
    await start(page);
    await page.getByLabel('精确输入新子域名前缀确认').fill('wrong');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toBeVisible();
    await page.locator('.swal2-cancel').click();
    expect(writes).toEqual([]);
});
test('subdomain freezes account, retains failed input and does not overwrite another account display', async ({ page, mock }) => {
    const writes = [];
    await page.route('**/api/change_subdomain', route => {
        writes.push(route.request().postDataJSON());
        return route.fulfill({ json: writes.length === 1 ? { success: false, msg: '<failure>' } : { success: true, subdomain: 'new-name' } });
    });
    await start(page);
    await page.evaluate(() => { state.accounts[0].accountId = 'another-account'; $('manage_subdomain_display').innerText = 'another-name'; });
    await page.getByLabel('精确输入新子域名前缀确认').fill('new-name');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toContainText('<failure>');
    await expect(page.getByLabel('精确输入新子域名前缀确认')).toHaveValue('new-name');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-title')).toHaveText('修改成功');
    expect(writes).toEqual([{ accountId: 'original-account', newSubdomain: 'new-name' }, { accountId: 'original-account', newSubdomain: 'new-name' }]);
    expect(await page.locator('#manage_subdomain_display').textContent()).toBe('another-name');
});
