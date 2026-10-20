const { test, expect, openPanel } = require('./fixtures.cjs');
test('request IDs survive reports while query parameters and error credentials do not', async ({ page, mock }) => {
    await openPanel(page);
    const id = 'req_' + 'a'.repeat(24);
    await page.route('**/api/tracing-test*', route => route.fulfill({ json: { msg: 'token="private-value"' }, status: 400, headers: { 'X-Request-ID': id } }));
    mock.allowedErrors.push(/400/);
    const result = await page.evaluate(async () => {
        let error;
        try { await apiFetch('/api/tracing-test?token=query-secret'); } catch (e) { error = e.message; }
        return { error, report: buildDebugReport('request failed', error, {}) };
    });
    expect(result.error).toContain(id);
    expect(result.report).toContain(id);
    expect(result.report).toContain('/api/tracing-test');
    expect(result.report).not.toContain('query-secret');
    expect(result.report).not.toContain('private-value');
});
