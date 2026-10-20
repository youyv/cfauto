const { test, expect, openPanel } = require('./fixtures.cjs');

const trigger = page => page.locator('[data-act="openBatchDeployModal"]');
const dialog = page => page.locator('#batch_deploy_modal');

test('custom dialog traps keyboard focus and restores its opener', async ({ page, mock }) => {
    await openPanel(page);
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveAttribute('role', 'dialog');
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    const close = dialog(page).locator('[data-act="closeModal"]').first();
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#btn_do_batch')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.locator('#theme_btn').evaluate(el => el.focus());
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    expect(await page.locator('.dashboard-shell').evaluate(el => el.inert)).toBe(false);
});

test('SweetAlert above a custom dialog owns Escape and returns focus inside it', async ({ page, mock }) => {
    await openPanel(page);
    await trigger(page).click();
    const close = dialog(page).locator('[data-act="closeModal"]').first();
    await close.focus();
    await page.evaluate(() => { Swal.fire({ title: '嵌套确认', text: '不执行写入', showCancelButton: true }); });
    await expect(page.locator('.swal2-confirm')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.swal2-popup')).toBeHidden();
    await expect(dialog(page)).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toBeFocused();
});

test('stacked custom dialogs close in order and repeated open preserves the original trigger', async ({ page, mock }) => {
    await openPanel(page);
    await trigger(page).click();
    const close = dialog(page).locator('[data-act="closeModal"]').first();
    await page.evaluate(() => { openModal('batch_deploy_modal'); openModal('sync_select_modal'); });
    await expect(page.locator('#sync_select_modal [data-act="closeModal"]')).toBeFocused();
    expect(await dialog(page).evaluate(el => el.inert)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toBeFocused();
});

test('empty dialog and removed opener have safe focus fallbacks', async ({ page, mock }) => {
    await openPanel(page);
    await trigger(page).click();
    await page.evaluate(() => {
        const modal = document.getElementById('sync_select_modal');
        modal.querySelectorAll('button').forEach(el => { el.disabled = true; });
        openModal('sync_select_modal');
    });
    await expect(page.locator('#sync_select_modal')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#sync_select_modal')).toBeFocused();
    await page.keyboard.press('Escape');
    await trigger(page).evaluate(el => el.remove());
    await page.keyboard.press('Escape');
    await expect(page.locator('#theme_btn')).toBeFocused();
});

test('all custom dialogs are named, but workbench stays nonmodal', async ({ page, mock }) => {
    await openPanel(page);
    for (const id of ['batch_deploy_modal', 'yxip_modal', 'account_manage_modal', 'history_modal', 'sync_select_modal']) {
        await page.locator('#theme_btn').focus();
        await page.evaluate(id => openModal(id), id);
        const modal = page.locator('#' + id);
        await expect(modal).toHaveAttribute('role', 'dialog');
        await expect(modal).toHaveAccessibleName(/.+/);
        await page.keyboard.press('Escape');
        await expect(modal).toBeHidden();
        await expect(page.locator('#theme_btn')).toBeFocused();
    }
    await page.locator('[data-act="openWorkbench"]').click();
    await expect(page.locator('#workbench_modal')).not.toHaveAttribute('aria-modal', 'true');
    await page.locator('#theme_btn').focus();
    await expect(page.locator('#theme_btn')).toBeFocused();
    await page.locator('[data-act="closeWorkbench"]').click();
});

test('closing a lower dialog does not steal focus and preserves pre-existing inert state', async ({ page, mock }) => {
    await openPanel(page);
    await page.evaluate(() => { document.getElementById('starfield').inert = true; });
    await trigger(page).click();
    await page.evaluate(() => { openModal('sync_select_modal'); closeModal('batch_deploy_modal'); });
    await expect(page.locator('#sync_select_modal [data-act="closeModal"]')).toBeFocused();
    expect(await page.locator('.dashboard-shell').evaluate(el => el.inert)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#theme_btn')).toBeFocused();
    expect(await page.locator('#starfield').evaluate(el => el.inert)).toBe(true);
    expect(await page.locator('.dashboard-shell').evaluate(el => el.inert)).toBe(false);
});

test('toast does not disable dialog keyboard handling or submit any writes', async ({ page, mock }) => {
    await openPanel(page);
    await trigger(page).click();
    await page.evaluate(() => { Swal.fire({ toast: true, title: '本地状态', showConfirmButton: false }); });
    await expect(page.locator('.swal2-toast')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});


test('Escape clears node search before closing the dialog and composing Escape is ignored', async ({ page, mock }) => {
    await openPanel(page);
    await page.evaluate(() => {
        yxipData = { US: ['192.0.2.1'] };
        renderYxipRegions();
        openModal('yxip_modal');
    });
    const search = page.locator('#yxip_search');
    await search.fill('US');
    await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page.locator('#yxip_modal')).toBeVisible();
    await search.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
    await expect(page.locator('#yxip_modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#yxip_modal')).toBeHidden();
});
