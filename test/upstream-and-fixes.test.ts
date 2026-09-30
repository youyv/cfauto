import { describe, it, expect } from 'vitest';
import { normalizeUpstream, readUpstream, upstreamIdentity } from '../src/lib/upstream';
import { fetchGithubCode, fetchGithubCommits, resolveGithubTarget } from '../src/lib/github';
import { finalizeDeploy, fetchGithubVersion, coreDeployLogic, rotateUUIDAndDeploy, resolveAccountVariables } from '../src/lib/auto-update';
import { handleCronJob } from '../src/cron';
import { handleDeleteWorker } from '../src/routes/zones';
import { getRoute } from '../src/routes/register';
import { backupKeys, isRestorableKey } from '../src/routes/crud-backup';
import { KV_KEYS } from '../src/config/templates';
import { mockKV, mockEnv, readKV, jsonReq, stubFetch, cfOk, cfErr, scriptEndpoint } from './helpers';

const aid = 'a'.repeat(32);
const account = { accountId: aid, alias: 'a', globalKey: 'key', email: 'a@b.com', workers_cmliu: ['w1'] };
const commit = { sha: 'same-sha', commit: { message: 'test', committer: { date: '2026-09-30T00:00:00Z' } } };
const github = { match: 'api.github.com', respond: () => new Response(JSON.stringify([commit])) };

describe('upstream selection', () => {
    it.each(['../secret', '/worker.js', 'https://evil.test/a.js', 'src//a.js', 'src/%2e%2e/a.js', 'a.js?x', 'a\\b.js'])('reject unsafe path %s', path => {
        expect(() => normalizeUpstream({ path, branch: 'main' })).toThrow();
    });
    it('supports nested files and branch names', () => {
        expect(normalizeUpstream({ path: ' src/worker.js ', branch: 'release/v2' })).toEqual({ path: 'src/worker.js', branch: 'release/v2' });
    });
    it('save, backup, reset: preserve deployment evidence and isolate templates', async () => {
        const kv = mockKV({ [KV_KEYS.deployConfig('cmliu')]: { mode: 'fixed', currentSha: 'old' } });
        const env = mockEnv(kv);
        const post = getRoute('POST', '/api/upstream')!;
        const url = 'https://panel.test/api/upstream?type=cmliu';
        expect((await post(jsonReq('POST', url, { path: 'src/a.js', branch: 'main' }), env)).status).toBe(200);
        expect(await readUpstream(env, 'cmliu')).toEqual({ path: 'src/a.js', branch: 'main' });
        expect(await readUpstream(env, 'joey')).toEqual({ path: '', branch: '' });
        expect(readKV(kv, KV_KEYS.deployConfig('cmliu'))).toEqual({ mode: 'fixed', currentSha: 'old' });
        expect(backupKeys()).toContain(KV_KEYS.upstream('cmliu'));
        expect(isRestorableKey('UPSTREAM_cmliu')).toBe(true);
        expect(isRestorableKey('UPSTREAM_evil')).toBe(false);
        await post(jsonReq('POST', url, { path: '', branch: '' }), env);
        expect(await upstreamIdentity(env, 'cmliu')).toBe('');
        expect((await post(jsonReq('POST', url, { path: '../x', branch: 'main' }), env)).status).toBe(400);
        expect((await post(jsonReq('POST', 'https://panel.test/api/upstream?type=ech', { path: '', branch: '' }), env)).status).toBe(400);
    });
    it('custom file overrides discovery cache and is shared by code/history', async () => {
        const kv = mockKV({ [KV_KEYS.upstream('cmliu')]: { path: 'src/custom file.js', branch: 'release/v2' }, [KV_KEYS.ghInfoCache('cmliu')]: { path: 'old.js', branch: 'old' } });
        const env = mockEnv(kv);
        const stub = stubFetch([{ match: 'raw.githubusercontent.com', respond: () => new Response('export default {};') }, github]);
        try {
            expect((await resolveGithubTarget(env, 'cmliu')).path).toBe('src/custom file.js');
            await fetchGithubCode('cmliu', 'fixed-sha', env);
            await fetchGithubCommits('cmliu', env);
            expect(stub.calls.some(c => c.url.includes('/fixed-sha/src/custom%20file.js'))).toBe(true);
            const history = stub.calls.find(c => c.url.includes('/commits?'))!;
            expect(new URL(history.url).searchParams.get('path')).toBe('src/custom file.js');
            expect(new URL(history.url).searchParams.get('sha')).toBe('release/v2');
        } finally { stub.restore(); }
    });
    it('404 never falls back to a different file', async () => {
        const env = mockEnv(mockKV({ [KV_KEYS.upstream('joey')]: { path: 'missing.js', branch: 'main' } }));
        const stub = stubFetch([{ match: 'raw.githubusercontent.com', respond: () => new Response('missing', { status: 404 }) }]);
        try { await expect(fetchGithubCode('joey', null, env)).rejects.toThrow('404'); expect(stub.calls.every(c => c.url.includes('/missing.js'))).toBe(true); }
        finally { stub.restore(); }
    });
    it('malformed restored config fails closed', async () => {
        const env = mockEnv(mockKV({ [KV_KEYS.upstream('cmliu')]: '{bad' }));
        await expect(resolveGithubTarget(env, 'cmliu')).rejects.toThrow();
    });
    it('same SHA from a changed source is not treated as already deployed', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [account], [KV_KEYS.upstream('cmliu')]: { path: 'new.js', branch: 'main' }, [KV_KEYS.deployConfig('cmliu')]: { mode: 'latest', currentSha: 'same-sha', commitDate: '2026-09-30' } });
        const env = mockEnv(kv); const stub = stubFetch([github]);
        try {
            expect((await fetchGithubVersion(env, 'cmliu')).localSha).toBeNull();
            await finalizeDeploy(env, 'cmliu', true, 'same-sha', [{ name: 'w', success: true, msg: '' }], '', 'full', await upstreamIdentity(env, 'cmliu'));
            expect((await fetchGithubVersion(env, 'cmliu')).localSha).toBe('same-sha');
        } finally { stub.restore(); }
    });
});

describe('audit fixes', () => {
    it.each([['latest', false], ['fixed', true]] as const)('subset deployment preserves global %s mode', async (mode, latest) => {
        const kv = mockKV({ [KV_KEYS.deployConfig('cmliu')]: { mode, currentSha: 'old' } });
        await finalizeDeploy(mockEnv(kv), 'cmliu', latest, 'new', [{ name: 'w', success: true, msg: '', targetKey: 'a::w' }], '', 'partial');
        expect(readKV(kv, KV_KEYS.deployConfig('cmliu')).mode).toBe(mode);
    });
    it('saving user configuration preserves server GC state', async () => {
        const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, lastCheck: 42, lastGc: 123 } });
        await getRoute('POST', '/api/auto_config')!(jsonReq('POST', 'https://panel.test/api/auto_config', { enabled: true, interval: 30, lastGc: 999 }), mockEnv(kv));
        expect(readKV(kv, KV_KEYS.GLOBAL_CONFIG).lastGc).toBe(123);
    });
    it('stats failure still checks updates and persists lastCheck', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ ...account, globalKey: '' }], [KV_KEYS.GLOBAL_CONFIG]: { enabled: true, interval: 30, lastCheck: 1, lastGc: Date.now(), autoJoey: false, autoEch: false }, [KV_KEYS.ghInfoCache('cmliu')]: { path: 'worker.js', branch: 'main' } });
        const stub = stubFetch([github, { match: 'raw.githubusercontent.com', respond: () => new Response('code') }, { match: 'api.cloudflare.com', respond: () => cfErr(403, 'denied') }]);
        try { await handleCronJob(mockEnv(kv)); expect(readKV(kv, KV_KEYS.GLOBAL_CONFIG).lastCheck).toBeGreaterThan(1); expect(stub.calls.some(c => c.url.includes('/commits?'))).toBe(true); }
        finally { stub.restore(); }
    });
    it('legacy full override cannot shadow new global variables; new rotations store UUID only', async () => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [account], [KV_KEYS.vars('cmliu')]: [{ key: 'UUID', value: 'old' }, { key: 'PROXYIP', value: 'new-proxy' }], [KV_KEYS.accountVars('cmliu', aid)]: [{ key: 'UUID', value: 'private' }, { key: 'PROXYIP', value: 'stale-proxy' }], [KV_KEYS.ghInfoCache('cmliu')]: { path: 'worker.js', branch: 'main' } });
        const stub = stubFetch([github, { match: 'raw.githubusercontent.com', respond: () => new Response('code') }, { match: '/bindings', respond: () => cfOk([]) }, scriptEndpoint('w1', 'code')]);
        try {
            const resolved = await resolveAccountVariables(mockEnv(kv), 'cmliu', [account], [{ key: 'PROXYIP', value: 'new-proxy' }], 'apply');
            expect(resolved.get(aid)).toContainEqual({ key: 'PROXYIP', value: 'new-proxy' });
            expect(resolved.get(aid)).not.toContainEqual({ key: 'PROXYIP', value: 'stale-proxy' });
            await coreDeployLogic(mockEnv(kv), { type: 'cmliu', variables: [{ key: 'PROXYIP', value: 'new-proxy' }], customCode: 'code' });
            // Rotation persists the minimal account-scoped patch regardless of network outcome.
            await rotateUUIDAndDeploy(mockEnv(kv), 'cmliu', [aid]);
            const overrides = readKV(kv, KV_KEYS.accountVars('cmliu', aid));
            expect(overrides.map((v: any) => v.key)).toEqual(['UUID']);
            expect(overrides[0].value).not.toBe('private');
        } finally { stub.restore(); }
    });
    it.each([true, false])('preserves namespaces when shared=%s or inspection fails', async shared => {
        const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [account] });
        const stub = stubFetch([
            { match: '/workers/scripts/w1/bindings', respond: () => cfOk([{ type: 'kv_namespace', namespace_id: 'shared' }]) },
            { match: '/workers/scripts/w2/bindings', respond: () => shared ? cfOk([{ type: 'kv_namespace', namespace_id: 'shared' }]) : cfErr(403, 'denied') },
            { match: '/workers/scripts/w1', respond: () => cfOk(null) },
            { match: '/workers/scripts', respond: () => cfOk([{ id: 'w2' }]) }
        ]);
        try { const body: any = await (await handleDeleteWorker(mockEnv(kv), aid, 'w1', true)).json(); expect(body.success).toBe(true); expect(body.kvWarnings).toContain('保留'); expect(stub.calls.some(c => c.method === 'DELETE' && c.url.includes('/storage/kv/'))).toBe(false); }
        finally { stub.restore(); }
    });
});
