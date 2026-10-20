import { describe, it, expect } from 'vitest';
import { getRoute } from '../src/routes/register';
import { KV_KEYS } from '../src/config/templates';
import { encryptKey, decryptKey } from '../src/lib/crypto-utils';
import { mockEnv, mockKV, jsonReq, readKV } from './helpers';
import type { AppEnv } from '../src/config/env';

const vars = [{ key: 'UUID', value: 'test-only-value', secret: true }];
async function call(path: string, env: AppEnv, body?: unknown, raw?: string) {
    const method = body === undefined && raw === undefined ? 'GET' : 'POST';
    const handler = getRoute(method, path.split('?')[0]);
    expect(handler, path).toBeTypeOf('function');
    const req = raw === undefined ? jsonReq(method, 'https://test' + path, body) : new Request('https://test' + path, { method, body: raw });
    return handler!(req, env);
}
describe('backup preflight and recovery safety', () => {
    it('exports version metadata and roundtrips a legacy backup without deleting null/missing keys', async () => {
        const kv = mockKV({ VARS_cmliu: vars, VARS_joey: vars });
        const env = mockEnv(kv);
        const exported: any = await (await call('/api/backup', env)).json();
        expect(exported._schemaVersion).toBe(1);
        expect(exported._sourceVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(Number.isFinite(Date.parse(exported._time))).toBe(true);
        const r: any = await (await call('/api/restore', env, { VARS_cmliu: [], VARS_joey: null })).json();
        expect(r.success).toBe(true);
        expect(r.restored).toBe(1);
        expect(readKV(kv, 'VARS_joey')).toEqual(vars);
        const snapshot: any = await (await call('/api/restore/snapshot?id=' + r.snapshotId, env)).json();
        expect(snapshot.put).toEqual([{ key: 'VARS_cmliu', value: JSON.stringify(vars) }]);
        expect(snapshot.delete).toEqual([]);
    });
    it('preview is read-only, describes add/overwrite/skip and never returns variable or credential values', async () => {
        const kv = mockKV({ VARS_cmliu: [] });
        const r: any = await (await call('/api/restore/preview', mockEnv(kv), { VARS_cmliu: vars, VARS_joey: vars, UPSTREAM_cmliu: null })).json();
        expect(r.success).toBe(true);
        expect(r.preview.counts).toMatchObject({ add: 1, overwrite: 1, skip: 1 });
        expect(JSON.stringify(r)).not.toContain('test-only-value');
        expect(kv._puts).toBe(0);
    });
    it.each([
        ['future schema', { _schemaVersion: 999, VARS_cmliu: [] }],
        ['invalid metadata', { _schemaVersion: 1, _sourceVersion: 42, _time: 'bad', VARS_cmliu: [] }],
        ['unknown key', { VARS_cmliu: [], SESSION_forged: 'sensitive-test-payload' }],
        ['prefix injection', { VARS_cmliu: [], VARS_cmliuX: [] }],
        ['inherited template name', { VARS_constructor_ACC_abc: [] }],
        ['variables object', { VARS_cmliu: {} }],
        ['coerced variable', { VARS_cmliu: [{ key: 'UUID', value: {} }] }],
        ['invalid secret', { VARS_cmliu: [{ key: 'UUID', value: 'x', secret: 'yes' }] }],
        ['duplicate variable', { VARS_cmliu: [...vars, ...vars] }],
        ['bad account', { [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: 'bad' }] }],
        ['bad account secret', { [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: 'a'.repeat(32), globalKey: {} }] }],
        ['bad config flag', { [KV_KEYS.GLOBAL_CONFIG]: { enabled: 'yes' } }],
        ['bad config time', { [KV_KEYS.GLOBAL_CONFIG]: { lastCheck: -1 } }],
        ['bad upstream', { UPSTREAM_cmliu: { path: '../evil.js', branch: 'main' } }],
        ['bad deployment', { DEPLOY_CONFIG_cmliu: { mode: 'other' } }],
        ['bad favorite', { FAVORITES_cmliu: [{ sha: 4 }] }],
        ['bad journal', { DEPLOY_JOURNAL: [{ time: 'bad' }] }],
        ['prototype injection', JSON.parse('{"__proto__":{},"VARS_cmliu":[]}')],
    ])('rejects %s before any write', async (_name, data) => {
        const kv = mockKV({ VARS_joey: vars });
        const res = await call('/api/restore', mockEnv(kv), data);
        expect(res.status).toBe(400);
        expect((await res.json() as any).success).toBe(false);
        expect(kv._puts).toBe(0);
        expect(kv._deletes).toEqual([]);
    });
    it('invalid JSON and a chunked body above 5 MiB cause no writes', async () => {
        const kv = mockKV(); const env = mockEnv(kv);
        expect((await call('/api/restore', env, undefined, '{oops')).status).toBe(400);
        expect((await call('/api/restore', env, undefined, ' '.repeat(5 * 1024 * 1024 + 1))).status).toBe(413);
        expect(kv._puts).toBe(0);
    });
    it('wrong key and damaged versioned ciphertext block before writes, without a fingerprint too', async () => {
        const source = mockEnv(mockKV(), { ENCRYPTION_SECRET: 'test-only-source' });
        const cipher = await encryptKey(source, 'test-only-sensitive');
        for (const value of [cipher, 'v1:broken', 'v2:unknown']) {
            const kv = mockKV();
            const r = await call('/api/restore', mockEnv(kv), { [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: 'a'.repeat(32), globalKey: value }] });
            expect(r.status).toBe(400);
            expect(await r.text()).not.toContain(value);
            expect(kv._puts).toBe(0);
        }
    });
    it('accepts same-key ciphertext and encrypts historical plaintext before writing', async () => {
        for (const encrypted of [false, true]) {
            const kv = mockKV(); const env = mockEnv(kv);
            const value = encrypted ? await encryptKey(env, 'test-only-legacy') : 'test-only-legacy';
            const r: any = await (await call('/api/restore', env, { [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: 'a'.repeat(32), globalKey: value }] })).json();
            expect(r.success).toBe(true);
            const saved = readKV<any[]>(kv, KV_KEYS.ACCOUNTS)![0].globalKey;
            expect(saved).toMatch(/^v1:/);
            expect(await decryptKey(env, saved)).toBe('test-only-legacy');
        }
    });
    it('snapshot failure prevents all configuration writes', async () => {
        const kv = mockKV();
        kv.put = async () => { throw Error('test-only-private-error'); };
        const res = await call('/api/restore', mockEnv(kv), { VARS_cmliu: vars });
        expect(res.status).toBe(503);
        expect(await res.text()).not.toContain('test-only-private-error');
        expect(kv._store.size).toBe(0);
    });
    it('stops on ambiguous write failure; reports written/unknown/notAttempted and retains exact raw snapshot', async () => {
        const kv = mockKV({ VARS_cmliu: 'corrupt-old-raw' }); const env = mockEnv(kv);
        const put = kv.put.bind(kv);
        kv.put = async (k, v, opts) => { await put(k, v, opts); if (k === 'VARS_joey') throw Error('response lost'); };
        const res = await call('/api/restore', env, { VARS_cmliu: [], VARS_joey: [], VARS_ech: [] });
        expect(res.status).toBe(207);
        const r: any = await res.json();
        expect(r.success).toBe(false);
        expect(r.restored).toBe(1);
        expect(r.results.map((x: any) => x.status)).toEqual(['written', 'unknown', 'notAttempted']);
        expect(readKV(kv, 'VARS_ech')).toBeNull();
        const s: any = await (await call('/api/restore/snapshot?id=' + r.snapshotId, env)).json();
        expect(s.put).toEqual([{ key: 'VARS_cmliu', value: 'corrupt-old-raw' }]);
        expect(s.delete).toEqual(['VARS_joey', 'VARS_ech']);
        expect(kv._store.get('RESTORE_SNAPSHOT_' + r.snapshotId)?.ttl).toBe(7 * 86400);
    });
    it('snapshot download rejects arbitrary keys and expired snapshots', async () => {
        const env = mockEnv(mockKV());
        expect((await call('/api/restore/snapshot?id=ACCOUNTS_UNIFIED_STORAGE', env)).status).toBe(400);
        expect((await call('/api/restore/snapshot?id=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', env)).status).toBe(404);
    });
    it('backup enumeration failure is explicit instead of silently producing an incomplete file', async () => {
        const kv = mockKV(); kv.list = async () => { throw Error('private-test-error'); };
        const r: any = await (await call('/api/backup', mockEnv(kv))).json();
        expect(r._warning).toBeTruthy();
        expect(JSON.stringify(r)).not.toContain('private-test-error');
    });
    it('roundtrips all configuration kinds, account overrides and historical unknown SHA', async () => {
        const aid = 'a'.repeat(32), fullSha = 'a'.repeat(40), date = '2026-10-01T00:00:00Z';
        const data = {
            VARS_cmliu: vars, [KV_KEYS.accountVars('cmliu', aid)]: vars,
            AUTO_UPDATE_CFG_GLOBAL: { enabled: true, interval: '30', lastCheck: 1, lastGc: 2, autoCmliu: true },
            UPSTREAM_cmliu: { path: 'src/worker.js', branch: 'main' },
            DEPLOY_CONFIG_cmliu: { mode: 'fixed', currentSha: fullSha, deployTime: date, pendingTargets: [aid + '::test-worker'], pendingSha: fullSha },
            DEPLOY_CONFIG_joey: { mode: 'latest', currentSha: 'unknown' },
            FAVORITES_cmliu: [{ sha: fullSha, alias: 'test', date }],
            DEPLOY_JOURNAL: [{ time: date, type: 'cmliu', sha: fullSha, accounts: 1, total: 1, summary: 'test-worker: OK', customSha: 'f'.repeat(64) }]
        };
        const source = mockEnv(mockKV(data));
        const exported = await (await call('/api/backup', source)).json();
        const target = mockKV();
        const r: any = await (await call('/api/restore', mockEnv(target), exported)).json();
        expect(r.success).toBe(true);
        for (const [key, value] of Object.entries(data)) expect(readKV(target, key)).toEqual(value);
    });
    it('fails a 401-key request before any KV read/write budget is spent', async () => {
        const kv = mockKV();
        const data = Object.fromEntries(Array.from({ length: 401 }, (_, i) => ['VARS_cmliu_ACC_' + i, []]));
        expect((await call('/api/restore', mockEnv(kv), data)).status).toBe(413);
        expect(kv._puts).toBe(0); expect(kv._gets).toBe(0);
    });
    it('fails before writes when the old-value snapshot is too large', async () => {
        const kv = mockKV({ VARS_cmliu: 'x'.repeat(10 * 1024 * 1024 + 1) });
        expect((await call('/api/restore', mockEnv(kv), { VARS_cmliu: [] })).status).toBe(413);
        expect(kv._puts).toBe(0);
    });
    it('executes a fresh preflight, not a previously accepted preview', async () => {
        const kv = mockKV(); const env = mockEnv(kv);
        expect((await call('/api/restore/preview', env, { VARS_cmliu: [] })).status).toBe(200);
        expect((await call('/api/restore', env, { VARS_cmliu: {} })).status).toBe(400);
        expect(kv._puts).toBe(0);
    });
    it('bounds a declared oversized body before reading it', async () => {
        const kv = mockKV(); const env = mockEnv(kv);
        const req = new Request('https://test/api/restore', { method: 'POST', body: '{}', headers: { 'Content-Length': '999999999' } });
        expect((await getRoute('POST', '/api/restore')!(req, env)).status).toBe(413);
        expect(kv._puts).toBe(0);
    });
    it('rejects masked and ambiguous unprefixed old ciphertext before writes', async () => {
        const env = mockEnv(mockKV(), { ENCRYPTION_SECRET: 'wrong-test-key' });
        const cipher = (await encryptKey(mockEnv(mockKV()), 'x'.repeat(40))).slice(3);
        for (const globalKey of ['***', '123456...cdef', cipher]) {
            expect((await call('/api/restore', env, { [KV_KEYS.ACCOUNTS]: [{ alias: 'a', accountId: 'a'.repeat(32), globalKey }] })).status).toBe(400);
        }
    });
    it('reuses a client-known snapshot ID for retrieval, but refuses overwriting a visible snapshot', async () => {
        const kv = mockKV(); const env = mockEnv(kv), id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
        const request = () => new Request('https://test/api/restore', { method: 'POST', body: JSON.stringify({ VARS_cmliu: [] }), headers: { 'X-Restore-Snapshot-ID': id } });
        const r: any = await (await getRoute('POST', '/api/restore')!(request(), env)).json();
        expect(r.snapshotId).toBe(id);
        const before = kv._puts;
        expect((await getRoute('POST', '/api/restore')!(request(), env)).status).toBe(409);
        expect(kv._puts).toBe(before);
    });

});
