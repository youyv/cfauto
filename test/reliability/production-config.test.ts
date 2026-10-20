import { describe, expect, it } from 'vitest';
import { productionConfig } from '../../src/reliability/production-config';
import { canonical } from '../../src/reliability/protocol';
import { protect } from '../../src/reliability/business-command';
import { productionEnv, manager } from './production-fixture';

describe('production Secret isolation and self protection', () => {
    it('preserves old key IDs, independent snapshot keys and explicit legacy secret', () => {
        const env = { ...productionEnv(), RELIABILITY_LEGACY_SECRET: 'old-login-derived-material' }, original = structuredClone(env);
        const config = productionConfig(env);
        expect(Object.keys(config.credentials.keys).sort()).toEqual(['credential_new','credential_old']);
        expect(Object.keys(config.snapshots.keys).sort()).toEqual(['snapshot_new','snapshot_old']);
        expect(config.credentials.legacySecret).toBe(env.RELIABILITY_LEGACY_SECRET);
        expect(config.snapshots).not.toHaveProperty('legacySecret'); expect(env).toEqual(original);
    });
    it('has no ACCESS_CODE or ENCRYPTION_SECRET fallback', () => {
        const env = productionEnv(); delete (env as any).RELIABILITY_RPC_SECRET;
        expect(() => productionConfig({ ...env, ACCESS_CODE: '1'.repeat(64), ENCRYPTION_SECRET: '1'.repeat(64) } as any)).toThrow('NOT_READY');
        expect(productionConfig(productionEnv()).credentials).not.toHaveProperty('legacySecret');
    });
    it.each(['RELIABILITY_RPC_SECRET','RELIABILITY_IDEMPOTENCY_SECRET','RELIABILITY_EVIDENCE_SECRET','RELIABILITY_CREDENTIAL_KEYS','RELIABILITY_SNAPSHOT_KEYS','RELIABILITY_MANAGER_ACCOUNT','RELIABILITY_MANAGER_WORKER','RELIABILITY_CONFIG_NAMESPACE'])('rejects absent %s before initialization', key => {
        const env = productionEnv(); delete (env as any)[key]; expect(() => productionConfig(env)).toThrow('NOT_READY');
    });
    it.each(['', 'short', 'a'.repeat(63), 'A'.repeat(64), ' a'.repeat(32)])('rejects invalid key encoding (%#)', value => {
        expect(() => productionConfig({ ...productionEnv(), RELIABILITY_RPC_SECRET: value })).toThrow('NOT_READY');
    });
    it('rejects cross-purpose and old-key reuse', () => {
        const env = productionEnv(); env.RELIABILITY_EVIDENCE_SECRET = env.RELIABILITY_RPC_SECRET;
        expect(() => productionConfig(env)).toThrow('NOT_READY');
        env.RELIABILITY_EVIDENCE_SECRET = '4'.repeat(64); expect(() => productionConfig(env)).toThrow('NOT_READY');
        env.RELIABILITY_EVIDENCE_SECRET = '3'.repeat(64); env.RELIABILITY_LEGACY_SECRET = '7'.repeat(64); expect(() => productionConfig(env)).toThrow('NOT_READY');
    });
    it.each(['{}','not-json', canonical({ currentId:'missing',keys:{ old:'4'.repeat(64) } }), canonical({ currentId:'x',keys:{x:'bad'} }), canonical({ currentId:'x',keys:{x:'4'.repeat(64)},extra:true }), '{"currentId":"x","keys":{"x":"'+'4'.repeat(64)+'","x":"'+'5'.repeat(64)+'"}}'])('rejects malformed or ambiguous ring (%#) without exposing input', raw => {
        try { productionConfig({ ...productionEnv(), RELIABILITY_CREDENTIAL_KEYS: raw }); throw new Error('accepted'); }
        catch (e) { expect((e as Error).message).toBe('NOT_READY'); }
    });
    it('returns detached, deeply frozen settings', () => {
        const env = productionEnv(), config = productionConfig(env);
        env.RELIABILITY_MANAGER_WORKER = 'changed';
        expect(config.protected.workers[0].worker).toBe('manager');
        expect(() => { config.credentials.keys.credential_old = '0'.repeat(64); }).toThrow();
        expect(() => { config.protected.workers.length = 0; }).toThrow();
    });
    it('cannot remove manager Worker, account subdomain or config namespace protection', () => {
        const env = { ...productionEnv(), RELIABILITY_PROTECTED_RESOURCES: canonical({workers:[],namespaces:[]}) };
        const config = productionConfig(env);
        expect(() => protect(config.protected, manager, {kind:'delete_worker',worker:'manager',template:'cmliu'})).toThrow();
        expect(() => protect(config.protected, manager, {kind:'change_subdomain',subdomain:'new-name'})).toThrow();
        expect(() => protect(config.protected, manager, {kind:'delete_kv',namespace:'a'.repeat(32)})).toThrow();
    });
    it('validates additional protected resources', () => {
        const env = productionEnv(); env.RELIABILITY_PROTECTED_RESOURCES = '{"workers":[],"namespaces":[{"account":"oops","namespace":"oops"}]}';
        expect(() => productionConfig(env)).toThrow('NOT_READY');
    });
});
