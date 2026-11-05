const { test, expect, openPanel, noOverflow } = require('./fixtures.cjs');

test('saved runtime summary does not follow drafts; save, close and reload stay consistent', async ({ page, mock }, info) => {
    mock.auto.lastCheck = Date.parse('2026-09-30T00:00:00Z');
    await openPanel(page);
    const summary = page.locator('#auto_runtime_summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('已启用 · 30 分钟');
    await page.locator('.automation-drawer > summary').click();
    await page.locator('#auto_update_interval').fill('45');
    await page.locator('.automation-drawer > summary').click();
    await expect(summary).toContainText('30 分钟');
    await expect(page.locator('#auto_config_status')).toHaveText('未保存');
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('saved-summary-draft.png'), fullPage: true });
    await page.locator('.automation-drawer > summary').click();
    await page.locator('[data-act="saveAutoConfig"]').click();
    await expect(summary).toContainText('45 分钟');
    await page.evaluate(() => Swal.close());
    await page.locator('label[for="auto_update_toggle"]').first().click();
    await expect(summary).toContainText('已启用');
    await page.locator('[data-act="saveAutoConfig"]').click();
    await expect(summary).toContainText('已关闭');
    await page.reload();
    await expect(summary).toContainText('已关闭');
    await noOverflow(page);
});

for (const t of ['cmliu', 'joey']) test(t + ' validation is read-only, retains dirty state, and invalidates stale results', async ({ page, mock }, info) => {
    await openPanel(page);
    await page.locator('[data-tab-btn="' + t + '"]').click();
    const card = page.locator('[data-tab-panel="' + t + '"] .upstream-card');
    await card.locator('summary').click();
    const path = page.locator('#upstream_path_' + t), result = page.locator('#upstream_validation_' + t);
    await path.fill('src/draft.js');
    await page.locator('#upstream_branch_' + t).fill('feature/test');
    await card.locator('[data-act="validateUpstream"]').click();
    await expect(result).toContainText('验证通过（未保存）');
    await expect(result).toContainText('a'.repeat(40));
    await expect(page.locator('#upstream_dirty_' + t)).toHaveText('未保存');
    expect(mock.upstream[t].path).toBe('');
    expect(mock.requests.filter(r => r.path === '/api/upstream' && r.method === 'POST')).toHaveLength(0);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('upstream-validation.png'), fullPage: true });
    await path.fill('src/new.js');
    await expect(result).toHaveText('');
    mock.failValidation = true; mock.allowedErrors.push(/503/);
    await card.locator('[data-act="validateUpstream"]').click();
    await expect(result).toContainText('验证失败');
    await expect(path).toHaveValue('src/new.js');
    await expect(page.locator('#upstream_dirty_' + t)).toHaveText('未保存');
});

test('production local CSS covers dynamic controls and modal with no external script hosts', async ({ page, mock }) => {
    await openPanel(page);
    const sources = await page.locator('script[src]').evaluateAll(nodes => nodes.map(n => n.src));
    expect(sources.every(url => new URL(url).origin === 'http://127.0.0.1:17891')).toBe(true);
    const response = await page.request.get('/');
    expect(response.headers()['content-security-policy']).not.toContain('tailwindcss');
    await page.locator('[data-act="resetFormForAdd"]').click();
    await expect(page.locator('#in_alias')).toBeVisible();
    await page.locator('[data-act="cancelEdit"]').click();
    await page.locator('.automation-drawer > summary').click();
    await page.locator('#auto_update_interval').fill('0');
    await page.locator('[data-act="saveAutoConfig"]').click();
    await expect(page.locator('.swal2-popup')).toBeVisible();
    await noOverflow(page);
});
