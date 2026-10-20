const { defineConfig } = require('@playwright/test');
const base = require('./playwright.config.cjs');
// Bounded cross-engine regression, not a substitute for real devices/assistive technology.
module.exports = defineConfig({
    ...base,
    testMatch: /(?:deploy-preview|subdomain-confirmation|repair-confirmation|workbench-accessibility|project-tabs|control-names|request-tracing|ui-conventions)\.spec\.js$/,
    projects: ['firefox', 'webkit'].flatMap(browserName => ['light', 'dark'].map(colorScheme => ({
        name: browserName + '-' + colorScheme,
        use: { browserName, colorScheme, viewport: { width: 1440, height: 1000 } }
    })))
});
