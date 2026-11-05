import { describe, it, expect } from 'vitest';
import { getRoute } from '../src/routes/register';
import { KV_KEYS } from '../src/config/templates';
import { mockKV, mockEnv, jsonReq, stubFetch, cfOk, cfErr } from './helpers';
const aid = 'a'.repeat(32);
const draft = { template: 'cmliu', workerName: 'new-worker', targetAccounts: ['target'], enableKV: true, kvName: 'store', config: { ADMIN: 'private-admin' }, savedVars: [{ key: 'TOKEN', value: 'private-token', secret: true }] };
function preview(kv: ReturnType<typeof mockKV>, batch: unknown = draft) {
    return getRoute('POST', '/api/deploy/preview')!(jsonReq('POST', 'https://test/api/deploy/preview?type=cmliu', { batch }), mockEnv(kv));
}
function data() { return mockKV({ [KV_KEYS.ACCOUNTS]: [{ accountId: aid, alias: 'target', apiToken: 'credential', workers_cmliu: [] }] }); }
const source = [
    { match: 'raw.githubusercontent.com', respond: () => new Response('candidate-code') },
    { match: 'api.github.com', respond: () => new Response('[]') }
];
describe('batch creation read-only preview', () => {
    it.each([true, false])('describes existing=%s bindings using actual batch replacement semantics', async exists => {
        const kv = data(); const before = JSON.stringify([...kv._store]);
        const stub = stubFetch([
            ...source,
            { match: /\/workers\/scripts$/, respond: () => cfOk(exists ? [{ id: 'new-worker' }] : []) },
            { match: '/bindings', respond: () => cfOk([{ name: 'OLD', type: 'secret_text' }, { name: 'KV', type: 'kv_namespace', namespace_id: 'private-id' }]) },
            { match: '/namespaces', respond: () => cfOk(exists ? [{ title: 'store', id: 'private-id' }] : []) },
            { match: '/workers/scripts/new-worker', respond: () => new Response('candidate-code', { headers: { 'Content-Type': 'application/javascript' } }) }
        ]);
        try {
            const response = await preview(kv); const text = await response.text(); const body = JSON.parse(text);
            expect(response.status).toBe(200);
            expect(body.targets[0]).toMatchObject({ status: 'read', workerAction: exists ? 'replace' : 'create', kvAction: exists ? 'reuse' : 'create' });
            expect(body.targets[0].bindings).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'TOKEN', action: 'added' })]));
            if (exists) expect(body.targets[0].bindings).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'OLD', action: 'removed' }), expect.objectContaining({ name: 'KV', action: 'unchanged' })]));
            for (const secret of ['private-admin', 'private-token', 'private-id', 'credential', 'candidate-code']) expect(text).not.toContain(secret);
            expect(stub.calls.every(c => c.method === 'GET')).toBe(true);
            expect(JSON.stringify([...kv._store])).toBe(before);
            expect(kv._puts).toBe(0); expect(kv._deletes).toEqual([]);
        } finally { stub.restore(); }
    });
    it('keeps failed inventory unknown instead of claiming a new Worker', async () => {
        const stub = stubFetch([...source, { match: '/workers/scripts', respond: () => cfErr(403, 'denied') }]);
        try { const body = await (await preview(data())).json() as any; expect(body.targets[0].status).toBe('unknown'); expect(body.targets[0].workerAction).toBeUndefined(); }
        finally { stub.restore(); }
    });
    it('does not claim absence from a full first namespace page', async () => {
        const stub = stubFetch([...source,
            { match: '/workers/scripts', respond: () => cfOk([]) },
            { match: '/namespaces', respond: () => cfOk(Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: 'other-' + i }))) }
        ]);
        try { const body = await (await preview(data())).json() as any; expect(body.targets[0].status).toBe('unknown'); expect(body.targets[0].reason).toContain('首批清单已满'); }
        finally { stub.restore(); }
    });
    it.each([{ ...draft, workerName: 'bad/name' }, { ...draft, config: { TOKEN: {} } }, { ...draft, targetAccounts: [null] }])('rejects malformed batch drafts before reads', async invalid => {
        const stub = stubFetch([]); const kv = data();
        try { expect((await preview(kv, invalid)).status).toBe(400); expect(stub.calls).toEqual([]); expect(kv._puts).toBe(0); }
        finally { stub.restore(); }
    });
});
