const { test, expect, openPanel, noOverflow } = require('./fixtures.cjs');
const backup = { VARS_cmliu: [{ key: 'TEST', value: 'fake-private-value' }], VARS_joey: [] };
async function pick(page, data = backup, raw) {
    await page.locator('.account-tools-drawer > summary').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-act="restoreBackup"]').click();
    await (await chooser).setFiles({ name: 'test-backup.json', mimeType: 'application/json', buffer: Buffer.from(raw || JSON.stringify(data)) });
}
async function confirm(page) {
    await page.locator('.swal2-input').fill('恢复');
    await page.locator('.swal2-confirm').click();
}
test('restore preview cancels without writes and never renders backup secrets', async ({ page, mock }) => {
    await openPanel(page); await pick(page);
    await expect(page.locator('.swal2-title')).toHaveText('确认恢复配置');
    await expect(page.locator('.swal2-html-container')).not.toContainText('fake-private-value');
    await expect(page.locator('.swal2-html-container')).toContainText('VARS_cmliu');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('.swal2-validation-message')).toContainText('请输入');
    expect(mock.requests.filter(r => r.path === '/api/restore')).toHaveLength(0);
    await noOverflow(page);
    await page.locator('.swal2-cancel').click();
    await expect(page.locator('[data-act="restoreBackup"]')).toBeEnabled();
    expect(mock.requests.filter(r => r.path === '/api/restore')).toHaveLength(0);
});
test('restore validation failure is rendered without sending a write', async ({ page, mock }) => {
    mock.invalidRestore = true; mock.allowedErrors.push(/400/);
    await openPanel(page); await pick(page, { '<img src=x onerror=alert(1)>': 'fake-private-value' });
    await expect(page.locator('.swal2-title')).toContainText('预检未通过');
    await expect(page.locator('.restore-report img')).toHaveCount(0);
    await expect(page.locator('.swal2-html-container')).not.toContainText('fake-private-value');
    expect(mock.requests.filter(r => r.path === '/api/restore')).toHaveLength(0);
    await noOverflow(page);
});
test('oversized backup is rejected before parsing or network access', async ({ page, mock }) => {
    await openPanel(page); await pick(page, null, ' '.repeat(5 * 1024 * 1024 + 1));
    await expect(page.locator('.swal2-title')).toHaveText('文件过大');
    expect(mock.requests.filter(r => r.path.startsWith('/api/restore'))).toHaveLength(0);
});
test('successful restore retains a downloadable snapshot and does not discard unsaved settings', async ({ page, mock }) => {
    await openPanel(page);
    await page.locator('.automation-drawer > summary').click();
    await page.locator('#auto_update_interval').fill('45');
    await pick(page); await confirm(page);
    await expect(page.locator('.swal2-title')).toHaveText('恢复完成');
    const download = page.waitForEvent('download');
    await page.locator('.restore-snapshot-link').click();
    const file = await download;
    expect(file.suggestedFilename()).toContain('restore-snapshot');
    expect(JSON.parse(await require('node:fs/promises').readFile(await file.path(), 'utf8'))._format).toBe('worker-pro-recovery@1');
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('#auto_update_interval')).toHaveValue('45');
    await expect(page.locator('#auto_config_status')).toHaveText('未保存');
    expect(mock.requests.filter(r => r.path === '/api/restore')).toHaveLength(1);
});
test('partial restore reports unknown writes and keeps the recovery link on mobile and dark mode', async ({ page, mock }, info) => {
    mock.partialRestore = true;
    await openPanel(page); await pick(page); await confirm(page);
    await expect(page.locator('.swal2-title')).toContainText('部分失败');
    await expect(page.locator('.swal2-html-container')).toContainText('结果未知，可能已写入');
    await expect(page.locator('.restore-snapshot-link')).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('restore-partial.png'), fullPage: true });
    await page.locator('.swal2-confirm').click();
    await page.reload();
    await page.locator('.account-tools-drawer > summary').click();
    const download = page.waitForEvent('download');
    await page.locator('[data-act="downloadRestoreSnapshot"]').click();
    expect((await download).suggestedFilename()).toContain('restore-snapshot');
});
test('lost restore response does not claim no writes and still exposes the known snapshot ID', async ({ page, mock }) => {
    mock.failRestore = true; mock.allowedErrors.push(/503/);
    await openPanel(page); await pick(page); await confirm(page);
    await expect(page.locator('.swal2-title')).toHaveText('恢复未完成');
    await expect(page.locator('.swal2-html-container')).toContainText('不代表没有写入');
    await expect(page.locator('.restore-snapshot-link')).toBeVisible();
    await expect(page.locator('[data-act="restoreBackup"]')).toBeDisabled();
    await page.locator('.swal2-confirm').click();
    await expect(page.locator('[data-act="restoreBackup"]')).toBeEnabled();
});
