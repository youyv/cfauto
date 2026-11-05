import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRoute } from '../src/routes/register';
import { mockEnv, mockKV, jsonReq } from './helpers';
import { KV_KEYS } from '../src/config/templates';
const sha = 'a'.repeat(40);
afterEach(() => vi.unstubAllGlobals());
async function validate(body: unknown = { path: 'src/worker.js', branch: 'feature/test' }) {
    const kv = mockKV({ [KV_KEYS.upstream('cmliu')]: { path: 'saved.js', branch: 'main' }, [KV_KEYS.ghInfoCache('cmliu')]: { path: 'cached.js', branch: 'main' } });
    const before = [...kv._store];
    const handler = getRoute('POST', '/api/upstream/validate');
    expect(handler).toBeDefined();
    const res = await handler!(jsonReq('POST', 'https://panel.test/api/upstream/validate?type=cmliu', body), mockEnv(kv, { GITHUB_TOKEN: 'fake-private-token' }));
    expect([...kv._store]).toEqual(before);
    expect(kv._puts).toBe(0); expect(kv._deletes).toEqual([]);
    const data = await res.json() as any;
    expect(JSON.stringify(data)).not.toContain('fake-private-token');
    return { res, data };
}
describe('read-only upstream draft validation', () => {
    it('pins the resolved commit when checking the file, without touching configuration/cache', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ sha })).mockResolvedValueOnce(Response.json({ type: 'file', path: 'src/worker.js' }));
        vi.stubGlobal('fetch', fetcher);
        const { res, data } = await validate();
        expect(res.status).toBe(200); expect(data.sha).toBe(sha);
        expect(data.path).toBe('src/worker.js'); expect(data.branch).toBe('feature/test');
        expect(fetcher.mock.calls[0][0]).toContain('/commits/feature%2Ftest');
        expect(fetcher.mock.calls[1][0]).toContain('ref=' + sha);
        expect(fetcher.mock.calls.every(c => c[0].startsWith('https://api.github.com/repos/'))).toBe(true);
    });
    it.each([['../secret','main'], ['https://evil.test/a','main'], ['a.js','../x'], ['', '']])('rejects invalid draft %s / %s before network access', async (path, branch) => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        expect((await validate({ path, branch })).res.status).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each([[404, 'UPSTREAM_REF_NOT_FOUND'], [429, 'UPSTREAM_RATE_LIMIT'], [403, 'UPSTREAM_FORBIDDEN'], [500, 'UPSTREAM_UNAVAILABLE']])('reports ref HTTP %s safely', async (status, code) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret body fake-private-token', { status })));
        expect((await validate()).data.code).toBe(code);
    });
    it('distinguishes a missing file and a directory from a missing ref', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ sha })).mockResolvedValueOnce(new Response('', { status: 404 })));
        expect((await validate()).data.code).toBe('UPSTREAM_FILE_NOT_FOUND');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ sha })).mockResolvedValueOnce(Response.json({ type: 'dir' })));
        expect((await validate()).data.code).toBe('UPSTREAM_NOT_FILE');
    });
    it('reports network/timeout errors without echoing upstream details or tokens', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('fake-private-token', 'AbortError')));
        expect((await validate()).res.status).toBe(504);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fake-private-token')));
        expect((await validate()).res.status).toBe(502);
    });
});
