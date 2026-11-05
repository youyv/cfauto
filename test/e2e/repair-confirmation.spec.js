const { test, expect, openPanel } = require('./fixtures.cjs');
test('repair shows frozen targets, requires project name and rejects duplicate entry', async ({ page, mock }) => {
    await openPanel(page);
    const writes = [];
    await page.route('**/api/deploy/preview?*', route => route.fulfill({ json: { targets: [{ accountId: 'account-one', alias: '<target>', workerName: 'worker-one' }] } }));
    await page.route('**/api/fix_1101', route => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: [] }); });
    await page.evaluate(() => { void fix1101('cmliu'); void fix1101('cmliu'); });
    await expect(page.locator('.swal2-html-container')).toContainText('account-one');
    await expect(page.locator('.swal2-html-container')).toContainText('worker-one');
    await expect(page.locator('.swal2-html-container target')).toHaveCount(0);
    await page.locator('.swal2-input').fill('wrong');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toBeVisible();
    expect(writes).toEqual([]);
    await page.locator('.swal2-input').fill('cmliu');
    await page.locator('.swal2-confirm').click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ type: 'cmliu', expectedTargets: [{ accountId: 'account-one', workerName: 'worker-one' }] });
});
