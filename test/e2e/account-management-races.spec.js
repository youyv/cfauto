const { test, expect, openPanel } = require('./fixtures.cjs');
async function setup(page) {
    await openPanel(page);
    await page.evaluate(() => { state.accounts = [
        { accountId: 'account-a', alias: 'Account A', apiToken: 'credential' },
        { accountId: 'account-b', alias: 'Account B', apiToken: 'credential' }
    ]; });
}
test('late account responses cannot overwrite the newer management target', async ({ page, mock }) => {
    await setup(page);
    const held = [];
    await page.route('**/api/all_workers', route => {
        if (route.request().postDataJSON().accountId === 'account-a') { held.push(route); return; }
        return route.fulfill({ json: { success: true, workers: [{ id: 'worker-b' }] } });
    });
    await page.route('**/api/get_subdomain', route => {
        if (route.request().postDataJSON().accountId === 'account-a') { held.push(route); return; }
        return route.fulfill({ json: { success: true, subdomain: 'sub-b' } });
    });
    await page.evaluate(() => { void openAccountManage(0); });
    await expect.poll(() => held.length).toBe(2);
    await page.evaluate(() => { void openAccountManage(1); });
    await expect(page.locator('#manage_list_body')).toContainText('worker-b');
    for (const route of held) await route.fulfill({ json: route.request().url().includes('all_workers') ? { success: true, workers: [{ id: 'worker-a' }] } : { success: true, subdomain: 'sub-a' } });
    await expect(page.locator('#manage_subdomain_display')).toHaveText('sub-b');
    await expect(page.locator('#manage_list_body')).not.toContainText('worker-a');
    await expect(page.locator('#manage_table')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#manage_loading')).toHaveAttribute('role', 'status');
});
test('reordered accounts do not redirect Worker deletion or subdomain editing', async ({ page, mock }) => {
    await setup(page);
    await page.route('**/api/all_workers', route => route.fulfill({ json: { success: true, workers: [{ id: 'worker-a' }] } }));
    await page.route('**/api/get_subdomain', route => route.fulfill({ json: { success: true, subdomain: 'sub-a' } }));
    await page.evaluate(() => { void openAccountManage(0); });
    await expect(page.locator('#manage_list_body')).toContainText('worker-a');
    await page.evaluate(() => { state.accounts.reverse(); });
    await page.locator('#manage_list_body button').click();
    await expect(page.locator('.swal2-html-container')).toContainText('account-a');
    await expect(page.locator('.swal2-html-container')).not.toContainText('account-b');
    await page.locator('.swal2-cancel').click();
    await page.evaluate(() => { void promptChangeSubdomain(); });
    await expect(page.locator('.swal2-html-container')).toContainText('account-a');
    await page.locator('.swal2-cancel').click();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
