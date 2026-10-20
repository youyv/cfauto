const { test, expect, openPanel } = require('./fixtures.cjs');

async function expectStatus(locator, name) {
    await expect(locator).toHaveAttribute('role', 'status');
    await expect(locator).toHaveAttribute('aria-live', 'polite');
    await expect(locator).toHaveAttribute('aria-atomic', 'true');
    await expect(locator).toHaveAccessibleName(name);
}

test('configuration status has context and only mutates on meaningful transitions', async ({ page, mock }) => {
    await openPanel(page);
    const badge = page.locator('#auto_config_status');
    await expectStatus(badge, '自动任务配置保存状态');
    await expectStatus(page.locator('#auto_runtime_summary'), '自动任务已保存运行设置');
    await page.locator('.automation-drawer > summary').click();
    const input = page.locator('#fuse_webhook');
    await input.fill('https://example.invalid/private-hook');
    await expect(badge).toHaveText('未保存');
    const mutations = await page.evaluate(async () => {
        const records = [];
        const observer = new MutationObserver(items => records.push(...items));
        observer.observe($('auto_config_status'), { childList: true, characterData: true, subtree: true });
        observer.observe($('auto_runtime_summary'), { childList: true, characterData: true, subtree: true });
        $('fuse_webhook').value += '/changed';
        $('fuse_webhook').dispatchEvent(new Event('input', { bubbles: true }));
        renderAutomationSummary(state.savedAutoConfig);
        await Promise.resolve();
        observer.disconnect();
        return records.length;
    });
    expect(mutations).toBe(0);
    await expect(input).toBeFocused();
    await expect(badge).not.toContainText('private-hook');
    await input.fill('');
    await expect(badge).toHaveText('已保存');
    await page.locator('.automation-drawer > summary').click();
    await expect(badge).toBeVisible();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('upstream statuses describe load failure, retry and validation without saving drafts', async ({ page, mock }) => {
    mock.failRead = true; mock.allowedErrors.push(/503/);
    await page.goto('/');
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('读取失败');
    mock.failRead = false;
    await page.locator('[data-tab-btn="cmliu"]').click();
    const card = page.locator('[data-tab-panel="cmliu"] .upstream-card');
    await card.locator('summary').click();
    await expectStatus(page.locator('#upstream_dirty_cmliu'), 'CMliu 上游配置保存状态');
    await expectStatus(page.locator('#upstream_status_cmliu'), 'CMliu 上游读取状态');
    const result = page.locator('#upstream_validation_cmliu');
    await expectStatus(result, 'CMliu 上游草稿验证结果');
    await card.locator('[data-act="loadUpstream"]').click();
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('已保存');
    await page.locator('#upstream_path_cmliu').fill('src/test.js');
    await card.locator('[data-act="validateUpstream"]').click();
    await expect(result).toContainText('验证通过（未保存）');
    await page.locator('#upstream_path_cmliu').fill('src/next.js');
    await expect(result).toHaveText('');
    mock.failValidation = true;
    await card.locator('[data-act="validateUpstream"]').click();
    await expect(result).toContainText('验证失败');
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('未保存');
    expect(mock.requests.filter(r => r.method === 'POST' && r.path !== '/api/upstream/validate')).toEqual([]);
});

test('Token injection status is associated with its control and never contains the Token value', async ({ page, mock }) => {
    await openPanel(page);
    await page.locator('[data-tab-btn="ech"]').click();
    const status = page.locator('#ech_token_status'), control = page.locator('#ech_token_enabled');
    await expectStatus(status, 'ECH Token 注入状态');
    await expect(control).toHaveAttribute('aria-describedby', 'ech_token_status');
    await control.focus();
    await page.keyboard.press('Space');
    await expect(status).toContainText('已开启');
    await page.locator('#ech_token_input').fill('mock-secret-do-not-announce');
    await expect(status).not.toContainText('mock-secret');
    await control.focus();
    await page.keyboard.press('Space');
    await expect(status).toContainText('关闭');
    await expect(control).toBeFocused();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
