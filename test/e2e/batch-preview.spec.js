const { test, expect, openPanel } = require('./fixtures.cjs');
async function openBatch(page) {
    await openPanel(page);
    await page.evaluate(() => {
        state.accounts = [{ alias: 'target', accountId: 'account-one', apiToken: 'credential' }];
        openBatchDeployModal();
        $('bd_name').value = 'original-worker';
        $('bd_enable_kv').checked = false;
        $('bd_use_saved_vars').checked = false;
        document.querySelector('.bd-acc-chk').checked = true;
    });
}
test('batch preview is keyboard accessible, read-only, safe text and preserves its form', async ({ page, mock }) => {
    await openBatch(page);
    const requests = [];
    await page.route('**/api/deploy/preview?*', route => {
        requests.push(route.request().postDataJSON());
        return route.fulfill({ json: { success: true, accounts: 1, source: { status: 'read' }, targets: [{ alias: '<unsafe>', workerName: 'original-worker', status: 'read', workerAction: 'replace', kvAction: 'reuse', sourceAction: 'changed', bindings: [{ name: 'OLD_SECRET', action: 'removed' }] }], note: '只读，不保证后续部署状态' } });
    });
    await page.locator('#btn_preview_batch').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.swal2-title')).toHaveText('批量部署差异预览');
    await expect(page.locator('.swal2-html-container')).toContainText('覆盖现有 Worker');
    await expect(page.locator('.swal2-html-container')).toContainText('OLD_SECRET：移除');
    await expect(page.locator('.swal2-html-container')).toContainText('<unsafe>');
    await expect(page.locator('.swal2-html-container unsafe')).toHaveCount(0);
    expect(requests[0].batch.workerName).toBe('original-worker');
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('#bd_name')).toHaveValue('original-worker');
    await expect(page.locator('#btn_preview_batch')).toBeEnabled();
});
test('slow saved-variable read uses frozen fields and never replaces edits', async ({ page, mock }) => {
    await openBatch(page);
    let held, sent;
    await page.route('**/api/settings?*', route => { held = route; });
    await page.route('**/api/deploy/preview?*', route => {
        sent = route.request().postDataJSON().batch;
        return route.fulfill({ json: { success: true, accounts: 0, targets: [] } });
    });
    await page.locator('#bd_use_saved_vars').check();
    await page.locator('#btn_preview_batch').click();
    await expect.poll(() => !!held).toBe(true);
    await page.locator('#bd_name').fill('edited-worker');
    await page.locator('#bd_domain_prefix').fill('edited-domain');
    await held.fulfill({ json: [{ key: 'TOKEN', value: 'secret', secret: true }] });
    await expect(page.locator('.swal2-title')).toHaveText('批量部署差异预览');
    expect(sent.workerName).toBe('original-worker');
    expect(sent.customDomainPrefix).not.toBe('edited-domain');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('#bd_name')).toHaveValue('edited-worker');
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
test('failed saved-variable read blocks deployment instead of silently using defaults', async ({ page, mock }) => {
    await openBatch(page);
    mock.allowedErrors.push(/doBatchDeploy/);
    await page.route('**/api/settings?*', route => route.fulfill({ json: { invalid: true } }));
    await page.locator('#bd_use_saved_vars').check();
    await page.locator('#btn_do_batch').click();
    await expect(page.locator('.swal2-html-container')).toContainText('未改用空配置部署');
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
    await expect(page.locator('#bd_name')).toHaveValue('original-worker');
    await expect(page.locator('#btn_do_batch')).toBeEnabled();
});

test('batch fields have accessible names and post-upload warnings are not blanket success', async ({ page, mock }) => {
    await openBatch(page);
    for (const [id, name] of [['bd_name', 'Worker 名称'], ['bd_template', '选择模板'], ['bd_kv_name', 'KV 空间名称'], ['bd_domain_prefix', '自定义域名 (自动绑定)'], ['bd_admin_pass', '设置 ADMIN 密码'], ['bd_uuid', '设置用户 UUID (u)']]) {
        await expect(page.locator('#' + id)).toHaveAccessibleName(name);
    }
    await page.route('**/api/batch_deploy', route => route.fulfill({ json: [{ name: 'target', success: true, msg: '✅ 脚本已上传；⚠️ 默认域名禁用未确认' }] }));
    await page.locator('#btn_do_batch').click();
    await expect(page.locator('.swal2-title')).toHaveText('部署完成（有警告）');
    await expect(page.locator('.swal2-html-container')).toContainText('1 个目标有后续配置警告');
});
