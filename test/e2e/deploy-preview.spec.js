const { test, expect, openPanel } = require('./fixtures.cjs');
test('deployment preview sends current draft without saving and displays differences as text', async ({ page, mock }) => {
    await openPanel(page);
    const requests = [];
    await page.route('**/api/deploy/preview?*', route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { accounts: 1, workers: 1, source: { repository: 'official/repo', path: 'worker.js', ref: 'main', previousSha: null, note: '源码尚未逐目标核对' }, targets: [{ alias: '<unsafe>', workerName: 'one', status: 'read', clearedOverrides: ['UUID'], bindings: [{ name: 'SECRET', action: 'write-secret', beforeType: 'secret_text', afterType: 'secret_text' }] }], note: '只读即时快照，不是部署锁' } });
    });
    await page.evaluate(() => { void previewDeploy('cmliu'); });
    await expect(page.locator('#workbench_log')).toContainText('写入 Secret（原值不可比较）');
    await expect(page.locator('#workbench_log')).toContainText('将清除账号覆盖：UUID');
    await expect(page.locator('#workbench_log')).toContainText('<unsafe>');
    await expect(page.locator('#workbench_log unsafe')).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(Array.isArray(requests[0].variables)).toBe(true);
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('history preview uses the selected immutable reference without deploying and supports keyboard', async ({ page, mock }) => {
    await openPanel(page);
    const requests = [];
    await page.route('**/api/deploy/preview?*', route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { accounts: 0, workers: 0, targets: [], note: '只读历史预览' } });
    });
    await page.evaluate(() => {
        document.getElementById('history_list').replaceChildren();
        renderHistoryItem('cmliu', { sha: 'abcdef0123456789', message: 'old version' }, document.getElementById('history_list'), false, false);
        openModal('history_modal');
    });
    const preview = page.getByRole('button', { name: '预览历史版本 abcdef0 的部署差异' });
    await preview.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#workbench_log')).toContainText('只读历史预览');
    expect(requests).toHaveLength(1);
    expect(requests[0].targetSha).toBe('abcdef0123456789');
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
