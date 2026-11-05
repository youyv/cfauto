const { test, expect, openPanel } = require('./fixtures.cjs');
async function start(page, batch = true) {
    await openPanel(page);
    await page.evaluate(batch => {
        state.accounts = ['a', 'b', 'c'].map(accountId => ({ accountId, alias: '<unsafe> ' + accountId, apiToken: 'private-credential' }));
        renderTable();
        if (batch) {
            document.querySelectorAll('.acct-chk').forEach(c => { c.checked = c.value !== '1'; });
            void batchDeleteAccounts();
        } else void delAccount(0);
    }, batch);
}
for (const batch of [false, true]) test('account removal target and exact confirmation; batch=' + batch, async ({ page, mock }) => {
    await start(page, batch);
    await expect(page.locator('.swal2-html-container')).toContainText('<unsafe> a');
    await expect(page.locator('.swal2-html-container')).toContainText('账号级变量覆盖');
    await expect(page.locator('.swal2-html-container unsafe')).toHaveCount(0);
    await expect(page.locator('.swal2-html-container')).not.toContainText('private-credential');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toContainText('请精确输入');
    await page.getByLabel('输入“移除”确认账号配置移除', { exact: true }).fill('移除');
    await page.evaluate(() => { state.accounts[0].stats = { requests: 10 }; });
    await page.locator('.swal2-confirm').click();
    await expect.poll(() => mock.requests.filter(r => r.method === 'POST').length).toBe(1);
    expect(mock.requests.find(r => r.method === 'POST').body.map(a => a.accountId)).toEqual(batch ? ['b'] : ['b', 'c']);
    await expect.poll(() => page.evaluate(() => state.accounts.map(a => a.accountId))).toEqual(batch ? ['b'] : ['b', 'c']);
});
for (const change of ['reorder', 'edit', 'remove']) test('changed account list aborts removal: ' + change, async ({ page, mock }) => {
    await start(page);
    await page.evaluate(change => {
        if (change === 'reorder') state.accounts.reverse();
        if (change === 'edit') state.accounts[1].alias = 'edited';
        if (change === 'remove') state.accounts.pop();
    }, change);
    await page.getByLabel('输入“移除”确认账号配置移除', { exact: true }).fill('移除');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toContainText('账号列表已变化');
    await page.locator('.swal2-cancel').click();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
test('failed account removal preserves list and confirmation input', async ({ page, mock }) => {
    mock.allowedErrors.push(/503/);
    await page.route('**/api/accounts', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { success: false, msg: '<unsafe> denied' } }) : route.fallback());
    await start(page);
    await page.getByLabel('输入“移除”确认账号配置移除', { exact: true }).fill('移除');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toContainText('denied');
    await expect(page.locator('.swal2-validation-message unsafe')).toHaveCount(0);
    expect(await page.evaluate(() => state.accounts.map(a => a.accountId))).toEqual(['a', 'b', 'c']);
    await expect(page.getByLabel('输入“移除”确认账号配置移除', { exact: true })).toHaveValue('移除');
});

test('in-flight removal neither duplicates writes nor overwrites newer local edits', async ({ page, mock }) => {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const requests = [];
    await page.route('**/api/accounts', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        requests.push(route.request().postDataJSON());
        await hold;
        await route.fulfill({ json: { success: true } });
    });
    await start(page);
    await page.getByLabel('输入“移除”确认账号配置移除', { exact: true }).fill('移除');
    await page.locator('.swal2-confirm').click();
    await expect.poll(() => requests.length).toBe(1);
    expect(await page.evaluate(() => state.accounts.length)).toBe(3);
    await page.evaluate(() => { state.accounts[1].alias = 'new local edit'; void delAccount(1); });
    release();
    await expect(page.locator('.swal2-html-container')).toContainText('未覆盖当前列表');
    expect(await page.evaluate(() => state.accounts.map(a => a.alias))).toEqual(['<unsafe> a', 'new local edit', '<unsafe> c']);
    expect(requests).toHaveLength(1);
    expect(requests[0].map(a => a.accountId)).toEqual(['b']);
});
test('cancelled account removal sends no write', async ({ page, mock }) => {
    await start(page);
    await page.locator('.swal2-cancel').click();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
    expect(await page.evaluate(() => state.accounts.length)).toBe(3);
});
