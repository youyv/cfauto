const { test, expect, openPanel } = require('./fixtures.cjs');

test('workbench can be moved with the keyboard without trapping focus or writing', async ({ page, mock }) => {
    await openPanel(page);
    await page.evaluate(() => openWorkbench());
    const handle = page.getByRole('group', { name: '移动工作台', exact: true });
    await expect(handle).toHaveAttribute('aria-describedby', 'workbench_move_help');
    await handle.focus();
    const panel = page.locator('#workbench_panel');
    const before = await panel.boundingBox();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    const after = await panel.boundingBox();
    expect(after.y).toBeCloseTo(before.y + 10, 0);
    expect(after.x).toBeCloseTo(Math.min(before.x + 10, page.viewportSize().width - before.width), 0);
    await expect(handle).toBeFocused();
    await expect(handle).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-act="showDeployJournal"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    expect((await panel.boundingBox()).y).toBeCloseTo(after.y, 0);
    await page.locator('#theme_btn').focus();
    await expect(page.locator('#theme_btn')).toBeFocused();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('keyboard movement is clamped and ignores composing and modified shortcuts', async ({ page, mock }) => {
    await openPanel(page);
    await page.evaluate(() => openWorkbench());
    const handle = page.locator('#workbench_drag');
    await handle.focus();
    const original = await page.locator('#workbench_panel').boundingBox();
    await handle.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, isComposing: true })));
    await page.keyboard.press('Control+ArrowDown');
    expect((await page.locator('#workbench_panel').boundingBox()).y).toBeCloseTo(original.y, 0);
    await handle.evaluate(el => {
        for (let i = 0; i < 200; i++) for (const key of ['ArrowUp', 'ArrowLeft']) el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
    let rect = await page.locator('#workbench_panel').boundingBox();
    expect(rect.x).toBe(0); expect(rect.y).toBe(0);
    await handle.evaluate(el => {
        for (let i = 0; i < 200; i++) for (const key of ['ArrowDown', 'ArrowRight']) el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
    rect = await page.locator('#workbench_panel').boundingBox();
    expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('workbench log exposes incremental semantics and does not pull readers back to the bottom', async ({ page, mock }) => {
    await openPanel(page);
    await page.evaluate(() => { openWorkbench(); for (let i = 0; i < 100; i++) wbLog('mock line ' + i); });
    const log = page.getByRole('log', { name: '工作台日志', exact: true });
    await expect(log).toHaveAttribute('aria-live', 'polite');
    await expect(log).toHaveAttribute('aria-atomic', 'false');
    await expect(log).toHaveAttribute('aria-relevant', 'additions');
    await log.focus();
    await log.evaluate(el => { el.scrollTop = 0; });
    await page.evaluate(() => wbLog('mock new line'));
    await expect(log).toBeFocused();
    expect(await log.evaluate(el => el.scrollTop)).toBe(0);
    await log.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.evaluate(() => wbLog('mock follow line'));
    expect(await log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
    await page.evaluate(() => { for (let i = 0; i < 550; i++) wbLog('mock bounded line ' + i); });
    await expect(log.locator(':scope > div')).toHaveCount(500);
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('nonmodal workbench restores inside focus but does not steal outside focus', async ({ page, mock }) => {
    await openPanel(page);
    const opener = page.locator('[data-act="toggleTheme"]').first();
    await opener.focus();
    await page.evaluate(() => openWorkbench());
    await expect(opener).toBeFocused();
    await page.locator('[data-act="closeWorkbench"]').click();
    await expect(opener).toBeFocused();
    await page.evaluate(() => openWorkbench());
    await opener.focus();
    await page.evaluate(() => closeWorkbench());
    await expect(opener).toBeFocused();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
test('workbench has a single click alternative to dragging', async ({ page, mock }) => {
    await openPanel(page);
    await page.evaluate(() => openWorkbench());
    await page.locator('#workbench_panel summary').click();
    const before = await page.locator('#workbench_panel').boundingBox();
    await page.getByRole('button', { name: '工作台向右移动 10 像素', exact: true }).click();
    const after = await page.locator('#workbench_panel').boundingBox();
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.x + after.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
