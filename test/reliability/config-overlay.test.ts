import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigOverlay, configDomain, configKey } from '../../src/reliability/config-overlay';
import { ConfigStore } from '../../src/reliability/config-store';
import { KV_KEYS, TEMPLATES } from '../../src/config/templates';
import { manifestDigest } from '../../src/reliability/protocol';
import { sqliteFixture } from './sqlite-fixture';
const open: ReturnType<typeof sqliteFixture>[] = [];
async function fixture() {
    const db = sqliteFixture(); open.push(db); const config = new ConfigStore(db.db);
    const records = [{ domain: 'accounts', revision: 1, value: [] }, { domain: 'vars:cmliu', revision: 1, value: [{ name: 'UUID', value: 'old' }] }];
    config.beginImport('gen1', await manifestDigest(records), 2); records.forEach(r => config.stage('gen1', r)); await config.activateInitial('gen1', 0); config.setMaintenance(false, 1);
    const cache = { get: vi.fn(async () => 'stale-kv-data'), put: vi.fn(async () => {}), delete: vi.fn(async () => {}), list: vi.fn(async () => ({ keys: [{ name: 'VARS_old_ACC_removed' }] })) };
    const overlay = new ConfigOverlay(config.readAll(), cache);
    return { ...db, config, cache, overlay, commit: () => config.compareAndSet(overlay.generation, overlay.changes(), overlay.dependencies()) };
}
afterEach(() => { for (const db of open.splice(0)) db.sql.close(); });
describe('authoritative config overlay', () => {
    it('round trips exactly the known business key vocabulary', () => {
        const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG, KV_KEYS.DEPLOY_JOURNAL, ...Object.keys(TEMPLATES).flatMap(t => [KV_KEYS.vars(t), KV_KEYS.deployConfig(t), KV_KEYS.favorites(t), KV_KEYS.upstream(t), KV_KEYS.accountVars(t, 'abc123')])];
        for (const key of keys) expect(configKey(configDomain(key)!)).toBe(key);
        expect(configDomain('VARS_bad')).toBe(null); expect(configDomain('SESSION_x')).toBe(null);
        expect(configKey('vars:cmliu:extra')).toBe(null); expect(configKey('vars:toString')).toBe(null);
    });
    it('never reads or writes legacy business KV, including absent authoritative keys', async () => {
        const { overlay, cache, commit, config } = await fixture();
        expect(await overlay.get(KV_KEYS.ACCOUNTS)).toBe('[]');
        expect(await overlay.get(KV_KEYS.GLOBAL_CONFIG)).toBe(null);
        await overlay.put(KV_KEYS.GLOBAL_CONFIG, '{"enabled":true}');
        expect(await overlay.get(KV_KEYS.GLOBAL_CONFIG)).toBe('{"enabled":true}');
        expect(config.read(['autoConfig']).records[0].revision).toBe(0);
        commit(); expect(config.read(['autoConfig']).records[0].value).toEqual({ enabled: true });
        expect(cache.get).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
    });
    it('rejects read/write skew even when only a different domain is being written', async () => {
        const { overlay, config, commit } = await fixture(); await overlay.get(KV_KEYS.ACCOUNTS); await overlay.put(KV_KEYS.vars('cmliu'), '[]');
        config.compareAndSet('gen1', [{ domain: 'accounts', expectedRevision: 1, value: ['changed'] }]);
        expect(commit).toThrow('CONFLICT'); expect(config.read(['vars:cmliu']).records[0].revision).toBe(1);
    });
    it('allows disjoint concurrent changes if they were not read dependencies', async () => {
        const { overlay, config, commit } = await fixture(); await overlay.put(KV_KEYS.vars('cmliu'), '[]');
        config.compareAndSet('gen1', [{ domain: 'accounts', expectedRevision: 1, value: ['changed'] }]);
        expect(commit).not.toThrow();
    });
    it('enumerates paginated authoritative keys and never exposes old KV or tombstones', async () => {
        const { overlay, cache } = await fixture();
        await overlay.delete(KV_KEYS.vars('cmliu')); await overlay.put(KV_KEYS.favorites('ech'), '[]');
        const first = await overlay.list({ limit: 1 }); expect(first.keys).toEqual([{ name: KV_KEYS.ACCOUNTS }]); expect(first.list_complete).toBe(false);
        const second = await overlay.list({ limit: 1, cursor: first.cursor }); expect(second.keys).toEqual([{ name: KV_KEYS.favorites('ech') }]); expect(second.list_complete).toBe(true);
        expect(cache.list).not.toHaveBeenCalled(); expect(await overlay.list({ prefix: 'VARS_' })).toMatchObject({ keys: [] });
    });
    it('rejects phantom keys added after a snapshot used by a list/cleanup operation', async () => {
        const { overlay, config, commit } = await fixture(); await overlay.list({ prefix: 'VARS_' }); await overlay.put(KV_KEYS.ACCOUNTS, '[]');
        config.compareAndSet('gen1', [{ domain: 'override:cmliu:abc123', expectedRevision: 0, value: [] }]);
        expect(commit).toThrow('CONFLICT');
    });
    it('stages cache invalidation and only forwards it when explicitly flushed', async () => {
        const { overlay, cache } = await fixture();
        expect(await overlay.get(KV_KEYS.ghInfoCache('cmliu'))).toBe('stale-kv-data');
        await overlay.delete(KV_KEYS.ghInfoCache('cmliu')); expect(await overlay.get(KV_KEYS.ghInfoCache('cmliu'))).toBe(null);
        expect(cache.delete).not.toHaveBeenCalled(); await overlay.flushCache(); expect(cache.delete).toHaveBeenCalledExactlyOnceWith(KV_KEYS.ghInfoCache('cmliu'));
    });
    it('fails closed on unknown/migration keys, malformed JSON or business TTL writes', async () => {
        const { overlay, cache } = await fixture();
        for (const key of ['RESTORE_SNAPSHOT_test', 'VARS_unknown', 'arbitrary']) {
            await expect(overlay.get(key)).rejects.toThrow('INVALID'); await expect(overlay.put(key, '{}')).rejects.toThrow('INVALID'); await expect(overlay.delete(key)).rejects.toThrow('INVALID');
        }
        await expect(overlay.put(KV_KEYS.ACCOUNTS, 'bad')).rejects.toThrow('INVALID');
        await expect(overlay.put(KV_KEYS.ACCOUNTS, '[]', { expirationTtl: 60 })).rejects.toThrow('INVALID');
        expect(cache.put).not.toHaveBeenCalled(); expect(cache.delete).not.toHaveBeenCalled();
    });
    it('freezes the complete view and commits deletions as revisioned tombstones', async () => {
        const { config, cache } = await fixture(); const view = config.readAll(), overlay = new ConfigOverlay(view, cache);
        (view.records.find(r => r.domain === 'vars:cmliu')!.value as any[])[0].value = 'mutated';
        expect(await overlay.get(KV_KEYS.vars('cmliu'))).toContain('old'); await overlay.delete(KV_KEYS.ACCOUNTS);
        config.compareAndSet(overlay.generation, overlay.changes(), overlay.dependencies());
        expect(config.read(['accounts']).records[0]).toEqual({ domain: 'accounts', revision: 2, value: null });
    });
});
