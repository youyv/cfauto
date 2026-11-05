const { test, expect, openPanel } = require('./fixtures.cjs');

async function deletionDialog(page) {
    await page.evaluate(() => {
        state.accounts = [{ accountId: 'mock-account', alias: '<unsafe> account', apiToken: 'mock-credential' }];
        void confirmDeleteWorker('mock-worker', 0);
    });
}
test('worker deletion shows its target and rejects blank or incorrect resource names without requests', async ({ page, mock }) => {
    await openPanel(page);
    await deletionDialog(page);
    await expect(page.locator('.swal2-html-container')).toContainText('<unsafe> account');
    await expect(page.locator('.swal2-html-container')).toContainText('mock-account');
    await expect(page.locator('.swal2-html-container unsafe')).toHaveCount(0);
    const name = page.getByLabel('输入 Worker 名称确认删除', { exact: true });
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toContainText('名称必须完全一致');
    await name.fill('mock-worker-incorrect');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toContainText('名称必须完全一致');
    await page.locator('.swal2-cancel').click();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

for (const deleteKv of [false, true]) test('exact worker confirmation sends only the displayed target; deleteKv=' + deleteKv, async ({ page, mock }) => {
    const requests = [];
    await page.route('**/api/delete_worker', route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { success: false, msg: 'mock denied' } });
    });
    await openPanel(page);
    await deletionDialog(page);
    await page.getByLabel('输入 Worker 名称确认删除', { exact: true }).fill('mock-worker');
    await page.locator('#del_kv_chk').setChecked(deleteKv);
    // A later refresh/edit must not silently change the confirmed account target.
    await page.evaluate(() => { state.accounts[0].accountId = 'different-account'; });
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toContainText('mock denied');
    expect(requests).toEqual([{ accountId: 'mock-account', workerName: 'mock-worker', deleteKv }]);
    await expect(page.getByLabel('输入 Worker 名称确认删除', { exact: true })).toHaveValue('mock-worker');
    await page.locator('.swal2-cancel').click();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
