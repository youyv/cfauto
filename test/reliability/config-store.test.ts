import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ConfigStore, type SqlDatabase } from '../../src/reliability/config-store';
import { canonical, manifestDigest } from '../../src/reliability/protocol';
import type { ConfigRecord } from '../../src/reliability/protocol';

function database() {
    const sqlite = new DatabaseSync(':memory:');
    let failOutbox = false;
    const db: SqlDatabase = {
        rows(query, ...params) {
            if (failOutbox && query.startsWith('INSERT INTO config_outbox')) throw new Error('injected persistence failure');
            return sqlite.prepare(query).all(...params) as any;
        },
        transaction(fn) {
            sqlite.exec('BEGIN IMMEDIATE');
            try { const result = fn(); sqlite.exec('COMMIT'); return result; }
            catch (error) { sqlite.exec('ROLLBACK'); throw error; }
        }
    };
    return { db, sqlite, fail: () => { failOutbox = true; } };
}
const initial: ConfigRecord[] = [
    { domain: 'autoConfig', revision: 1, value: { enabled: false, interval: 30 } },
    { domain: 'vars:cmliu', revision: 1, value: [] }
];
async function bootstrap(store: ConfigStore) {
    store.beginImport('g1', await manifestDigest(initial), initial.length);
    initial.forEach(r => store.stage('g1', r));
    await store.activateInitial('g1', 0);
    store.setMaintenance(false, 1);
}
describe('P1 real SQLite config kernel (not a DO runtime substitute)', () => {
    it('starts closed and never bootstraps via an ordinary write', () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db);
            expect(store.status()).toMatchObject({ generation: null, maintenance: 1, epoch: 0 });
            expect(() => store.setMaintenance(false, 0)).toThrow('NOT_READY');
            expect(() => store.compareAndSet('g1', [{ domain: 'autoConfig', expectedRevision: 0, value: {} }])).toThrow('NOT_READY');
        } finally { sqlite.close(); }
    });
    it('stage resume is idempotent, rejects replacement and incomplete activation', async () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db);
            const digest = await manifestDigest(initial);
            store.beginImport('g1', digest, 2); store.beginImport('g1', digest, 2);
            store.stage('g1', initial[0]); store.stage('g1', initial[0]);
            expect(() => store.stage('g1', { ...initial[0], value: {} })).toThrow('CONFLICT');
            await expect(store.activateInitial('g1', 0)).rejects.toThrow('CONFLICT');
            store.stage('g1', initial[1]);
            await store.activateInitial('g1', 0);
            expect(store.read(['autoConfig']).records[0]).toEqual(initial[0]);
            expect(() => store.stage('g1', initial[0])).toThrow('CONFLICT');
        } finally { sqlite.close(); }
    });
    it('rejects corrupted manifests without changing active state', async () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db);
            store.beginImport('bad', '0'.repeat(64), 1); store.stage('bad', initial[0]);
            await expect(store.activateInitial('bad', 0)).rejects.toThrow('CONFLICT');
            expect(store.status().generation).toBe(null);
        } finally { sqlite.close(); }
    });
    it('simultaneous stale editors yield one write and one conflict', async () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db); await bootstrap(store);
            const results = await Promise.allSettled([true, false].map(enabled => Promise.resolve().then(() => store.compareAndSet('g1', [{ domain: 'autoConfig', expectedRevision: 1, value: { enabled } }]))));
            expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
            expect(store.read(['autoConfig']).records[0].revision).toBe(2);
        } finally { sqlite.close(); }
    });
    it('multi-domain conflict rolls back all changes and outbox', async () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db); await bootstrap(store);
            const before = store.pendingProjection();
            expect(() => store.compareAndSet('g1', [
                { domain: 'autoConfig', expectedRevision: 1, value: { enabled: true } },
                { domain: 'vars:cmliu', expectedRevision: 99, value: ['bad'] }
            ])).toThrow('CONFLICT');
            expect(store.read(['autoConfig']).records[0]).toEqual(initial[0]);
            expect(store.pendingProjection()).toEqual(before);
        } finally { sqlite.close(); }
    });
    it('outbox persistence failure rolls back an acknowledged config write', async () => {
        const { db, sqlite, fail } = database();
        try {
            const store = new ConfigStore(db); await bootstrap(store); fail();
            expect(() => store.compareAndSet('g1', [{ domain: 'autoConfig', expectedRevision: 1, value: {} }])).toThrow('injected');
            expect(store.read(['autoConfig']).records[0]).toEqual(initial[0]);
        } finally { sqlite.close(); }
    });
    it('runtime updates are idempotent, monotonic and never overwrite user configuration', async () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db); await bootstrap(store);
            store.recordRuntime('cron1', { lastCheck: 200 });
            store.compareAndSet('g1', [{ domain: 'autoConfig', expectedRevision: 1, value: { interval: 60 } }]);
            expect(store.recordRuntime('cron1', { lastCheck: 200 })).toEqual({ revision: 1 });
            expect(() => store.recordRuntime('cron1', { lastCheck: 300 })).toThrow('CONFLICT');
            store.recordRuntime('cron2', { lastCheck: 100, lastGc: 150 });
            expect(store.readRuntime().value).toEqual({ lastCheck: 200, lastGc: 150 });
            expect(store.read(['autoConfig']).records[0].value).toEqual({ interval: 60 });
            expect(() => store.recordRuntime('bad', { enabled: true } as any)).toThrow('INVALID');
        } finally { sqlite.close(); }
    });
    it('maintenance blocks writes and bootstrap cannot replace a live generation', async () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db); await bootstrap(store);
            expect(() => store.setMaintenance(true, 0)).toThrow('CONFLICT');
            store.setMaintenance(true, 2);
            expect(() => store.compareAndSet('g1', [{ domain: 'autoConfig', expectedRevision: 1, value: {} }])).toThrow('MAINTENANCE');
            expect(() => store.recordRuntime('cron', { lastCheck: 1 })).toThrow('MAINTENANCE');
            store.beginImport('g2', await manifestDigest(initial), 2); initial.forEach(r => store.stage('g2', r));
            await expect(store.activateInitial('g2', 3)).rejects.toThrow('CONFLICT');
        } finally { sqlite.close(); }
    });
    it('activation CAS rechecks after asynchronous hashing', async () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db);
            store.beginImport('g1', await manifestDigest(initial), 2); initial.forEach(r => store.stage('g1', r));
            const results = await Promise.allSettled([store.activateInitial('g1', 0), store.activateInitial('g1', 0)]);
            expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
            expect(store.pendingProjection()).toHaveLength(2);
        } finally { sqlite.close(); }
    });
    it('reconstructing kernel preserves records, receipts and pending outbox', async () => {
        const { db, sqlite } = database();
        try {
            const first = new ConfigStore(db); await bootstrap(first);
            first.recordRuntime('once', { lastGc: 100 });
            first.compareAndSet('g1', [{ domain: 'vars:cmliu', expectedRevision: 1, value: ['mock-secret'] }]);
            const second = new ConfigStore(db);
            expect(second.read(['vars:cmliu']).records[0].revision).toBe(2);
            expect(second.recordRuntime('once', { lastGc: 100 })).toEqual({ revision: 1 });
            expect(second.pendingProjection()).toHaveLength(3);
            expect(JSON.stringify(second.pendingProjection())).not.toContain('mock-secret');
            second.acknowledgeProjection(second.pendingProjection()[0].id as number);
            expect(second.pendingProjection()).toHaveLength(2);
        } finally { sqlite.close(); }
    });
    it('rejects invalid domains, revisions, oversized values and generation mismatch', async () => {
        const { db, sqlite } = database();
        try {
            const store = new ConfigStore(db); await bootstrap(store);
            for (const c of [
                { domain: 'runtime', expectedRevision: 0, value: {} },
                { domain: 'autoConfig', expectedRevision: -1, value: {} },
                { domain: 'autoConfig', expectedRevision: 1, value: 'x'.repeat(131073) }
            ]) expect(() => store.compareAndSet('g1', [c])).toThrow('INVALID');
            expect(() => store.compareAndSet('old', [{ domain: 'autoConfig', expectedRevision: 1, value: {} }])).toThrow('CONFLICT');
        } finally { sqlite.close(); }
    });
    it('canonical manifests are order-independent and reject non-JSON values', async () => {
        expect(await manifestDigest(initial)).toBe(await manifestDigest([...initial].reverse()));
        expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
        expect(() => canonical({ x: undefined })).toThrow('INVALID');
        expect(() => canonical(NaN)).toThrow('INVALID');
    });
});
