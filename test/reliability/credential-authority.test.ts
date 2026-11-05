import { afterEach, describe, it, expect, vi } from 'vitest';
import { sqliteFixture } from './sqlite-fixture';
import { ConfigStore } from '../../src/reliability/config-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { CredentialAuthority } from '../../src/reliability/credential-authority';
import { migrateCredentialAccounts, readCredentialAccounts } from '../../src/reliability/credential-accounts';
import { manifestDigest } from '../../src/reliability/protocol';
import type { AccountEntry } from '../../src/lib/types';
const open: ReturnType<typeof sqliteFixture>[] = [];
const ring = { currentId: 'new', keys: { new: 'local-only-secret-at-least-32-bytes' } };
const week = 7 * 24 * 60 * 60 * 1000;
const account: AccountEntry = { accountId: 'a1', alias: 'one', email: '', globalKey: '', apiToken: 'mock-token', authMode: 'token', workers_cmliu: ['old-worker'] };
async function fixture(initialized = true) {
    const f = sqliteFixture(); open.push(f); const config = new ConfigStore(f.db), dispatch = new TaskDispatch(f.db, new Uint8Array(32).fill(5));
    let now = 1000;
    const make = () => new CredentialAuthority(f.db, config, dispatch, ring, () => now);
    const authority = make(), accounts = await migrateCredentialAccounts([account], ring, 'plaintext');
    const records = [{ domain: 'accounts', revision: 1, value: accounts as any }];
    config.beginImport('g1', await manifestDigest(records), 1); config.stage('g1', records[0]); await config.activateInitial('g1', 0);
    if (initialized) { await authority.initialize('g1', 1); config.setMaintenance(false, 1); }
    const write = (patch: Partial<AccountEntry> = {}) => authority.write({ generation: 'g1', epoch: config.status().epoch, expectedRevision: config.read(['accounts']).records[0].revision, accounts: [{ ...account, apiToken: '***', ...patch }] });
    const enqueue = () => dispatch.submit({ scope: 'test', key: 'once', targets: [{ account: 'a1', snapshot: 'snap1', steps: ['upload'] }] });
    return { ...f, config, dispatch, authority, make, write, enqueue, accounts, setNow: (value: number) => { now = value; } };
}
afterEach(() => { for (const f of open.splice(0)) f.sql.close(); vi.restoreAllMocks(); });
describe('global credential CAS / task permit integration', () => {
    it('owns a durable seven-day policy initialized only during maintenance and never shortens it on replay', async () => {
        const f = await fixture(false);
        expect(await f.authority.initialize('g1', 1)).toEqual({ observationUntil: 1000 + week });
        f.setNow(99999); expect(await f.make().initialize('g1', 1)).toEqual({ observationUntil: 1000 + week });
        f.config.setMaintenance(false, 1);
        await expect(f.authority.initialize('g1', 2)).rejects.toThrow(/^CONFLICT$/);
    });
    it('rejects initialization with outstanding tasks or invalid imported credentials', async () => {
        const f = await fixture(false); await f.enqueue();
        await expect(f.authority.initialize('g1', 1)).rejects.toThrow(/^CONFLICT$/);
        expect(f.db.rows('SELECT * FROM credential_policy')).toEqual([]);
        const g = await fixture(false); g.sql.prepare('UPDATE config_records SET payload=?').run(JSON.stringify([{ ...account, credentialRevision: 1, apiToken: 'v2:new:bad' }]));
        await expect(g.authority.initialize('g1', 1)).rejects.toThrow(/^INVALID$/);
        expect(g.db.rows('SELECT * FROM credential_policy')).toEqual([]);
    });
    it('fails closed until policy initialization, and enforces observation while allowing metadata updates', async () => {
        const f = await fixture(false); f.config.setMaintenance(false, 1);
        await expect(f.write()).rejects.toThrow(/^NOT_READY$/);
        const g = await fixture(); await expect(g.write({ apiToken: 'changed' })).rejects.toThrow(/^MAINTENANCE$/);
        expect(await g.write({ workers_cmliu: ['new-worker'] })).toEqual({ revision: 2 });
        expect(g.config.read(['accounts']).records[0].value).toEqual([{ ...g.accounts[0], workers_cmliu: ['new-worker'] }]);
    });
    it('blocks both pending and accepted task credentials but allows independent metadata changes', async () => {
        const f = await fixture(); f.setNow(1000 + week); await f.enqueue();
        await expect(f.write({ apiToken: 'changed' })).rejects.toThrow(/^CONFLICT$/);
        const [delivery] = f.dispatch.reserve(); f.dispatch.acknowledge(delivery.task, delivery.account, delivery.token);
        await expect(f.write({ apiToken: 'changed' })).rejects.toThrow(/^CONFLICT$/);
        expect(await f.write({ alias: 'new-alias' })).toEqual({ revision: 2 });
        f.dispatch.complete(delivery.task, delivery.account, delivery.token, 'succeeded', 'a'.repeat(64));
        expect(await f.write({ apiToken: 'changed' })).toEqual({ revision: 3 });
        expect((await readCredentialAccounts(f.config.read(['accounts']).records[0].value as any, ring))[0]).toMatchObject({ apiToken: 'changed', credentialRevision: 2 });
    });
    it('blocks account removal while any snapshot is pending without deleting credentials or outbox', async () => {
        const f = await fixture(); f.setNow(1000 + week); await f.enqueue();
        const before = f.config.readAll();
        await expect(f.authority.write({ generation: 'g1', epoch: 2, expectedRevision: 1, accounts: [] })).rejects.toThrow(/^CONFLICT$/);
        expect(f.config.readAll()).toEqual(before);
    });
    it('checks the permit guard in the same transaction after async encryption, not only at request start', async () => {
        const f = await fixture(); f.setNow(1000 + week);
        const real = f.config.compareAndSet.bind(f.config);
        vi.spyOn(f.config, 'compareAndSet').mockImplementation((...args) => {
            // Simulate a concurrent admission immediately before the CAS begins.
            f.db.rows("INSERT INTO dispatch_outbox(task,account,snapshot,steps,digest,state) VALUES ('racing','a1','snap','[]',?,'pending')", 'a'.repeat(64));
            return real(...args);
        });
        await expect(f.write({ apiToken: 'changed' })).rejects.toThrow(/^CONFLICT$/);
        expect(f.config.read(['accounts']).records[0].revision).toBe(1);
    });
    it('rejects stale revisions and maintenance epoch ABA after asynchronous validation', async () => {
        const f = await fixture(); f.setNow(1000 + week);
        const pending = f.write({ apiToken: 'changed' });
        f.config.setMaintenance(true, 2); f.config.setMaintenance(false, 3);
        await expect(pending).rejects.toThrow(/^CONFLICT$/);
        await expect(f.authority.write({ generation: 'g1', epoch: 4, expectedRevision: 0, accounts: [account] })).rejects.toThrow(/^CONFLICT$/);
    });
    it('serializes concurrent account commits with one conflict rather than losing an update', async () => {
        const f = await fixture(); f.setNow(1000 + week);
        const results = await Promise.allSettled([f.write({ apiToken: 'one-new-token' }), f.write({ apiToken: 'two-new-token' })]);
        expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(f.config.read(['accounts']).records[0].revision).toBe(2);
    });
    it('freezes caller input before WebCrypto awaits', async () => {
        const f = await fixture(); f.setNow(1000 + week);
        const incoming = { generation: 'g1', epoch: 2, expectedRevision: 1, accounts: [{ ...account, workers_cmliu: ['planned'] }] };
        const pending = f.authority.write(incoming); incoming.generation = 'changed'; incoming.epoch = 999; incoming.accounts[0].workers_cmliu.push('changed');
        await pending;
        expect((f.config.read(['accounts']).records[0].value as any)[0].workers_cmliu).toEqual(['planned']);
    });
    it('rolls back config and projection outbox if either guard or persistence fails', async () => {
        const f = await fixture(); const before = f.config.readAll();
        f.sql.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON config_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
        await expect(f.write({ alias: 'new-alias' })).rejects.toThrow('injected');
        expect(f.config.readAll()).toEqual(before);
    });
    it('authorizes only the exact active permit, snapshot, generation and credential revision', async () => {
        const f = await fixture(); await f.enqueue(); const [delivery] = f.dispatch.reserve();
        const permit = { ...delivery, generation: 'g1', credentialRevision: 1 };
        expect(() => f.authority.authorize(permit)).not.toThrow();
        for (const patch of [{ token: 'stale' }, { snapshot: 'other' }, { generation: 'g2' }, { credentialRevision: 2 }, { account: 'a2' }]) expect(() => f.authority.authorize({ ...permit, ...patch })).toThrow(/^CONFLICT$/);
        f.dispatch.complete(delivery.task, delivery.account, delivery.token, 'succeeded', 'a'.repeat(64));
        expect(() => f.authority.authorize(permit)).toThrow(/^CONFLICT$/);
    });
    it('revokes during observation, persists across object reconstruction and never frees an unknown permit', async () => {
        const f = await fixture(); await f.enqueue(); const [delivery] = f.dispatch.reserve();
        const permit = { ...delivery, generation: 'g1', credentialRevision: 1 };
        f.authority.revoke('g1', 'a1', 1); f.authority.revoke('g1', 'a1', 1);
        expect(() => f.make().authorize(permit)).toThrow(/^CONFLICT$/);
        expect(f.dispatch.inspect(delivery.task)[0].state).toBe('sending');
        expect(f.config.read(['accounts']).records[0].value).toEqual(f.accounts);
        expect(f.db.rows('SELECT * FROM credential_revocations')).toHaveLength(1);
    });
    it('maintenance blocks new mutation authorization and keeps revocation available', async () => {
        const f = await fixture(); await f.enqueue(); const [delivery] = f.dispatch.reserve();
        f.config.setMaintenance(true, 2);
        expect(() => f.authority.authorize({ ...delivery, generation: 'g1', credentialRevision: 1 })).toThrow(/^MAINTENANCE$/);
        expect(() => f.authority.revoke('g1', 'a1', 1)).not.toThrow();
    });
    it('authorizes only read-only review of the original live permit during maintenance', async () => {
        const f = await fixture(); await f.enqueue(); const [d] = f.dispatch.reserve();
        f.dispatch.acknowledge(d.task, d.account, d.token);
        const p = { generation: 'g1', task: d.task, account: d.account, token: d.token, snapshot: d.snapshot, credentialRevision: 1 };
        f.config.setMaintenance(true, 2);
        const before = f.db.rows('SELECT * FROM dispatch_outbox');
        expect(() => f.make().authorizeReview(p, 3, 1)).not.toThrow();
        expect(() => f.authority.authorize(p)).toThrow(/^MAINTENANCE$/);
        expect(f.db.rows('SELECT * FROM dispatch_outbox')).toEqual(before);
        f.authority.revoke('g1', 'a1', 1);
        expect(() => f.make().authorizeReview(p, 3, 1)).toThrow(/^CONFLICT$/);
        expect(f.db.rows('SELECT * FROM dispatch_outbox')).toEqual(before);
    });
    it('binds review to current generation, epoch, account revision and every permit field', async () => {
        const f = await fixture(); await f.enqueue(); const [d] = f.dispatch.reserve();
        const p = { generation: 'g1', task: d.task, account: d.account, token: d.token, snapshot: d.snapshot, credentialRevision: 1 };
        expect(() => f.authority.authorizeReview(p, 2, 1)).not.toThrow();
        for (const patch of [{ generation: 'g2' }, { task: 'other' }, { account: 'other' }, { token: 'other' }, { snapshot: 'other' }, { credentialRevision: 2 }]) {
            expect(() => f.authority.authorizeReview({ ...p, ...patch }, 2, 1)).toThrow(/^CONFLICT$/);
        }
        expect(() => f.authority.authorizeReview(p, 1, 1)).toThrow(/^CONFLICT$/);
        expect(() => f.authority.authorizeReview(p, 2, 2)).toThrow(/^CONFLICT$/);
        f.config.setMaintenance(true, 2); f.config.setMaintenance(false, 3);
        expect(() => f.authority.authorizeReview(p, 2, 1)).toThrow(/^CONFLICT$/);
        expect(() => f.authority.authorizeReview(p, 4, 1)).not.toThrow();
        await f.write({ alias: 'changed' });
        expect(() => f.authority.authorizeReview(p, 4, 1)).toThrow(/^CONFLICT$/);
        expect(() => f.authority.authorizeReview(p, 4, 2)).not.toThrow();
        f.dispatch.complete(d.task, d.account, d.token, 'failed', 'b'.repeat(64));
        expect(() => f.authority.authorizeReview(p, 4, 2)).toThrow(/^CONFLICT$/);
    });
    it('rejects malformed review authority rather than interpreting it as a general read grant', async () => {
        const f = await fixture(); await f.enqueue(); const [d] = f.dispatch.reserve();
        const p = { generation: 'g1', task: d.task, account: d.account, token: d.token, snapshot: d.snapshot, credentialRevision: 1 };
        for (const value of [null, { ...p, arbitrary: true }, { ...p, credentialRevision: 0 }]) {
            expect(() => f.authority.authorizeReview(value as any, 2, 1)).toThrow(/^INVALID$/);
        }
        for (const n of [-1, 1.5, NaN]) expect(() => f.authority.authorizeReview(p, n, 1)).toThrow(/^INVALID$/);
    });

});
