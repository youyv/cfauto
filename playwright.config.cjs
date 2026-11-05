const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './test/e2e',
    testMatch: '**/*.spec.js',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : 3,
    timeout: 30000,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://127.0.0.1:17891',
        browserName: 'chromium',
        locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
        contextOptions: { reducedMotion: 'reduce' },
        serviceWorkers: 'block',
        trace: 'retain-on-failure', screenshot: 'only-on-failure'
    },
    projects: ['light', 'dark'].flatMap(colorScheme => [
        { name: 'desktop-' + colorScheme, use: { colorScheme, viewport: { width: 1440, height: 1000 } } },
        { name: 'tablet-' + colorScheme, use: { colorScheme, viewport: { width: 820, height: 1180 }, hasTouch: true } },
        { name: 'mobile-' + colorScheme, use: { colorScheme, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }
    ]),
    webServer: {
        command: 'node build.js && node test/e2e/server.cjs',
        url: 'http://127.0.0.1:17891',
        reuseExistingServer: false,
        timeout: 60000
    }
});
