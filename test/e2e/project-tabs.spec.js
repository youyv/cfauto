const { test, expect, openPanel } = require('./fixtures.cjs');

test('project tabs expose reciprocal panel relationships and one selected tab stop', async ({ page, mock }) => {
    await openPanel(page);
    const list = page.getByRole('tablist', { name: '部署项目' });
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('aria-orientation', 'horizontal');
    for (const t of ['cmliu', 'joey', 'ech']) {
        const tab = page.locator('[data-tab-btn="' + t + '"]');
        await tab.click();
        await expect(tab).toHaveAttribute('role', 'tab');
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(tab).toHaveAttribute('tabindex', '0');
        const panel = page.locator('[data-tab-panel="' + t + '"]');
        await expect(panel).toHaveAttribute('role', 'tabpanel');
        await expect(panel).toHaveAttribute('aria-labelledby', await tab.getAttribute('id'));
        await expect(tab).toHaveAttribute('aria-controls', await panel.getAttribute('id'));
        await expect(panel).toHaveAccessibleName(new RegExp(t, 'i'));
        await expect(page.locator('[data-tab-btn][tabindex="0"]')).toHaveCount(1);
        await expect(page.getByRole('tabpanel')).toHaveCount(1);
        await expect(page.locator('[data-tab-panel][hidden]')).toHaveCount(2);
    }
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('arrow and boundary keys activate tabs, and Tab exits to the active panel', async ({ page, mock }) => {
    await openPanel(page);
    const cmliu = page.locator('[data-tab-btn="cmliu"]');
    await cmliu.focus();
    for (const [key, target] of [['ArrowLeft', 'ech'], ['ArrowRight', 'cmliu'], ['End', 'ech'], ['Home', 'cmliu'], ['ArrowRight', 'joey']]) {
        await page.keyboard.press(key);
        const tab = page.locator('[data-tab-btn="' + target + '"]');
        await expect(tab).toBeFocused();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-tab-panel="' + target + '"]')).toBeVisible();
    }
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-tab-panel="joey"]')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[data-tab-btn="joey"]')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-tab-btn="joey"]')).toHaveAttribute('aria-selected', 'true');
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('project keyboard switching preserves drafts and ignores invalid/composing navigation', async ({ page, mock }) => {
    await openPanel(page);
    await page.locator('[data-tab-panel="cmliu"] .upstream-card > summary').click();
    const path = page.locator('#upstream_path_cmliu');
    await path.fill('src/keep-draft.js');
    const tab = page.locator('[data-tab-btn="cmliu"]');
    await tab.focus();
    await tab.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, isComposing: true })));
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(path).toHaveValue('src/keep-draft.js');
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('未保存');
    await page.evaluate(() => switchProjectTab('unknown-project'));
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-tab-panel="cmliu"]')).toBeVisible();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
