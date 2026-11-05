const { test, expect, openPanel } = require('./fixtures.cjs');

async function expectNamedControls(page) {
    // Hidden dialogs/panels have no accessibility-tree name until exposed.
    // Reveal their ancestors for this naming-only audit, without invoking writes.
    await page.evaluate(() => {
        document.querySelectorAll('input[type=checkbox], input[type=radio]').forEach(input => {
            for (let el = input; el && el !== document.body; el = el.parentElement) {
                el.classList.remove('hidden');
                el.removeAttribute('hidden');
                el.removeAttribute('inert');
                el.removeAttribute('aria-hidden');
                if (el.tagName === 'DETAILS') el.open = true;
                if (getComputedStyle(el).display === 'none') el.style.display = 'block';
            }
        });
    });
    const inputs = page.locator('input[type="checkbox"], input[type="radio"]');
    for (let i = 0; i < await inputs.count(); i++) {
        await expect(inputs.nth(i)).toHaveAccessibleName(/\S/);
    }
}

test('every static checkbox and auth radio has a nonempty accessible name', async ({ page, mock }) => {
    await openPanel(page);
    await expectNamedControls(page);
});

test('dynamic account, deployment, region, Secret and deletion choices are named without interpreting user text', async ({ page, mock }) => {
    await openPanel(page);
    const alias = '测试 <b>账号</b> 🌟';
    await page.evaluate(alias => {
        state.accounts = [{ alias, accountId: 'mock-account', apiToken: 'mock-present', workers_cmliu: ['mock-worker'] }];
        renderTable();
        addVarRow('cmliu', 'TEST', 'mock-value', true);
        openBatchDeployModal();
        closeModal('batch_deploy_modal');
        toggleYxipAccountSelect();
        yxipData = { US: ['192.0.2.1'] };
        renderYxipRegions();
    }, alias);
    await expect(page.locator('.acct-chk')).toHaveAccessibleName('选择账号：' + alias);
    await expectNamedControls(page);
    await page.evaluate(() => { confirmDeleteWorker('mock-worker', 0); });
    await expect(page.locator('#del_kv_chk')).toHaveAccessibleName('同时删除未被其他 Worker 共用的 KV');
    await page.keyboard.press('Escape');
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});


test('automation switches expose keyboard focus on their visible track', async ({ page, mock }) => {
    await openPanel(page);
    await page.locator('.automation-drawer > summary').click();
    for (const id of ['auto_update_toggle', 'auto_cmliu_toggle', 'auto_joey_toggle', 'auto_ech_toggle']) {
        const input = page.locator('#' + id);
        const before = await input.isChecked();
        // Return through the real tab order: programmatic focus after a mouse
        // click does not enable Firefox's keyboard focus indicator.
        await input.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(input).toBeFocused();
        await page.keyboard.press('Space');
        await expect(input).toBeChecked({ checked: !before });
        await expect.poll(() => input.evaluate(el => {
            const style = getComputedStyle(el.nextElementSibling);
            return { width: style.outlineWidth, style: style.outlineStyle };
        })).toEqual({ width: '2px', style: 'solid' });
    }
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
