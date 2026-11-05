import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteFixture } from './sqlite-fixture';
import { ConfigStore } from '../../src/reliability/config-store';
import { CredentialAuthority } from '../../src/reliability/credential-authority';
import { migrateCredentialAccounts } from '../../src/reliability/credential-accounts';
import { SealedStore } from '../../src/reliability/sealed-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { TaskPreparation } from '../../src/reliability/task-preparation';
import { AccountQueue } from '../../src/reliability/account-queue';
import { AccountCoordinatorRuntime, GlobalCoordinatorRuntime, type RpcSend } from '../../src/reliability/coordinator-runtime';
import { CoordinatorEndpoint } from '../../src/reliability/coordinator-endpoint';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME, accountObjectName } from '../../src/reliability/coordinator-rpc';
import { manifestDigest, type Json } from '../../src/reliability/protocol';
import { fetchWithTimeout } from '../../src/lib/cloudflare-api';
const open: ReturnType<typeof sqliteFixture>[] = [];
const ring = { currentId: 'test', keys: { test: 'test-only-encryption-not-production-key' } };
const secret = 'test-only-rpc-digest-not-production-key';
const bytes = new TextEncoder().encode(secret);
const input = { now: 1000, uuids: [], subdomains: [], sources: {} };
afterEach(() => { for (const f of open.splice(0)) f.sql.close(); vi.restoreAllMocks(); });
async function fixture() {
    const global = sqliteFixture(); open.push(global);
    const config = new ConfigStore(global.db), sealed = new SealedStore(global.db, ring), dispatch = new TaskDispatch(global.db, bytes), authority = new CredentialAuthority(global.db, config, dispatch, ring, () => 1000), prep = new TaskPreparation(config, sealed, dispatch, bytes);
    const accounts = await migrateCredentialAccounts(['a1', 'a2', 'a3', 'a4'].map(accountId => ({ accountId, alias: accountId, email: '', globalKey: '', apiToken: 'mock-private-token', authMode: 'token' as const })), ring, 'plaintext');
    const records = [{ domain: 'accounts', revision: 1, value: accounts as unknown as Json }];
    config.beginImport('g1', await manifestDigest(records), 1); config.stage('g1', records[0]); await config.activateInitial('g1', 0); await authority.initialize('g1', 1); config.setMaintenance(false, 1);
    const rpc = new CoordinatorRpc(secret), endpoints = new Map<string, CoordinatorEndpoint>();
    let lose: string | undefined, offline = false, unknown = false;
    const send: RpcSend = async (method, account, body) => {
        if (offline) throw new Error('simulated RPC unavailable');
        const name = method === 'deliver' ? accountObjectName(account) : GLOBAL_OBJECT_NAME;
        const response = await endpoints.get(name)!.fetch(await rpc.request(method, account, body));
        if (lose === method) { lose = undefined; throw new Error('simulated lost RPC response'); }
        if (!response.ok) throw new Error('RPC_' + response.status);
        return (await response.json() as { value: Json }).value;
    };
    const globalArm = vi.fn(async (_ms: number) => {}), gate = async <T>(callback: () => Promise<T>) => callback();
    const makeGlobal = () => new GlobalCoordinatorRuntime(global.db, config, sealed, dispatch, authority, prep, send, { admit: gate, arm: globalArm });
    let runtime = makeGlobal(); const globalEndpoint = new CoordinatorEndpoint(global.db, rpc, name => name === GLOBAL_OBJECT_NAME, () => runtime);
    globalEndpoint.bindTrusted({ role: 'global' }); endpoints.set(GLOBAL_OBJECT_NAME, globalEndpoint);
    const locals = new Map<string, { db: typeof global.db; sql: typeof global.sql; queue: AccountQueue; calls: number; arm: ReturnType<typeof vi.fn>; endpoint: CoordinatorEndpoint; rebuild: () => void }>();
    for (const account of ['a1', 'a2', 'a3', 'a4']) {
        const f = sqliteFixture(); open.push(f); const queue = new AccountQueue(f.db), localSealed = new SealedStore(f.db, ring), arm = vi.fn(async (_ms: number) => {});
        const local = { ...f, queue, calls: 0, arm, endpoint: null! as CoordinatorEndpoint, rebuild: () => {} };
        const factory = () => new AccountCoordinatorRuntime(f.db, queue, localSealed, account, send, { admit: gate, arm }, { digestSecret: secret,
            transport: async () => { local.calls++; if (unknown) throw new Error('simulated uncertain write'); return Response.json({ success: true }); },
            execute: async () => { const response = await fetchWithTimeout('https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/mock', { method: 'PUT', body: 'mock' }); return { outcome: 'verified', result: await response.json() as Json }; }
        });
        local.rebuild = () => { local.endpoint = new CoordinatorEndpoint(f.db, rpc, name => name === accountObjectName(account), factory); endpoints.set(accountObjectName(account), local.endpoint); };
        local.rebuild(); locals.set(account, local);
    }
    const submit = (key = 'once', targets = ['a1'], steps = ['upload']) => runtime.submit({ scope: 'test', key, generation: 'g1', epoch: config.status().epoch, expected: [{ domain: 'accounts', revision: 1 }], targets: targets.map(account => ({ account, steps, operation: { credentialRevision: 1, input, operation: { mocked: true } } })) });
    return { ...global, config, dispatch, authority, sealed, runtime, globalArm, submit, locals, send, setLose: (v: string) => { lose = v; }, setOffline: (v: boolean) => { offline = v; }, setUnknown: () => { unknown = true; }, rebuildGlobal: () => { runtime = makeGlobal(); return runtime; } };
}
describe('role-separated durable coordinator chain', () => {
    it('executes a frozen task then releases a permit only after a durable terminal receipt', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!;
        await f.runtime.tick(); expect(f.dispatch.inspect(task.id)[0].state).toBe('accepted'); expect(a.calls).toBe(0);
        await a.endpoint.alarm(); expect(a.calls).toBe(1); expect(a.queue.inspect(task.id).state).toBe('succeeded'); expect(f.dispatch.inspect(task.id)[0].state).toBe('accepted');
        await a.endpoint.alarm(); expect(f.dispatch.inspect(task.id)[0]).toMatchObject({ state: 'terminal', outcome: 'succeeded' }); expect(a.calls).toBe(1);
        expect(f.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='account_jobs'")).toEqual([]);
        expect(a.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='config_records'")).toEqual([]);
        expect(JSON.stringify(a.db.rows('SELECT * FROM coordinator_inbox'))).not.toContain('mock-private-token');
    });
    it('deduplicates delivery after lost acknowledgments, with unchanged token across reconstruction', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!; f.setLose('deliver'); await f.runtime.tick();
        expect(f.dispatch.inspect(task.id)[0].state).toBe('sending'); const inbox = a.db.rows('SELECT * FROM coordinator_inbox');
        a.rebuild(); await f.rebuildGlobal().tick(); expect(a.db.rows('SELECT * FROM coordinator_inbox')).toEqual(inbox);
        await a.endpoint.alarm(); await a.endpoint.alarm(); expect(a.calls).toBe(1); expect(f.dispatch.inspect(task.id)[0].state).toBe('terminal');
    });
    it('retries only the outbox when the global terminal commit succeeded but its response was lost', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!; await f.runtime.tick(); await a.endpoint.alarm();
        f.setLose('complete'); await a.endpoint.alarm(); expect(f.dispatch.inspect(task.id)[0].state).toBe('terminal');
        expect(a.db.rows<{ acknowledged: number }>('SELECT acknowledged FROM coordinator_receipts')[0].acknowledged).toBe(0);
        a.rebuild(); await a.endpoint.alarm(); expect(a.calls).toBe(1); expect(a.db.rows<{ acknowledged: number }>('SELECT acknowledged FROM coordinator_receipts')[0].acknowledged).toBe(1);
    });
    it('reconstructs a missing terminal outbox from account facts without executing again', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!; await f.runtime.tick();
        a.sql.exec("CREATE TRIGGER crash_receipt BEFORE INSERT ON coordinator_receipts BEGIN SELECT RAISE(ABORT, 'injected crash'); END");
        await expect(a.endpoint.alarm()).rejects.toThrow('injected crash'); expect(a.queue.inspect(task.id).state).toBe('succeeded'); expect(a.calls).toBe(1);
        a.sql.exec('DROP TRIGGER crash_receipt'); a.rebuild(); await a.endpoint.alarm(); expect(a.calls).toBe(1); expect(f.dispatch.inspect(task.id)[0].state).toBe('terminal');
    });
    it('holds at most three accounts globally and serializes later tasks for the same account', async () => {
        const f = await fixture(), first = await f.submit('first', ['a1','a2','a3','a4']), second = await f.submit('second', ['a1']);
        await f.runtime.tick(); expect(f.dispatch.inspect(first.id).map(r => r.state)).toEqual(['accepted','accepted','accepted','pending']);
        expect(f.dispatch.inspect(second.id)[0].state).toBe('pending');
        const a = f.locals.get('a1')!; await a.endpoint.alarm(); await a.endpoint.alarm(); await f.runtime.tick();
        expect(f.dispatch.inspect(first.id)[3].state).toBe('accepted'); expect(f.dispatch.inspect(second.id)[0].state).toBe('pending');
        const b = f.locals.get('a2')!; await b.endpoint.alarm(); await b.endpoint.alarm(); await f.runtime.tick(); expect(f.dispatch.inspect(second.id)[0].state).toBe('accepted');
    });
    it('does not keep polling global alarms when pending work is blocked by an accepted account', async () => {
        const f = await fixture(); await f.submit('one'); await f.submit('two'); await f.runtime.tick(); f.globalArm.mockClear();
        await f.runtime.tick(); expect(f.globalArm).not.toHaveBeenCalled();
    });
    it('keeps unknown writes blocked across restart and never synthesizes a terminal receipt', async () => {
        const f = await fixture(), first = await f.submit('one'), second = await f.submit('two'), a = f.locals.get('a1')!; f.setUnknown(); await f.runtime.tick(); await a.endpoint.alarm();
        expect(a.queue.inspect(first.id).state).toBe('needs_review'); a.rebuild(); a.arm.mockClear(); await a.endpoint.alarm(); await f.runtime.tick();
        expect(a.calls).toBe(1); expect(a.arm).not.toHaveBeenCalled(); expect(a.db.rows('SELECT * FROM coordinator_receipts')).toEqual([]); expect(f.dispatch.inspect(first.id)[0].state).toBe('accepted'); expect(f.dispatch.inspect(second.id)[0].state).toBe('pending');
    });
    it('checks credential revocation on the real runner path and does not release the denied permit', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!; await f.runtime.tick(); f.authority.revoke('g1','a1',1); await a.endpoint.alarm();
        expect(a.calls).toBe(0); expect(a.queue.inspect(task.id).state).toBe('needs_review'); expect(f.dispatch.inspect(task.id)[0].state).toBe('accepted');
    });
    it('does not dispatch during maintenance and still accepts already verified terminal receipts', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!; f.config.setMaintenance(true,2); await f.runtime.tick(); expect(f.dispatch.inspect(task.id)[0].state).toBe('pending');
        f.config.setMaintenance(false,3); await f.runtime.tick(); await a.endpoint.alarm(); f.config.setMaintenance(true,4); f.authority.revoke('g1','a1',1);
        await a.endpoint.alarm(); expect(f.dispatch.inspect(task.id)[0].state).toBe('terminal'); expect(a.calls).toBe(1);
    });
    it('rolls back account queue and immutable inbox together on a persistence failure', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!;
        // Initialize tables, then fail inside the combined inbox/queue transaction.
        a.endpoint.bindTrusted({ role: 'account', account: 'a1' });
        a.sql.exec("CREATE TRIGGER reject_inbox BEFORE INSERT ON coordinator_inbox BEGIN SELECT RAISE(ABORT, 'injected'); END");
        await f.runtime.tick(); expect(f.dispatch.inspect(task.id)[0].state).toBe('sending'); expect(a.db.rows('SELECT * FROM account_jobs')).toEqual([]); expect(a.db.rows('SELECT * FROM coordinator_inbox')).toEqual([]);
    });
    it('rejects a missing or weak account receipt key before creating a runnable coordinator', async () => {
        const f = await fixture(), a = f.locals.get('a1')!, sealed = new SealedStore(a.db,ring);
        for (const digestSecret of ['', 'short']) expect(() => new AccountCoordinatorRuntime(a.db,a.queue,sealed,'a1',f.send,{ admit:fn => fn(),arm:async () => {} },{ digestSecret,transport:async () => Response.json({}),execute:async () => ({ outcome:'verified',result:null }) })).toThrow('INVALID');
    });
    it('does not commit an admission if durable wake scheduling fails', async () => {
        const f = await fixture(); f.globalArm.mockRejectedValueOnce(new Error('alarm unavailable'));
        await expect(f.submit()).rejects.toThrow('alarm unavailable'); expect(f.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);
    });
    it('parks after eight failed delivery passes with a persistent backoff and no permit expiry', async () => {
        const f = await fixture(), task = await f.submit(); f.setOffline(true); f.globalArm.mockClear();
        for (let i=0;i<10;i++) await f.runtime.tick();
        expect(f.globalArm.mock.calls.map(c => c[0])).toEqual([1000,2000,4000,8000,16000,32000,64000,128000]);
        expect(f.dispatch.inspect(task.id)[0].state).toBe('sending'); await f.rebuildGlobal().tick(); expect(f.globalArm).toHaveBeenCalledTimes(8);
    });
    it('rejects changed delivery identity/permit and forged receipt metadata', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!; await f.runtime.tick();
        const delivery = JSON.parse(a.db.rows<{ delivery: string }>('SELECT delivery FROM coordinator_inbox')[0].delivery);
        await expect(f.send('deliver','a1',{ ...delivery, token:'stale' })).rejects.toThrow('RPC_409');
        const { task: id, account, token, snapshot, generation, credentialRevision } = delivery;
        const permit = { task: id, account, token, snapshot, generation, credentialRevision };
        for (const patch of [{ account: 'a2' }, { token: 'stale' }, { snapshot: 'wrong' }, { generation:'g2' }, { credentialRevision:2 }]) await expect(f.send('complete','a1',{ permit: { ...permit, ...patch }, outcome:'succeeded', evidence:'a'.repeat(64) })).rejects.toThrow();
        expect(f.dispatch.inspect(task.id)[0].state).toBe('accepted'); expect(a.calls).toBe(0);
    });
    it('rechecks maintenance after scheduling yields before reserving a permit', async () => {
        const f = await fixture(), task = await f.submit();
        f.globalArm.mockImplementationOnce(async () => { f.config.setMaintenance(true,2); });
        await f.runtime.tick(); expect(f.dispatch.inspect(task.id)[0].state).toBe('pending');
    });
    it('refreshes credential authorization before the HTTP mutation, not only before snapshot loading', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!; await f.runtime.tick();
        const original = f.authority.authorize.bind(f.authority); let calls = 0;
        vi.spyOn(f.authority,'authorize').mockImplementation(value => { original(value); if (++calls === 2) f.authority.revoke('g1','a1',1); });
        await a.endpoint.alarm(); expect(calls).toBe(2); // The third check throws before incrementing.
        expect(a.calls).toBe(0); expect(a.queue.inspect(task.id).state).toBe('needs_review');
        expect(f.dispatch.inspect(task.id)[0].state).toBe('accepted');
    });
    it('flushes an old terminal outbox before a newly granted task, without replaying the old write', async () => {
        const f = await fixture(), first = await f.submit('one'), second = await f.submit('two'), a = f.locals.get('a1')!;
        await f.runtime.tick(); await a.endpoint.alarm(); f.setLose('complete'); await a.endpoint.alarm(); await f.runtime.tick();
        expect(f.dispatch.inspect(first.id)[0].state).toBe('terminal'); expect(f.dispatch.inspect(second.id)[0].state).toBe('accepted');
        await a.endpoint.alarm(); expect(a.calls).toBe(2); await a.endpoint.alarm(); expect(f.dispatch.inspect(second.id)[0].state).toBe('terminal');
        expect(a.db.rows('SELECT task FROM coordinator_receipts WHERE acknowledged=1')).toHaveLength(2);
    });
    it('does not accept needs_review as a terminal release even from an authenticated account', async () => {
        const f = await fixture(), task = await f.submit(), a = f.locals.get('a1')!; await f.runtime.tick();
        const value = JSON.parse(a.db.rows<{ delivery:string }>('SELECT delivery FROM coordinator_inbox')[0].delivery);
        const { task:id,account,token,snapshot,generation,credentialRevision } = value;
        await expect(f.send('complete','a1',{ permit:{ task:id,account,token,snapshot,generation,credentialRevision },outcome:'needs_review',evidence:'a'.repeat(64) })).rejects.toThrow('RPC_400');
        expect(f.dispatch.inspect(task.id)[0].state).toBe('accepted');
    });
    it('merges concurrent alarm passes and executes only one logical step per pass', async () => {
        const f = await fixture(), task = await f.submit('multi',['a1'],['upload','configure_domain']), a = f.locals.get('a1')!;
        await Promise.all([f.runtime.tick(), f.runtime.tick()]); await Promise.all([a.endpoint.alarm(),a.endpoint.alarm()]);
        expect(a.calls).toBe(1); expect(a.queue.inspect(task.id).state).toBe('running'); await a.endpoint.alarm(); expect(a.calls).toBe(2); expect(a.queue.inspect(task.id).state).toBe('succeeded');
    });
});


describe('explicit durable wake, never an unknown unlock',()=>{
    it('restarts a parked global delivery budget without replacing its permit',async()=>{
        const f=await fixture(),{id}=await f.submit();f.setOffline(true);for(let i=0;i<9;i++)await f.runtime.tick();
        const original=f.dispatch.reserve()[0];expect(f.db.rows<{failures:number}>('SELECT failures FROM coordinator_alarm')[0].failures).toBe(8);
        f.setOffline(false);const resumed=f.rebuildGlobal();await resumed.requestWake(id);await resumed.tick();expect(f.dispatch.inspect(id)[0].state).toBe('accepted');
        const inbox=JSON.parse(f.locals.get('a1')!.db.rows<{delivery:string}>('SELECT delivery FROM coordinator_inbox')[0].delivery);expect(inbox.token).toBe(original.token);expect(f.dispatch.pendingWakes()).toEqual([]);
    });
    it('resumes a parked account receipt after restart, never repeating its completed write',async()=>{
        const f=await fixture(),{id}=await f.submit(),a=f.locals.get('a1')!;await f.runtime.tick();await a.endpoint.alarm();expect(a.calls).toBe(1);
        f.setOffline(true);for(let i=0;i<9;i++)await a.endpoint.alarm();expect(a.db.rows<{failures:number}>('SELECT failures FROM coordinator_alarm')[0].failures).toBe(8);
        f.setOffline(false);a.rebuild();const resumed=f.rebuildGlobal();await resumed.requestWake(id);expect(f.dispatch.pendingWakes()).toHaveLength(1);await resumed.tick();await a.endpoint.alarm();
        expect(f.dispatch.inspect(id)[0]).toMatchObject({state:'terminal',outcome:'succeeded'});expect(a.calls).toBe(1);
    });
    it('keeps unknown and queued work blocked with the original token after explicit wake',async()=>{
        const f=await fixture(),{id}=await f.submit(),a=f.locals.get('a1')!;f.setUnknown();await f.runtime.tick();await a.endpoint.alarm();const queueBefore=a.queue.inspect(id);
        const next=await f.submit('behind');await f.runtime.requestWake(id);await f.runtime.tick();a.rebuild();await a.endpoint.alarm();
        expect(a.queue.inspect(id)).toEqual(queueBefore);expect(a.calls).toBe(1);expect(f.dispatch.inspect(id)[0]).toMatchObject({state:'accepted',outcome:null});expect(f.dispatch.inspect(next.id)[0].state).toBe('pending');
    });
    it('persists lost wake ACK across restart and a late ACK cannot clear a newer request',async()=>{
        const f=await fixture(),{id}=await f.submit();await f.runtime.tick();await f.runtime.requestWake(id);const first=f.dispatch.pendingWakes()[0];
        await f.runtime.requestWake(id);f.dispatch.acknowledgeWake(id,first.account,first.token,first.request);expect(f.dispatch.pendingWakes()).toHaveLength(1);
        f.setLose('deliver');await f.runtime.tick();expect(f.dispatch.pendingWakes()).toHaveLength(1);await f.rebuildGlobal().tick();expect(f.dispatch.pendingWakes()).toEqual([]);expect(f.locals.get('a1')!.calls).toBe(0);
    });
    it('rejects wake in maintenance and requires explicit wake after leaving maintenance',async()=>{
        const f=await fixture(),{id}=await f.submit();await f.runtime.tick();f.config.setMaintenance(true,2);await expect(f.runtime.requestWake(id)).rejects.toThrow('MAINTENANCE');expect(f.dispatch.pendingWakes()).toEqual([]);
        f.config.setMaintenance(false,3);await f.runtime.requestWake(id);expect(f.dispatch.pendingWakes()).toHaveLength(1);
        f.config.setMaintenance(true,4);const local=f.locals.get('a1')!,before=local.arm.mock.calls.length;await f.runtime.tick();expect(local.arm.mock.calls).toHaveLength(before);expect(f.dispatch.pendingWakes()).toHaveLength(1);
    });
    it('does not resurrect terminal targets and refuses unknown task IDs',async()=>{
        const f=await fixture(),{id}=await f.submit(),a=f.locals.get('a1')!;await f.runtime.tick();await a.endpoint.alarm();await a.endpoint.alarm();await f.runtime.requestWake(id);expect(f.dispatch.pendingWakes()).toEqual([]);await f.runtime.tick();expect(a.calls).toBe(1);
        await expect(f.runtime.requestWake('missing')).rejects.toThrow('NOT_READY');
    });
});
