import { describe, it, expect } from 'vitest';
import { getRoute } from '../src/routes/register';
import { mockEnv, mockKV, jsonReq, stubFetch, cfOk } from './helpers';
import { bindingDifferences } from '../src/lib/deploy-preview';
import { mergeVariableBindings } from '../src/lib/deploy-utils';
import { KV_KEYS } from '../src/config/templates';
describe('read-only deployment differences', () => {
    it('does not report reordered binding object properties as a value change', () => {
        expect(bindingDifferences([{ type: 'plain_text', text: 'same', name: 'VALUE' }], [{ name: 'VALUE', type: 'plain_text', text: 'same' }], new Set(['VALUE']))[0].action).toBe('unchanged');
    });
    it('identifies secret-to-plain conversion as a type change, not a secret write', () => {
        expect(bindingDifferences([{ name: 'VALUE', type: 'secret_text' }], [{ name: 'VALUE', type: 'plain_text', text: 'private' }], new Set(['VALUE']))).toEqual([
            { name: 'VALUE', beforeType: 'secret_text', afterType: 'plain_text', action: 'changed', secret: true }
        ]);
    });
    it('preserves blank and untouched secrets, and reports explicit removals without values', () => {
        const before = [{ name: 'SECRET', type: 'secret_text' }, { name: 'KEEP', type: 'plain_text', text: 'private' }];
        const after = mergeVariableBindings(before, [{ key: 'SECRET', value: '', secret: true }, { key: 'NEW', value: 'private' }], ['KEEP']);
        expect(bindingDifferences(before, after, new Set(['NEW']))).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'SECRET', action: 'unchanged' }),
            expect.objectContaining({ name: 'KEEP', action: 'removed' }),
            expect.objectContaining({ name: 'NEW', action: 'added' })
        ]));
        expect(JSON.stringify(bindingDifferences(before, after, new Set(['NEW'])))).not.toContain('private');
    });
    it('keeps failed targets unknown while showing readable targets and never writes', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'test', accountId: 'a'.repeat(32), apiToken: 'credential', workers_cmliu: ['ok', 'bad'] }] });
        const fetcher = stubFetch([
            { match: '/ok/bindings', respond: () => cfOk([]) },
            { match: '/bad/bindings', respond: () => new Response('unavailable', { status: 503 }) },
            { match: 'raw.githubusercontent.com', respond: () => new Response('candidate-code') },
            { match: 'api.github.com', respond: () => new Response('[]') },
            { match: '/workers/scripts/ok', respond: () => new Response('candidate-code', { headers: { 'Content-Type': 'application/javascript' } }) }
        ]);
        try {
            const response = await getRoute('POST', '/api/deploy/preview')!(jsonReq('POST', 'https://test/api/deploy/preview?type=cmliu', { variables: [] }), mockEnv(kv));
            const data = await response.json() as any;
            expect(data.targets[0]).toMatchObject({ status: 'read', sourceAction: 'unchanged' });
            expect(data.targets[1]).toMatchObject({ status: 'unknown' });
            expect(data.targets[1].bindings).toBeUndefined();
            expect(kv._puts).toBe(0);
            expect(kv._deletes).toEqual([]);
        } finally { fetcher.restore(); }
    });
    it('shows per-target binding changes and override removal without returning values or writing KV', async () => {
        const aid = 'a'.repeat(32);
        const kv = mockKV({
            [KV_KEYS.ACCOUNTS]: [{ alias: 'test', accountId: aid, apiToken: 'credential', workers_cmliu: ['one'] }],
            [KV_KEYS.accountVars('cmliu', aid)]: [{ key: 'UUID', value: 'private-override' }]
        });
        const before = JSON.stringify([...kv._store]);
        const restore = stubFetch([{ match: '/bindings', respond: () => cfOk([
            { name: 'KEEP', type: 'plain_text', text: 'same' },
            { name: 'CHANGE', type: 'plain_text', text: 'old-private' },
            { name: 'SECRET', type: 'secret_text' },
            { name: 'REMOVE', type: 'kv_namespace', namespace_id: 'private-kv' }
        ]) }, { match: 'raw.githubusercontent.com', respond: () => new Response('candidate-code') }, { match: 'api.github.com', respond: () => new Response('[]') }, { match: '/workers/scripts/one', respond: () => new Response('different-code', { headers: { 'Content-Type': 'application/javascript' } }) }]);
        try {
            const route = getRoute('POST', '/api/deploy/preview');
            expect(route).not.toBeNull();
            const response = await route!(jsonReq('POST', 'https://test/api/deploy/preview?type=cmliu', {
                variables: [{ key: 'KEEP', value: 'same' }, { key: 'CHANGE', value: 'new-private' }, { key: 'SECRET', value: 'private-secret', secret: true }], deletedVariables: ['REMOVE']
            }), mockEnv(kv));
            const text = await response.text();
            const body = JSON.parse(text);
            expect(response.status).toBe(200);
            expect(body.targets[0].bindings).toEqual(expect.arrayContaining([
                expect.objectContaining({ name: 'KEEP', action: 'unchanged' }),
                expect.objectContaining({ name: 'CHANGE', action: 'changed' }),
                expect.objectContaining({ name: 'SECRET', action: 'write-secret' }),
                expect.objectContaining({ name: 'REMOVE', action: 'removed' })
            ]));
            expect(body.targets[0].sourceAction).toBe('changed');
            expect(kv._puts).toBe(0);
            expect(kv._deletes).toEqual([]);
            expect(restore.calls.every(call => call.method === 'GET')).toBe(true);
            expect(body.targets[0].clearedOverrides).toEqual(['UUID']);
            for (const secret of ['credential', 'old-private', 'new-private', 'private-secret', 'private-override', 'private-kv']) expect(text).not.toContain(secret);
            expect(JSON.stringify([...kv._store])).toBe(before);
        } finally { restore.restore(); }
    });
    it('rejects malformed drafts before network reads', async () => {
        const route = getRoute('POST', '/api/deploy/preview');
        expect(route).not.toBeNull();
        const response = await route!(jsonReq('POST', 'https://test/api/deploy/preview?type=cmliu', { variables: 'bad' }), mockEnv(mockKV()));
        expect(response.status).toBe(400);
    });
});

describe('custom code preview', () => {
    it('compares submitted code rather than fetching repository code and never returns source', async () => {
        const code = 'export default { fetch() { return new Response("private-source") } }';
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ alias: 'test', accountId: 'a'.repeat(32), apiToken: 'credential', workers_cmliu: ['one'] }] });
        const stub = stubFetch([
            { match: '/bindings', respond: () => cfOk([]) },
            { match: '/workers/scripts/one', respond: () => new Response(code, { headers: { 'Content-Type': 'application/javascript' } }) },
            { match: 'api.github.com', respond: () => new Response('[]') }
        ]);
        try {
            const response = await getRoute('POST', '/api/deploy/preview')!(jsonReq('POST', 'https://test/api/deploy/preview?type=cmliu', { variables: [], targetSha: 'abcdef0123456789', customCode: code }), mockEnv(kv));
            const text = await response.text(); const body = JSON.parse(text);
            expect(body.source.kind).toBe('custom');
            expect(body.source.customCodeHash).toMatch(/^[a-f0-9]{64}$/);
            expect(body.targets[0].sourceAction).toBe('unchanged');
            expect(text).not.toContain('private-source');
            expect(kv._puts).toBe(0);
            expect(kv._deletes).toEqual([]);
            expect(stub.calls.every(c => c.method === 'GET')).toBe(true);
            expect(stub.calls.some(c => c.url.includes('raw.githubusercontent.com'))).toBe(false);
        } finally { stub.restore(); }
    });
    it('rejects non-string custom source', async () => {
        const response = await getRoute('POST', '/api/deploy/preview')!(jsonReq('POST', 'https://test/api/deploy/preview?type=cmliu', { variables: [], customCode: {} }), mockEnv(mockKV()));
        expect(response.status).toBe(400);
    });
});
