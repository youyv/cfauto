const { test, expect, openPanel } = require('./fixtures.cjs');

// Bound the unknown gradient/canvas behind translucent glass by black and white.
// This is a conservative CSS-color check, not a pixel or full-page WCAG audit.
async function contrastBounds(locator) {
    return locator.evaluate(el => {
        const rgb = value => {
            const match = /^rgba?\(([^)]+)\)$/.exec(value);
            if (!match) throw new Error('Unsupported color: ' + value);
            const parts = match[1].split(',').map(Number);
            return [...parts.slice(0, 3), parts.length === 4 ? parts[3] : 1];
        };
        const layers = [];
        for (let node = el; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (Number(style.opacity) !== 1 || style.mixBlendMode !== 'normal' || style.filter !== 'none') {
                throw new Error('Opacity/blending/filter needs a separate visual audit');
            }
            // An image/gradient is treated as an arbitrary substrate, not ignored.
            if (style.backgroundImage !== 'none') break;
            const color = rgb(style.backgroundColor);
            layers.push(color);
            if (color[3] === 1) break;
        }
        const compose = base => layers.reduceRight((back, front) => front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3])), base);
        const luminance = color => color.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const fg = rgb(getComputedStyle(el).color);
        if (fg[3] !== 1) throw new Error('Translucent text needs a separate audit');
        const low = luminance(compose([0, 0, 0])), high = luminance(compose([255, 255, 255])), text = luminance(fg);
        const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        return { color: getComputedStyle(el).color, minimum: text >= low && text <= high ? 1 : Math.min(ratio(text, low), ratio(text, high)) };
    });
}

test('configuration, upstream and Token status text meet 4.5:1 across their glass background bounds', async ({ page, mock }, info) => {
    await openPanel(page);
    const results = [];
    async function check(id, state) {
        const target = page.locator('#' + id);
        await expect(target).toBeVisible();
        const result = await contrastBounds(target);
        results.push({ id, state, ...result });
        expect.soft(result.minimum, id + ' (' + state + ') ' + JSON.stringify(result)).toBeGreaterThanOrEqual(4.5);
    }
    await check('auto_config_status', 'saved');
    await check('auto_runtime_summary', 'collapsed');
    await page.locator('.automation-drawer > summary').click();
    await page.locator('#auto_update_interval').fill('45');
    await check('auto_config_status', 'dirty');
    await check('auto_runtime_details', 'expanded');
    for (const t of ['cmliu', 'joey']) {
        await page.locator('[data-tab-btn="' + t + '"]').click();
        await page.locator('[data-tab-panel="' + t + '"] .upstream-card > summary').click();
        await check('upstream_dirty_' + t, 'saved');
        await check('upstream_status_' + t, 'loaded');
        await page.locator('#upstream_path_' + t).fill('src/test.js');
        await check('upstream_dirty_' + t, 'dirty');
        await page.locator('[data-tab-panel="' + t + '"] [data-act="validateUpstream"]').click();
        await expect(page.locator('#upstream_validation_' + t)).toContainText('验证通过');
        await check('upstream_validation_' + t, 'success');
        mock.failValidation = true; mock.allowedErrors.push(/503/);
        await page.locator('[data-tab-panel="' + t + '"] [data-act="validateUpstream"]').click();
        await expect(page.locator('#upstream_validation_' + t)).toContainText('验证失败');
        await check('upstream_validation_' + t, 'failure');
        mock.failValidation = false;
    }
    await page.locator('[data-tab-btn="ech"]').click();
    await check('ech_token_status', 'off');
    await page.locator('[data-tab-panel="ech"]').screenshot({ path: info.outputPath('token-off.png') });
    await page.locator('#ech_token_enabled').focus();
    await page.keyboard.press('Space');
    await check('ech_token_status', 'on');
    await page.locator('[data-tab-panel="ech"]').screenshot({ path: info.outputPath('token-on.png') });
    await info.attach('status-contrast-bounds', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(mock.requests.filter(r => r.method !== 'GET' && r.path !== '/api/upstream/validate')).toEqual([]);
});

// Deliberate examples ensure the checker cannot silently accept invalid math/colors.
test('contrast guard distinguishes opaque, low contrast and uncertain translucent backgrounds', async ({ page, mock }) => {
    await openPanel(page);
    await page.evaluate(() => {
        const el = document.createElement('span'); el.id = 'contrast_probe'; el.textContent = 'probe';
        el.style.cssText = 'color: white; background: black;';
        const substrate = document.createElement('div'); substrate.style.backgroundImage = 'linear-gradient(black, white)';
        substrate.appendChild(el); document.body.appendChild(substrate);
    });
    const probe = page.locator('#contrast_probe');
    expect((await contrastBounds(probe)).minimum).toBeCloseTo(21, 5);
    await probe.evaluate(el => { el.style.color = 'black'; });
    expect((await contrastBounds(probe)).minimum).toBe(1);
    await probe.evaluate(el => { el.style.color = 'white'; el.style.background = 'rgba(0, 0, 0, .5)'; });
    const translucent = await contrastBounds(probe);
    expect(translucent.minimum).toBeGreaterThan(1);
    expect(translucent.minimum).toBeLessThan(4.5);
    await probe.evaluate(el => { el.style.background = 'transparent'; el.style.color = 'rgb(128, 128, 128)'; });
    expect((await contrastBounds(probe)).minimum).toBe(1);
});

test('batch deployment labels remain readable in each theme', async ({ page, mock }, info) => {
    await openPanel(page);
    await page.evaluate(() => openBatchDeployModal());
    const labels = page.locator('#batch_deploy_modal label[for]');
    const results = [];
    for (const label of await labels.all()) {
        if (!await label.isVisible()) continue;
        const name = await label.getAttribute('for');
        const result = await contrastBounds(label);
        results.push({ name, ...result });
        expect.soft(result.minimum, name + ' ' + JSON.stringify(result)).toBeGreaterThanOrEqual(4.5);
    }
    await info.attach('batch-label-contrast', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
