const { test, expect, openPanel, noOverflow } = require('./fixtures.cjs');
const automation = page => page.locator('.automation-drawer > summary');
const upstream = (page, t = 'cmliu') => page.locator('[data-tab-panel="' + t + '"] .upstream-card');
const saveAuto = page => page.locator('[data-act="saveAutoConfig"]');
const confirm = page => page.locator('.swal2-confirm').click();
const cancel = page => page.locator('.swal2-cancel').click();
const closeAlert = page => page.evaluate(() => Swal.close());
const writeCount = (mock, path) => mock.requests.filter(r => r.path === path && r.method === 'POST').length;

test('automation edits remain visible collapsed; restoring all original values clears dirty state', async ({ page, mock }, info) => {
    await openPanel(page);
    await automation(page).click();
    for (const id of ['auto_update_interval', 'fuse_threshold', 'fuse_webhook']) await expect(page.locator('#' + id)).toBeVisible();
    await page.locator('#auto_update_interval').fill('45');
    await automation(page).click();
    await expect(page.locator('#auto_config_status')).toBeVisible();
    await expect(page.locator('#auto_config_status')).toHaveText('未保存');
    expect(mock.auto.interval).toBe(30);
    await page.screenshot({ path: info.outputPath('collapsed-draft.png'), fullPage: true });
    await automation(page).click();
    await page.locator('#auto_update_interval').fill('30');
    await expect(page.locator('#auto_config_status')).toHaveText('已保存');
    // Master switch updates child switches; revert them to the actual original selection.
    await page.locator('label[for="auto_update_toggle"]').first().click();
    await expect(page.locator('#auto_config_status')).toHaveText('未保存');
    await page.locator('label[for="auto_update_toggle"]').first().click();
    await page.locator('label[for="auto_joey_toggle"]').click();
    await expect(page.locator('#auto_config_status')).toHaveText('已保存');
    expect(writeCount(mock, '/api/auto_config')).toBe(0);
    await noOverflow(page);
});

test('failed automation save retains edits; normalized success matches reload', async ({ page, mock }) => {
    mock.allowedErrors.push(/503/, /\[saveAutoConfig\]/);
    await openPanel(page); await automation(page).click();
    await page.locator('#auto_update_interval').fill('60');
    await page.locator('#fuse_webhook').fill('  https://example.invalid/test-hook  ');
    mock.failAuto = true;
    await saveAuto(page).click();
    await expect(page.locator('.swal2-title')).toHaveText('保存失败');
    await expect(page.locator('#auto_update_interval')).toHaveValue('60');
    await expect(page.locator('#auto_config_status')).toHaveText('未保存');
    expect(mock.auto.interval).toBe(30);
    await closeAlert(page); mock.failAuto = false;
    await saveAuto(page).click();
    await expect(page.locator('#auto_config_status')).toHaveText('已保存');
    await expect(page.locator('#fuse_webhook')).toHaveValue('https://example.invalid/test-hook');
    await page.reload(); await automation(page).click();
    await expect(page.locator('#auto_update_interval')).toHaveValue('60');
    await expect(page.locator('#auto_joey_toggle')).not.toBeChecked();
    await expect(page.locator('#auto_config_status')).toHaveText('已保存');
});

test('initial loading and in-flight saves cannot overwrite newer edits or double-submit', async ({ page, mock }) => {
    let releaseInit; mock.holdInit = new Promise(resolve => { releaseInit = resolve; });
    await page.goto('/'); await automation(page).click();
    await expect(page.locator('#auto_update_interval')).toBeDisabled();
    await expect(saveAuto(page)).toBeDisabled();
    releaseInit();
    await expect(page.locator('#auto_config_status')).toHaveText('已保存');
    let releaseSave; mock.holdAuto = new Promise(resolve => { releaseSave = resolve; });
    await page.locator('#auto_update_interval').fill('90'); await saveAuto(page).click();
    await expect(page.locator('#auto_update_interval')).toBeDisabled();
    await expect(saveAuto(page)).toBeDisabled();
    await page.evaluate(() => saveAutoConfig()); // even repeated delegated actions are guarded
    expect(writeCount(mock, '/api/auto_config')).toBe(1);
    releaseSave();
    await expect(page.locator('#auto_update_interval')).toBeEnabled();
    await expect(page.locator('#auto_config_status')).toHaveText('已保存');
});

for (const t of ['cmliu', 'joey']) {
    test(t + ' upstream save failure, normalization, tab preservation and reload', async ({ page, mock }) => {
        mock.allowedErrors.push(/503/);
        await openPanel(page); await page.locator('[data-tab-btn="' + t + '"]').click();
        await upstream(page, t).locator('summary').click();
        await page.locator('#upstream_path_' + t).fill('  src/custom.js  ');
        await page.locator('#upstream_branch_' + t).fill('  release/test  ');
        await upstream(page, t).locator('summary').click();
        await expect(page.locator('#upstream_dirty_' + t)).toHaveText('未保存');
        await page.locator('[data-tab-btn="ech"]').click();
        await page.locator('[data-tab-btn="' + t + '"]').click();
        await upstream(page, t).locator('summary').click();
        await expect(page.locator('#upstream_path_' + t)).toHaveValue('  src/custom.js  ');
        mock.failUpstream = true;
        await page.locator('#upstream_save_' + t).click(); await confirm(page);
        await expect(page.locator('.swal2-title')).toHaveText('保存失败');
        await expect(page.locator('#upstream_dirty_' + t)).toHaveText('未保存');
        expect(mock.upstream[t].path).toBe('');
        await closeAlert(page); mock.failUpstream = false;
        await page.locator('#upstream_save_' + t).click(); await confirm(page);
        await expect(page.locator('#upstream_dirty_' + t)).toHaveText('已保存');
        await expect(page.locator('#upstream_path_' + t)).toHaveValue('src/custom.js');
        await page.reload(); await page.locator('[data-tab-btn="' + t + '"]').click();
        await upstream(page, t).locator('summary').click();
        await expect(page.locator('#upstream_branch_' + t)).toHaveValue('release/test');
        await expect(page.locator('#upstream_dirty_' + t)).toHaveText('已保存');
        await noOverflow(page);
    });
}

test('upstream reread asks before discarding, cancel/failure preserve edits, revert clears badge', async ({ page, mock }) => {
    mock.allowedErrors.push(/503/);
    await openPanel(page); await upstream(page).locator('summary').click();
    await page.locator('#upstream_path_cmliu').fill('draft.js');
    const reads = () => mock.requests.filter(r => r.path === '/api/upstream').length;
    const before = reads();
    await upstream(page).locator('[data-act="loadUpstream"]').click(); await cancel(page);
    expect(reads()).toBe(before);
    await expect(page.locator('#upstream_path_cmliu')).toHaveValue('draft.js');
    mock.failRead = true;
    await upstream(page).locator('[data-act="loadUpstream"]').click(); await confirm(page);
    await expect(page.locator('#upstream_status_cmliu')).toContainText('读取失败');
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('未保存');
    await expect(page.locator('#upstream_save_cmliu')).toBeEnabled();
    mock.failRead = false;
    await upstream(page).locator('[data-act="loadUpstream"]').click(); await confirm(page);
    await expect(page.locator('#upstream_path_cmliu')).toHaveValue('');
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('已保存');
    await page.locator('#upstream_path_cmliu').fill('x.js');
    await page.locator('#upstream_path_cmliu').fill('');
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('已保存');
});

test('restore default cancels safely, preserves draft on failure and persists on success', async ({ page, mock }) => {
    mock.allowedErrors.push(/503/);
    mock.upstream.cmliu.path = 'saved.js'; mock.upstream.cmliu.branch = 'main';
    await openPanel(page); await upstream(page).locator('summary').click();
    await page.locator('#upstream_path_cmliu').fill('draft.js');
    const reset = upstream(page).getByRole('button', { name: '恢复默认', exact: true });
    await reset.click(); await cancel(page);
    expect(writeCount(mock, '/api/upstream')).toBe(0);
    await expect(page.locator('#upstream_path_cmliu')).toHaveValue('draft.js');
    mock.failUpstream = true; await reset.click(); await confirm(page);
    await expect(page.locator('.swal2-title')).toHaveText('保存失败');
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('未保存');
    await closeAlert(page); mock.failUpstream = false;
    await reset.click(); await confirm(page);
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('已保存');
    expect(mock.upstream.cmliu.path).toBe('');
    await page.reload(); await upstream(page).locator('summary').click();
    await expect(page.locator('#upstream_path_cmliu')).toHaveValue('');
});

test('initial upstream read failure keeps save/reset disabled and permits retry', async ({ page, mock }) => {
    mock.failRead = true; mock.allowedErrors.push(/503/);
    await page.goto('/'); await upstream(page).locator('summary').click();
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('读取失败');
    await expect(page.locator('#upstream_path_cmliu')).toBeDisabled();
    await expect(page.locator('#upstream_save_cmliu')).toBeDisabled();
    await expect(upstream(page).getByRole('button', { name: '恢复默认', exact: true })).toBeDisabled();
    mock.failRead = false;
    await upstream(page).locator('[data-act="loadUpstream"]').click();
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('已保存');
    await expect(page.locator('#upstream_path_cmliu')).toBeEnabled();
});

test('native navigation warns only for drafts, including hidden project panels', async ({ page, mock }) => {
    await openPanel(page);
    const dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.reload(); expect(dialogs).toEqual([]);
    await upstream(page).locator('summary').click();
    await page.locator('#upstream_path_cmliu').fill('draft.js');
    await page.locator('[data-tab-btn="ech"]').click();
    await page.evaluate(() => { location.href = '/?leave'; });
    await expect.poll(() => dialogs).toEqual(['beforeunload']);
    await expect(page).toHaveURL('http://127.0.0.1:17891/');
    expect(mock.upstream.cmliu.path).toBe('');
});

test('logout cancellation does not invalidate session; confirmed discard has no duplicate prompt', async ({ page, mock }) => {
    await openPanel(page); await automation(page).click();
    await page.locator('#auto_update_interval').fill('44');
    await page.locator('[data-act="logout"]').click(); await cancel(page);
    expect(writeCount(mock, '/api/logout')).toBe(0);
    await expect(page.locator('#auto_config_status')).toHaveText('未保存');
    const dialogs = []; page.on('dialog', async d => { dialogs.push(d.type()); await d.dismiss(); });
    await page.locator('[data-act="logout"]').click();
    await Promise.all([page.waitForEvent('load'), confirm(page)]);
    expect(writeCount(mock, '/api/logout')).toBe(1);
    expect(dialogs).toEqual([]);
});

test('toolbar, account tools, template colors, workbench drag and theme remain usable', async ({ page, mock }, info) => {
    await openPanel(page);
    expect(await page.locator('html').getAttribute('data-theme') || 'light').toBe(info.project.use.colorScheme);
    await expect(page.locator('.automation-drawer')).not.toHaveAttribute('open');
    for (const act of ['toggleTheme', 'logout', 'openWorkbench', 'openBatchDeployModal', 'openYxipGuarded']) await expect(page.locator('.control-quick-actions [data-act="' + act + '"]')).toBeVisible();
    await noOverflow(page);
    await page.locator('.account-tools-drawer > summary').click();
    for (const act of ['selectAllAccounts', 'deselectAllAccounts', 'batchDeleteAccounts', 'exportAccounts', 'importAccounts', 'backupAll', 'restoreBackup']) await expect(page.locator('.account-tools-drawer [data-act="' + act + '"]')).toBeVisible();
    await noOverflow(page);
    await page.locator('[data-act="openBatchDeployModal"]').click();
    for (const t of ['cmliu', 'joey', 'ech']) {
        await page.locator('#bd_template').selectOption(t);
        await expect(page.locator('#bd_template')).toHaveAttribute('data-icon-tone', t);
    }
    await page.locator('#batch_deploy_modal [data-act="closeModal"]').first().click();
    await page.locator('[data-act="openWorkbench"]').click();
    const panel = page.locator('#workbench_panel'), handle = await page.locator('#workbench_drag').boundingBox();
    const before = await panel.boundingBox();
    await page.mouse.move(handle.x + 65, handle.y + 15); await page.mouse.down();
    await page.mouse.move(handle.x + 5, handle.y + 75, { steps: 8 }); await page.mouse.up();
    const after = await panel.boundingBox();
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(5);
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(5);
    expect(after.x).toBeGreaterThanOrEqual(0); expect(after.y).toBeGreaterThanOrEqual(0);
    expect(after.x + after.width).toBeLessThanOrEqual(info.project.use.viewport.width + 1);
    await page.locator('[data-act="closeWorkbench"]').click(); await expect(panel).not.toBeVisible();
    await noOverflow(page);
    expect(mock.requests.some(r => r.path.includes('deploy') && r.method === 'POST')).toBe(false);
    await automation(page).click();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('expanded-settings.png'), fullPage: true });
});

test('layout guards detect deliberately hidden controls and horizontal overflow', async ({ page, mock }) => {
    await openPanel(page); await automation(page).click();
    const control = saveAuto(page);
    await expect(control).toBeVisible();
    await control.evaluate(el => { el.style.display = 'none'; });
    await expect(expect(control).toBeVisible({ timeout: 100 })).rejects.toThrow();
    await control.evaluate(el => { el.style.removeProperty('display'); });
    await expect(control).toBeVisible();
    await page.evaluate(() => {
        const el = document.createElement('div'); el.id = 'e2e-overflow';
        el.style.width = (window.innerWidth + 300) + 'px'; el.style.height = '1px'; document.body.appendChild(el);
    });
    await expect(noOverflow(page)).rejects.toThrow(/Document must not overflow/);
    await page.locator('#e2e-overflow').evaluate(el => el.remove());
    await noOverflow(page);
    expect(writeCount(mock, '/api/auto_config')).toBe(0);
});

test('failed aggregate initialization falls back to saved config without marking a draft', async ({ page, mock }) => {
    mock.failInit = true; mock.allowedErrors.push(/503/, /\[init\]/);
    await page.goto('/');
    await expect(page.locator('#auto_config_status')).toHaveText('已保存');
    await closeAlert(page); await automation(page).click();
    await expect(page.locator('#auto_update_interval')).toHaveValue('30');
    await expect(page.locator('#auto_joey_toggle')).not.toBeChecked();
    await expect(saveAuto(page)).toBeEnabled();
});

test('pending upstream save disables competing edits, reset and reread', async ({ page, mock }) => {
    await openPanel(page); await upstream(page).locator('summary').click();
    await page.locator('#upstream_path_cmliu').fill('custom.js');
    let release; mock.holdUpstream = new Promise(resolve => { release = resolve; });
    await page.locator('#upstream_save_cmliu').click(); await confirm(page);
    await expect(page.locator('#upstream_path_cmliu')).toBeDisabled();
    await expect(upstream(page).locator('[data-act="loadUpstream"]')).toBeDisabled();
    await expect(upstream(page).getByRole('button', { name: '恢复默认', exact: true })).toBeDisabled();
    await page.evaluate(() => saveUpstream('cmliu', true));
    expect(writeCount(mock, '/api/upstream')).toBe(1);
    release();
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('已保存');
    await expect(page.locator('#upstream_path_cmliu')).toHaveValue('custom.js');
    expect(mock.upstream.cmliu.branch).toBe('main');
});
