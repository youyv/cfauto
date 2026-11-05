import { afterEach, describe, expect, it } from 'vitest';
import { SealedStore, MAX_SEALED_PLAINTEXT_BYTES } from '../../src/reliability/sealed-store';
import { sqliteFixture } from './sqlite-fixture';
const open: ReturnType<typeof sqliteFixture>[] = [];
const context = { id: 'snap1', kind: 'task_snapshot' as const, account: 'account1', generation: 'gen1' };
const ring = { currentId: 'key1', keys: { key1: 'test-secret-material-at-least-32-bytes' } };
function fixture() { const db = sqliteFixture(); open.push(db); return { ...db, store: new SealedStore(db.db, ring) }; }
afterEach(() => { for (const db of open.splice(0)) db.sql.close(); });
describe('immutable sealed snapshots and artifacts', () => {
    it('round trips Unicode and multi-chunk credentials without plaintext storage', async () => {
        const { sql, store } = fixture(); const value = { code: '源码🔐'.repeat(20000), token: 'top-private-token' };
        await store.put(context, value, 1000);
        expect(await store.get(context)).toEqual(value);
        expect(sql.prepare('SELECT * FROM sealed_chunks').all().length).toBeGreaterThan(1);
        expect(JSON.stringify(sql.prepare('SELECT * FROM sealed_chunks').all())).not.toContain(value.token);
        expect(store.info(context)).toEqual({ keyId: 'key1', bytes: new TextEncoder().encode(JSON.stringify({ code: value.code, token: value.token })).length, createdAt: 1000 });
    });
    it('allows identical replays but never overwrites a sealed id', async () => {
        const { store } = fixture(); await store.put(context, { a: 1, b: 2 });
        expect(await store.put(context, { b: 2, a: 1 })).toEqual({ duplicate: true });
        await expect(store.put(context, { a: 2 })).rejects.toThrow('CONFLICT');
        await expect(store.put({ ...context, account: 'other' }, { a: 1, b: 2 })).rejects.toThrow('CONFLICT');
        expect(await store.get(context)).toEqual({ a: 1, b: 2 });
    });
    it('freezes both caller value and key ring before awaiting encryption', async () => {
        const { db } = fixture(); const mutable = { currentId: 'key1', keys: { ...ring.keys } }; const store = new SealedStore(db, mutable);
        const value = { password: 'original' }; const pending = store.put(context, value);
        value.password = 'changed'; mutable.keys.key1 = 'different-secret-at-least-32-bytes'; await pending;
        expect(await store.get(context)).toEqual({ password: 'original' });
    });
    it('binds metadata, chunks and ciphertext to object/account/generation', async () => {
        const { store, sql } = fixture(); await store.put(context, 'sensitive');
        await expect(store.get({ ...context, account: 'other' })).rejects.toThrow('CONFLICT');
        sql.prepare("UPDATE sealed_objects SET account='other'").run();
        await expect(store.get({ ...context, account: 'other' })).rejects.toThrow('INVALID');
    });
    it('rejects reordered, missing and corrupted chunks', async () => {
        for (const mode of ['swap', 'missing', 'corrupt']) {
            const { store, sql } = fixture(); await store.put(context, 'x'.repeat(60000));
            if (mode === 'swap') { const rows = sql.prepare('SELECT ciphertext FROM sealed_chunks ORDER BY ordinal').all() as any[]; sql.prepare('UPDATE sealed_chunks SET ciphertext=? WHERE ordinal=0').run(rows[1].ciphertext); }
            if (mode === 'missing') sql.prepare('DELETE FROM sealed_chunks WHERE ordinal=1').run();
            if (mode === 'corrupt') sql.prepare("UPDATE sealed_chunks SET ciphertext='AAAA' WHERE ordinal=0").run();
            await expect(store.get(context)).rejects.toThrow('INVALID');
        }
    });
    it('fails closed with missing or wrong key but supports an explicit old key slot', async () => {
        const { store, db } = fixture(); await store.put(context, { secret: 'old-data' });
        const next = { currentId: 'key2', keys: { key2: 'another-secret-material-at-least-32-bytes' } };
        await expect(new SealedStore(db, next).get(context)).rejects.toThrow('INVALID');
        await expect(new SealedStore(db, { currentId: 'key1', keys: { key1: next.keys.key2 } }).get(context)).rejects.toThrow('INVALID');
        expect(await new SealedStore(db, { ...next, keys: { ...next.keys, ...ring.keys } }).get(context)).toEqual({ secret: 'old-data' });
    });
    it('commits metadata and chunks atomically under injected storage failure', async () => {
        const { store, sql } = fixture();
        sql.exec("CREATE TRIGGER stop_chunk BEFORE INSERT ON sealed_chunks WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'injected'); END");
        await expect(store.put(context, 'x'.repeat(60000))).rejects.toThrow('injected');
        expect(sql.prepare('SELECT * FROM sealed_objects').all()).toHaveLength(0); expect(sql.prepare('SELECT * FROM sealed_chunks').all()).toHaveLength(0);
    });
    it('rejects sparse arrays instead of sealing invalid or ambiguous JSON', async () => {
        const { store } = fixture();
        await expect(store.put(context, new Array(1))).rejects.toThrow('INVALID');
        await expect(store.put(context, { nested: [1, , 3] } as any)).rejects.toThrow('INVALID');
        await expect(store.get(context)).rejects.toThrow('NOT_READY');
    });
    it('rejects oversize values and reports absent ids without emitting secret detail', async () => {
        const { store } = fixture(); await expect(store.put(context, 'x'.repeat(MAX_SEALED_PLAINTEXT_BYTES))).rejects.toThrow('INVALID');
        await expect(store.get(context)).rejects.toThrow('NOT_READY');
    });
});
