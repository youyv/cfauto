import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AccountQueue } from '../../src/reliability/account-queue';
import { TaskDispatch, dispatchOnce } from '../../src/reliability/task-dispatch';
import type { SqlDatabase } from '../../src/reliability/config-store';
const open: DatabaseSync[] = [];
const secret = new Uint8Array(32).fill(17), proof = 'b'.repeat(64);
function fixture() {
    const sql = new DatabaseSync(':memory:'); open.push(sql);
    const db: SqlDatabase = {
        rows: (query, ...params) => sql.prepare(query).all(...params) as any,
        transaction(fn) { sql.exec('BEGIN IMMEDIATE'); try { const r = fn(); sql.exec('COMMIT'); return r; } catch(e) { sql.exec('ROLLBACK'); throw e; } }
    };
    return { sql, db, store: new TaskDispatch(db, secret) };
}
const request = (key = 'key1', accounts = ['a1']) => ({ scope: 'admin', key, targets: accounts.map(account => ({ account, snapshot: 'snap1', steps: ['upload'] })) });
afterEach(() => { for (const sql of open.splice(0)) sql.close(); });
describe('global durable task dispatch', () => {
    it('deduplicates concurrent submissions with normalized target order and rejects changed intent', async () => {
        const { store, sql } = fixture();
        const results = await Promise.all([store.submit(request('key1', ['a1', 'a2'])), store.submit(request('key1', ['a2', 'a1']))]);
        expect(results[0].id).toBe(results[1].id);
        expect(results.filter(r => r.duplicate)).toHaveLength(1);
        const changed = request('key1', ['a1', 'a2']); changed.targets[0].snapshot = 'other';
        await expect(store.submit(changed)).rejects.toThrow('CONFLICT');
        expect(sql.prepare('SELECT * FROM dispatch_tasks').all()).toHaveLength(1);
        expect(sql.prepare('SELECT * FROM dispatch_outbox').all()).toHaveLength(2);
    });
    it('freezes inputs before async HMAC and never stores raw request keys', async () => {
        const { store, sql } = fixture(); const input = request('private-key');
        const pending = store.submit(input); input.targets[0].steps[0] = 'delete_worker'; input.key = 'changed';
        const first = await pending;
        expect((await store.submit(request('private-key'))).id).toBe(first.id);
        expect(store.reserve()[0].steps).toEqual(['upload']);
        expect(JSON.stringify(sql.prepare('SELECT * FROM dispatch_tasks').all())).not.toContain('private-key');
    });
    it('scopes keys to callers and refuses silent HMAC key rotation', async () => {
        const { store, db } = fixture(); const first = await store.submit(request());
        const other = request(); other.scope = 'cron';
        expect((await store.submit(other)).id).not.toBe(first.id);
        const rotated = new TaskDispatch(db, new Uint8Array(32).fill(18));
        await expect(rotated.submit(request())).rejects.toThrow('CONFLICT');
    });
    it('atomically rolls back task, outbox and key marker on storage failure', async () => {
        const { store, sql } = fixture();
        sql.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON dispatch_outbox WHEN NEW.account='a2' BEGIN SELECT RAISE(ABORT,'injected'); END");
        await expect(store.submit(request('key1', ['a1', 'a2']))).rejects.toThrow('injected');
        for (const table of ['dispatch_tasks', 'dispatch_outbox', 'dispatch_key']) expect(sql.prepare('SELECT * FROM ' + table).all()).toHaveLength(0);
    });
    it('limits permits to three accounts and keeps same-account FIFO across restart', async () => {
        const { store, db } = fixture();
        const first = await store.submit(request('k1', ['a1']));
        await store.submit(request('k2', ['a1']));
        await store.submit(request('k3', ['a2', 'a3', 'a4']));
        const deliveries = store.reserve(); expect(deliveries.map(d => d.account)).toEqual(['a1', 'a2', 'a3']);
        const restarted = new TaskDispatch(db, secret);
        expect(restarted.reserve()).toEqual(deliveries);
        for (const d of deliveries) restarted.acknowledge(d.task, d.account, d.token);
        expect(restarted.reserve()).toEqual([]);
        const d = deliveries[0]; restarted.complete(d.task, d.account, d.token, 'succeeded', proof);
        const next = restarted.reserve(); expect(next).toHaveLength(1); expect(next[0].account).toBe('a1'); expect(next[0].task).not.toBe(first.id);
    });
    it('replays a lost delivery response into account inbox without creating another job', async () => {
        const { store } = fixture(); const account = fixture(); const queue = new AccountQueue(account.db);
        await store.submit(request());
        const receive = async (d: any) => { queue.enqueue(d.task, d.digest, d.snapshot, d.steps); };
        expect(await dispatchOnce(store, async d => { await receive(d); throw new Error('secret transport detail'); })).toEqual({ acknowledged: 0, retryPending: 1 });
        const token = store.reserve()[0].token;
        expect(await dispatchOnce(store, receive)).toEqual({ acknowledged: 1, retryPending: 0 });
        expect(store.reserve()).toEqual([]);
        expect(account.sql.prepare('SELECT * FROM account_jobs').all()).toHaveLength(1);
        expect(account.sql.prepare('SELECT * FROM account_steps').all()).toHaveLength(1);
        expect(token).toBeTruthy();
    });
    it('never releases an unknown permit or accepts a stale completion token', async () => {
        const { store } = fixture(); await store.submit(request('k1', ['a1', 'a2', 'a3', 'a4']));
        const d = store.reserve()[0]; store.acknowledge(d.task, d.account, d.token);
        expect(() => store.complete(d.task, d.account, d.token, 'unknown' as any, proof)).toThrow('INVALID');
        expect(() => store.complete(d.task, d.account, 'stale', 'succeeded', proof)).toThrow('CONFLICT');
        expect(store.reserve().map(d => d.account)).toEqual(['a2', 'a3']);
        expect(store.inspect(d.task)[0]).toEqual({ account: 'a1', state: 'accepted', outcome: null });
    });
    it('allows terminal receipts arriving before acknowledgements and makes replays immutable', async () => {
        const { store } = fixture(); await store.submit(request()); const d = store.reserve()[0];
        store.complete(d.task, d.account, d.token, 'partial_cancelled', proof);
        store.acknowledge(d.task, d.account, d.token);
        store.complete(d.task, d.account, d.token, 'partial_cancelled', proof);
        expect(() => store.complete(d.task, d.account, d.token, 'succeeded', proof)).toThrow('CONFLICT');
        expect(() => store.complete(d.task, d.account, d.token, 'partial_cancelled', 'c'.repeat(64))).toThrow('CONFLICT');
        expect(store.reserve()).toEqual([]);
    });
    it('bounds per-account backlog and retains idempotency after completion', async () => {
        const { store, sql } = fixture(); for (let i = 0; i < 50; i++) await store.submit(request('k' + i));
        await expect(store.submit(request('overflow'))).rejects.toThrow('CONFLICT');
        const d = store.reserve()[0]; store.complete(d.task, d.account, d.token, 'cancelled', proof);
        expect((await store.submit(request('k0'))).id).toBe(d.task);
        await store.submit(request('replacement'));
        expect(sql.prepare('SELECT * FROM dispatch_tasks').all()).toHaveLength(51);
    });
    it('bounds global unfinished task count and duplicate requests remain readable at capacity', async () => {
        const { store } = fixture(); for (let i = 0; i < 500; i++) await store.submit(request('k' + i, ['a' + i]));
        await expect(store.submit(request('overflow', ['new']))).rejects.toThrow('CONFLICT');
        expect((await store.submit(request('k0', ['a0']))).duplicate).toBe(true);
    });
    it('copies the HMAC secret and does not let caller mutation change identity', async () => {
        const { db } = fixture(); const mutable = new Uint8Array(secret); const store = new TaskDispatch(db, mutable);
        const first = await store.submit(request()); mutable.fill(0);
        expect((await store.submit(request())).id).toBe(first.id);
    });
    it('leaves only unacknowledged targets for retry after a partial RPC failure', async () => {
        const { store } = fixture(); await store.submit(request('k1', ['a1', 'a2', 'a3', 'a4']));
        expect(await dispatchOnce(store, async d => { if (d.account === 'a2') throw new Error('lost'); })).toEqual({ acknowledged: 2, retryPending: 1 });
        expect(store.reserve().map(d => d.account)).toEqual(['a2']);
        expect(await dispatchOnce(store, async () => {})).toEqual({ acknowledged: 1, retryPending: 0 });
        expect(store.reserve()).toEqual([]); // Accepted is not completed, so a4 still has no permit.
    });
    it('rejects invalid input without partial data', async () => {
        const { store, sql, db } = fixture();
        expect(() => new TaskDispatch(db, new Uint8Array(3))).toThrow('INVALID');
        for (const input of [null, request('k', ['a1', 'a1']), { ...request(), targets: [] }, { ...request(), targets: Array(1) }, { ...request(), targets: [{ account: 'a1', snapshot: 's', steps: Array(1) }] }, { ...request(), targets: [{ account: 'a1', snapshot: 's', steps: ['arbitrary'] }] }]) await expect(store.submit(input as any)).rejects.toThrow('INVALID');
        expect(sql.prepare('SELECT * FROM dispatch_tasks').all()).toHaveLength(0);
    });
});
