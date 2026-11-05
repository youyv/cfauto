import { describe, it, expect } from 'vitest';
import { handleDeleteWorker } from '../src/routes/zones';
import { mockKV, mockEnv, stubFetch, cfOk, cfErr, readKV } from './helpers';
import { KV_KEYS } from '../src/config/templates';
const aid = 'a'.repeat(32);
function setup() { return mockKV({ [KV_KEYS.ACCOUNTS]: [{ accountId: aid, alias: 'test', apiToken: 'credential', workers_cmliu: ['one'] }] }); }
describe('deletion outcomes', () => {
    it('HTTP 200 Worker rejection preserves local inventory and never deletes KV', async () => {
        const kv = setup();
        const before = readKV(kv, KV_KEYS.ACCOUNTS);
        const fetcher = stubFetch([
            { match: '/bindings', respond: () => cfOk([{ name: 'KV', type: 'kv_namespace', namespace_id: 'namespace-one' }]) },
            { match: '/workers/scripts/one', method: 'DELETE', respond: () => cfErr(200, 'rejected') }
        ]);
        try {
            const body: any = await (await handleDeleteWorker(mockEnv(kv), aid, 'one', true)).json();
            expect(body.success).toBe(false);
            expect(readKV(kv, KV_KEYS.ACCOUNTS)).toEqual(before);
            expect(fetcher.calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
        } finally { fetcher.restore(); }
    });
    it.each([403, 200])('keeps per-namespace failure results when KV deletion is rejected (%s)', async status => {
        const fetcher = stubFetch([
            { match: '/bindings', respond: () => cfOk([{ name: 'KV', type: 'kv_namespace', namespace_id: 'namespace-one' }]) },
            { match: '/workers/scripts/one', method: 'DELETE', respond: () => cfOk({}) },
            { match: '/workers/scripts', method: 'GET', respond: () => cfOk([]) },
            { match: '/storage/kv/namespaces/namespace-one', method: 'DELETE', respond: () => cfErr(status, 'denied') }
        ]);
        try {
            const response = await handleDeleteWorker(mockEnv(setup()), aid, 'one', true);
            const body = await response.json() as any;
            expect(body.success).toBe(true);
            expect(body.results).toContainEqual({ resource: 'KV namespace-one', status: 'failed' });
            expect(body.kvWarnings).toContain('1 个 KV');
        } finally { fetcher.restore(); }
    });
    it('reports acknowledged deletion rather than a total failure when configuration writes fail', async () => {
        const kv = setup();
        kv.put = async () => { throw new Error('token="private"'); };
        const fetcher = stubFetch([{ match: '/workers/scripts/one', method: 'DELETE', respond: () => cfOk({}) }]);
        try {
            const response = await handleDeleteWorker(mockEnv(kv), aid, 'one', false);
            const body = await response.json() as any;
            expect(body.success).toBe(true);
            expect(body.partial).toBe(true);
            expect(body.results).toEqual(expect.arrayContaining([
                expect.objectContaining({ resource: 'one', status: 'deleted' }),
                expect.objectContaining({ status: 'unknown' })
            ]));
            expect(body.kvWarnings).toContain('不要盲目重试');
            expect(JSON.stringify(body)).not.toContain('private');
            expect(fetcher.calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
        } finally { fetcher.restore(); }
    });
    it('reports default KV preservation and per-template cleanup on success', async () => {
        const fetcher = stubFetch([{ match: '/workers/scripts/one', method: 'DELETE', respond: () => cfOk({}) }]);
        try {
            const response = await handleDeleteWorker(mockEnv(setup()), aid, 'one', false);
            const body = await response.json() as any;
            expect(body.results).toEqual(expect.arrayContaining([
                expect.objectContaining({ resource: 'KV 命名空间', status: 'retained' }),
                expect.objectContaining({ resource: 'cmliu 部署配置/变量/收藏', status: 'reset' })
            ]));
        } finally { fetcher.restore(); }
    });
});
