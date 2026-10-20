const { test, expect, openPanel } = require('./fixtures.cjs');

// Exercise production motion, not the screenshot fixture's stop hook or CSS.
test.use({ stableRendering: false });

async function motionState(page) {
    return page.evaluate(() => ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        cached: reducedMotionQuery.matches, stopped: starAnimId === null }));
}

test('reduced motion pauses canvas and theme rotation across live preference changes', async ({ page, mock }) => {
    await openPanel(page);
    expect(await motionState(page)).toEqual({ reduced: true, cached: true, stopped: true });
    await page.evaluate(() => setDarkMode(true));
    expect(await page.evaluate(() => starAnimId)).toBeNull();
    await page.locator('#theme_btn').click();
    expect(await page.locator('#theme_btn').evaluate(el => el.style.transform)).toBe('');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => setDarkMode(true));
    await expect.poll(() => motionState(page)).toEqual({ reduced: false, cached: false, stopped: false });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => motionState(page)).toEqual({ reduced: true, cached: true, stopped: true });
    // A portal outside dashboard-shell must respect production CSS too.
    await page.evaluate(() => { Swal.fire({ title: '减少动画测试', text: '状态仍可读取' }); });
    await expect(page.locator('.swal2-popup')).toBeVisible();
    expect(await page.locator('.swal2-popup').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.locator('.swal2-confirm').click();
});

test('normal motion initializes and visibility handler respects current preference', async ({ page, mock }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(() => localStorage.setItem('worker_theme', 'dark'));
    await openPanel(page);
    await expect.poll(() => motionState(page)).toEqual({ reduced: false, cached: false, stopped: false });
    // Headless Chromium keeps tabs visible. Exercise the production listener in
    // a real browser with simulated visibility, not a claim of native tab QA.
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        setDarkMode(true);
    });
    expect(await page.evaluate(() => starAnimId)).toBeNull();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => motionState(page)).toEqual({ reduced: true, cached: true, stopped: true });
    await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await page.evaluate(() => document.hidden)).toBe(false);
    expect(await page.evaluate(() => starAnimId)).toBeNull();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => motionState(page)).toEqual({ reduced: false, cached: false, stopped: false });
    await page.evaluate(() => setDarkMode(false));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => motionState(page)).toEqual({ reduced: false, cached: false, stopped: true });
});