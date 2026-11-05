import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
function reportContext() {
    const context = vm.createContext({ window: { APP_VERSION: 'test' }, location: { origin: 'https://mock.invalid' }, registerActions() {}, recentWbLogs: [] });
    vm.runInContext(fs.readFileSync('frontend/js/diagnostics.js', 'utf8'), context);
    return context;
}
describe('C5 public diagnostic report redaction', () => {
    it.each(['token', 'apiToken', 'globalKey', 'ACCESS_CODE', 'ENCRYPTION_SECRET', 'password', 'Authorization', 'Cookie', 'fuseWebhook'])('redacts quoted and short %s values', key => {
        const c = reportContext();
        c.input = JSON.stringify({ [key]: 'x! q\"z', route: '/api/diag' });
        const result = vm.runInContext('redactForReport(input)', c);
        expect(result).not.toContain('x!');
        expect(result).toContain('/api/diag');
    });
    it('redacts nested sensitive objects and Secret variables without mutating the input', () => {
        const c = reportContext();
        const input = { credentials: { apiToken: { nested: 'mock-private' } }, variables: [{ key: 'CUSTOM', value: 'mock-custom', secret: true }, { name: 'OTHER', text: 'mock-binding', type: 'secret_text' }], status: 'failed', count: 2 };
        c.input = input;
        const before = JSON.stringify(input);
        const report = vm.runInContext('buildDebugReport("test", "details", input)', c);
        expect(report).not.toMatch(/mock-private|mock-custom|mock-binding/);
        expect(report).toContain('failed');
        expect(report).toContain('2');
        expect(JSON.stringify(input)).toBe(before);
    });
    it('handles circular context and does not discard repeated non-circular values', () => {
        const c = reportContext();
        const shared = { status: 'retry' };
        const input: any = { first: shared, second: shared };
        input.self = input;
        c.input = input;
        const report = vm.runInContext('buildDebugReport("test", "details", input)', c);
        expect(report).toContain('[Circular]');
        expect(report.match(/retry/g)).toHaveLength(2);
    });
    it('redacts assignment, bearer and query values including short credentials', () => {
        const c = reportContext();
        c.input = 'token=xy&next=ok password=ab Authorization: Bearer abc https://mock.invalid/?key=cd&mode=test';
        const result = vm.runInContext('redactForReport(input)', c);
        expect(result).not.toMatch(/xy|=ab|Bearer abc|=cd/);
        expect(result).toContain('next=ok');
        expect(result).toContain('mode=test');
    });
    it('redacts recent JSON logs, title and detail while keeping useful error context', () => {
        const c = reportContext();
        c.recentWbLogs.push('{"token":"mock-log-secret","status":503}');
        const report = vm.runInContext('buildDebugReport("password=xx", "secret=yy", {})', c);
        expect(report).not.toMatch(/mock-log-secret|=xx|=yy/);
        expect(report).toContain('503');
    });
});
