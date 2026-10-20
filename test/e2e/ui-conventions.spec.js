const { test, expect, openPanel, noOverflow } = require('./fixtures.cjs');

test('user text in dynamic buttons is never interpreted as an icon', async ({ page, mock }) => {
    await openPanel(page);
    await page.evaluate(() => {
        const button = document.createElement('button');
        button.id = 'user-text-probe'; button.type = 'button';
        button.textContent = '账号 ★ 🚀 <img onerror=alert(1)> ×';
        document.body.appendChild(button);
        decorateUiIcons(button);
    });
    const button = page.locator('#user-text-probe');
    await expect(button).toHaveText('账号 ★ 🚀 <img onerror=alert(1)> ×');
    await expect(button.locator('svg, img, [data-ui-icon]')).toHaveCount(0);
    await expect(button).toHaveAttribute('title', '账号 ★ 🚀 <img onerror=alert(1)> ×');
});

test('explicit icon names and busy restoration preserve content and accessible names', async ({ page, mock }) => {
    await openPanel(page);
    const result = await page.evaluate(() => {
        const button = document.createElement('button'); button.type = 'button';
        button.id = 'explicit-probe'; document.body.appendChild(button);
        setUiContent(button, 'save', '保存 ★ 原文');
        const originalNodes = [...button.childNodes];
        const restore = beginButtonBusy(button, '测试等待');
        const busy = button.disabled && button.getAttribute('aria-busy') === 'true' && !!button.querySelector('[data-ui-icon="loader-circle"] svg');
        restore(); restore(); // idempotent
        const restored = originalNodes.every((node, i) => node === button.childNodes[i]);
        const text = button.textContent.trim();
        setUiContent(button, 'x', '', { label: '关闭测试窗口' });
        decorateUiIcons(button);
        return { busy, restored, text, disabled: button.disabled, ariaBusy: button.getAttribute('aria-busy') };
    });
    expect(result).toEqual({ busy: true, restored: true, text: '保存 ★ 原文', disabled: false, ariaBusy: null });
    await expect(page.getByRole('button', { name: '关闭测试窗口', exact: true })).toBeVisible();
    await expect(page.locator('#explicit-probe svg')).toHaveCount(1);
    await expect(page.locator('#explicit-probe')).not.toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('[data-act="closeWorkbench"]')).toHaveAttribute('aria-label', '关闭工作台');
    await expect(page.locator('[data-act="regenBatchUuid"]')).toHaveAttribute('aria-label', '重新生成批量部署 UUID');
    await noOverflow(page);
});

test('variable controls are named and native select options stay text only', async ({ page, mock }, info) => {
    await openPanel(page);
    await page.locator('[data-tab-btn="cmliu"]').click();
    await page.locator('[data-tab-panel="cmliu"] [data-act="addVarRow"]').click();
    await page.locator('#vars_cmliu').evaluate(el => { el.closest('details').open = true; });
    const row = page.locator('.var-row-cmliu').last();
    await expect(row.getByRole('textbox', { name: '变量名称', exact: true })).toBeVisible();
    await expect(row.getByRole('textbox', { name: '变量值', exact: true })).toBeVisible();
    await expect(row.getByRole('checkbox', { name: '标记为 Secret 变量' })).toBeVisible();
    await expect(row.getByRole('button', { name: '删除该变量（部署时会从 Worker 移除）' })).toHaveAttribute('type', 'button');
    expect(await page.locator('option').evaluateAll(options => options.every(o => o.children.length === 0))).toBe(true);
    await page.screenshot({ path: info.outputPath('ui-conventions.png'), fullPage: true });
    await noOverflow(page);
});


test('stats success and failure both restore the original SVG button', async ({ page, mock }) => {
    await openPanel(page);
    const button = page.locator('#btn_stats');
    await expect(button.locator('[data-ui-icon="refresh-cw"] svg')).toHaveCount(1);
    for (const status of [200, 503]) {
        if (status === 503) mock.allowedErrors.push(/503/);
        await page.route('**/api/stats', route => route.fulfill({ status, json: status === 200 ? [] : { msg: 'mock unavailable' } }));
        await button.click();
        if (status === 503) {
            await expect(page.locator('.swal2-popup')).toContainText('用量查询失败');
            await page.locator('.swal2-confirm').click();
        }
        await expect(button).toBeEnabled();
        await expect(button.locator('[data-ui-icon="refresh-cw"] svg')).toHaveCount(1);
        await expect(button).not.toHaveAttribute('aria-busy', 'true');
    }
});
