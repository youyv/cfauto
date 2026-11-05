const { test: base, expect } = require('@playwright/test');

const test = base.extend({
    stableRendering: [true, { option: true }],
    mock: async ({ page, stableRendering }, use) => {
        const mock = {
            auto: { enabled: true, interval: 30, autoCmliu: true, autoJoey: false, autoEch: true, fuseThreshold: 0, fuseWebhook: '' },
            upstream: Object.fromEntries(['cmliu', 'joey'].map(t => [t, { path: '', branch: '', repository: t + '/test-repo', defaultPath: '_worker.js', defaultBranch: 'main' }])),
            requests: [], unexpected: [], errors: [], allowedErrors: [],
            // Most UI scenarios exercise the synchronous legacy adapters explicitly.
            recoveryMode: 'legacy',
            invalidRestore: false, partialRestore: false, failRestore: false,
            failValidation: false,
            failAuto: false, failUpstream: false, failRead: false, failInit: false,
            holdAuto: null, holdUpstream: null, holdInit: null
        };
        page.on('pageerror', e => mock.errors.push(e.message));
        page.on('console', msg => { if (msg.type() === 'error') mock.errors.push(msg.text()); });
        await page.clock.setFixedTime(new Date('2026-10-01T00:00:00+08:00'));
        if (stableRendering) await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
            // Test-only: stop the decorative canvas as well as CSS animations.
            if (typeof stopStarfield === 'function') stopStarfield();
        }));
        await page.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== 'http://127.0.0.1:17891') { mock.unexpected.push(request.url()); return route.abort(); }
            if (url.pathname === '/test/rendering.css' && !stableRendering) return route.fulfill({ contentType: 'text/css', body: '' });
            if (!url.pathname.startsWith('/api/')) return route.continue();
            const method = request.method(), body = request.postDataJSON();
            mock.requests.push({ path: url.pathname, method, body });
            const json = data => route.fulfill({ json: data });
            const fail = () => route.fulfill({ status: 503, json: { success: false, msg: 'mock unavailable' } });
            switch (url.pathname) {
                case '/api/init_data':
                    if (mock.holdInit) await mock.holdInit;
                    if (mock.failInit) return fail();
                    return json({ accounts: [], autoConfig: mock.auto, vars: {}, deployConfigs: {} });
                case '/api/reliability/recovery':
                    return json({ format: 'cfauto.recovery-workflow', version: 1, mode: mock.recoveryMode, protocol: 1,
                        ...(mock.recoveryMode === 'authority'
                            ? { status: { generation: 'e2e-generation', epoch: 1, maintenance: false, protocol: 1 } }
                            : { transactional: false }) });
                case '/api/accounts': return json([]);
                case '/api/settings': return json([]);
                case '/api/stats': return json([]);
                case '/api/auto_config':
                    if (method === 'POST') {
                        if (mock.holdAuto) await mock.holdAuto;
                        if (mock.failAuto) return fail();
                        mock.auto = { ...mock.auto, ...body, interval: Math.floor(body.interval), fuseWebhook: body.fuseWebhook.trim() };
                        return json({ success: true, config: mock.auto });
                    }
                    return json(mock.auto);
                case '/api/upstream': {
                    const t = url.searchParams.get('type');
                    if (!mock.upstream[t]) break;
                    if (method === 'POST') {
                        if (mock.holdUpstream) await mock.holdUpstream;
                        if (mock.failUpstream) return fail();
                        mock.upstream[t] = { ...mock.upstream[t], path: body.path.trim(), branch: body.branch.trim() };
                    } else if (mock.failRead) return fail();
                    return json(mock.upstream[t]);
                }
                case '/api/upstream/validate':
                    if (mock.failValidation) return fail();
                    return json({ success: true, repository: 'official/mock', path: body.path, branch: body.branch, sha: 'a'.repeat(40) });
                case '/api/restore/preview': {
                    const invalid = mock.invalidRestore;
                    return route.fulfill({ status: invalid ? 400 : 200, json: { success: !invalid, preview: {
                        valid: !invalid, counts: { add: 1, overwrite: 1, skip: 0, invalid: invalid ? 1 : 0, unsupported: 0 },
                        items: Object.keys(body).map(key => ({ key, action: invalid ? 'invalid' : 'overwrite' })),
                        errors: invalid ? ['备份内容无效'] : [], encryption: 'legacy-checked',
                        semantics: '按键合并；缺失键和 null 不变。'
                    } } });
                }
                case '/api/restore':
                    if (mock.failRestore) return fail();
                    return route.fulfill({ status: mock.partialRestore ? 207 : 200, json: {
                        success: !mock.partialRestore, restored: 1, snapshotId: request.headers()['x-restore-snapshot-id'],
                        msg: mock.partialRestore ? '写入异常，已停止后续项' : '恢复完成', warning: '不会自动回滚。',
                        results: [{ key: 'VARS_cmliu', status: 'written' }, { key: 'VARS_joey', status: mock.partialRestore ? 'unknown' : 'written' }]
                    } });
                case '/api/restore/snapshot':
                    return route.fulfill({ headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="restore-snapshot-test.json"' },
                        body: JSON.stringify({ _format: 'worker-pro-recovery@1', put: [], delete: [] }) });
                case '/api/deploy_config': return json({ mode: 'auto' });
                case '/api/check_update': return json({ success: true, remote: { sha: 'mock-sha', date: '2026-09-30T00:00:00Z' }, local: { sha: 'mock-sha', date: '2026-09-30T00:00:00Z' } });
                case '/api/logout': return json({ success: true });
            }
            mock.unexpected.push(method + ' ' + url.pathname);
            return route.fulfill({ status: 501, json: { success: false, msg: 'Unmocked API' } });
        });
        await use(mock);
        expect(mock.unexpected, 'No external requests or unmocked API calls').toEqual([]);
        expect(mock.errors.filter(e => !mock.allowedErrors.some(pattern => pattern.test(e))), 'No unexpected console/page errors').toEqual([]);
    }
});
async function openPanel(page) {
    await page.goto('/');
    await expect(page.locator('#auto_config_status')).toHaveText('已保存');
    await expect(page.locator('#upstream_dirty_cmliu')).toHaveText('已保存');
    await expect(page.locator('#upstream_dirty_joey')).toHaveText('已保存');
    await expect(page.locator('#btn_stats')).toBeEnabled();
}
async function noOverflow(page) {
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
    expect(size.scroll, 'Document must not overflow horizontally').toBeLessThanOrEqual(size.width + 1);
}
module.exports = { test, expect, openPanel, noOverflow };
