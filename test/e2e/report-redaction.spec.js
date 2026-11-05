const { test, expect, openPanel } = require('./fixtures.cjs');

test('public issue report redacts JSON logs and Secret context without changing local inputs', async ({ page, mock }) => {
    await openPanel(page);
    const result = await page.evaluate(() => {
        const context = { variables: [{ key: 'CUSTOM', value: 'mock-variable-private', secret: true }], credentials: { apiToken: 'mock-api-private' }, status: 'failed' };
        wbLog('{"token":"mock-log-private","status":503}');
        const report = buildDebugReport('password=xy', 'secret=zz', context);
        window.__openedIssue = null;
        window.open = url => { window.__openedIssue = url; return null; };
        reportIssue();
        return { report, value: context.variables[0].value };
    });
    expect(result.report).not.toMatch(/mock-variable-private|mock-api-private|mock-log-private|=xy|=zz/);
    expect(result.report).toContain('failed');
    expect(result.report).toContain('503');
    expect(result.value).toBe('mock-variable-private');
    await page.locator('.swal2-confirm').click();
    const issue = new URL(await page.evaluate(() => window.__openedIssue));
    expect(issue.origin).toBe('https://github.com');
    expect(issue.searchParams.get('body')).not.toContain('mock-log-private');
    expect(issue.searchParams.get('body')).toContain('503');
    expect(mock.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
