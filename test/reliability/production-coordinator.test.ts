import {encryptKey as encryptInitialTestKey} from '../../src/lib/crypto-utils';
import {initialCutoverFixture} from './initial-cutover-fixture';
import {signMaintenance} from '../../src/reliability/maintenance-protocol';
import {AuthorityArchive} from '../../src/reliability/authority-archive';
import {AuthorityDrain} from '../../src/reliability/authority-drain';
import {verifyArchiveBundle} from '../../src/reliability/archive-bundle';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(public ctx: any, public env: any) {} } }));
import { ProductionCoordinator } from '../../src/reliability/production-coordinator';
import { productionConfig } from '../../src/reliability/production-config';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME, accountObjectName } from '../../src/reliability/coordinator-rpc';
import { ConfigStore } from '../../src/reliability/config-store';
import { CredentialAuthority } from '../../src/reliability/credential-authority';
import { migrateCredentialAccounts } from '../../src/reliability/credential-accounts';
import { SealedStore } from '../../src/reliability/sealed-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { TaskPreparation } from '../../src/reliability/task-preparation';
import type { BusinessAction } from '../../src/reliability/business-command';
import { BusinessPlanner } from '../../src/reliability/business-planner';
import { AccountQueue } from '../../src/reliability/account-queue';
import { canonical, manifestDigest, type Json } from '../../src/reliability/protocol';
import { sqliteFixture } from './sqlite-fixture';
import { productionEnv, businessAccount } from './production-fixture';
const opened: ReturnType<typeof sqliteFixture>[] = [];
afterEach(() => { opened.splice(0).forEach(f => f.sql.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
    const env = productionEnv(), settings = productionConfig(env), rpc = new CoordinatorRpc(settings.rpcSecret);
    const entries = new Map<string, { db: ReturnType<typeof sqliteFixture>['db']; ctx: any; object: ProductionCoordinator }>();
    const id = (name: string) => ({ toString: () => name, equals: (other: any) => other.toString() === name });
    env.RELIABILITY_COORDINATOR = { idFromName: id, get: (value: any) => ({ fetch: (r: Request) => get(value.toString()).object.fetch(r) }) } as any;
    function get(name: string) {
        let entry = entries.get(name); if (entry) return entry;
        const f = sqliteFixture(); opened.push(f);
        const ctx = { id: id(name), waitUntil: (p:Promise<unknown>) => { void p; }, blockConcurrencyWhile: (fn: any) => fn(), storage: { sql: { exec: (q: string, ...p: any[]) => ({ toArray: () => f.db.rows(q, ...p) }) }, transactionSync: (fn: any) => f.db.transaction(fn), setAlarm: vi.fn(async () => {}) } };
        entry = { db: f.db, ctx, object: new ProductionCoordinator(ctx, env) }; entries.set(name, entry); return entry;
    }
    const restart = (name: string) => { const entry = get(name); entry.object = new ProductionCoordinator(entry.ctx, env); return entry; };
    return { env, settings, rpc, get, restart };
}
async function seedConfig(f: ReturnType<typeof fixture>) {
    const g = f.get(GLOBAL_OBJECT_NAME), config = new ConfigStore(g.db), secret = new TextEncoder().encode(f.settings.idempotencySecret);
    const sealed = new SealedStore(g.db, f.settings.snapshots), dispatch = new TaskDispatch(g.db, secret);
    const authority = new CredentialAuthority(g.db, config, dispatch, f.settings.credentials);
    const accounts = await migrateCredentialAccounts([{accountId:businessAccount,alias:'example',email:'',globalKey:'',apiToken:'test-token-never-production',authMode:'token',workers_cmliu:['demo']}], f.settings.credentials, 'plaintext');
    const records = [{domain:'accounts',revision:1,value:accounts as unknown as Json}];
    config.beginImport('g1',await manifestDigest(records),1); config.stage('g1',records[0]); await config.activateInitial('g1',0); await authority.initialize('g1',1); config.setMaintenance(false,1);
    return {g,config,sealed,dispatch,secret};
}
async function seed(f: ReturnType<typeof fixture>, actions: BusinessAction[] = [{kind:'upload',template:'cmliu',worker:'demo',ref:'latest',overrides:'apply',echTokenEnabled:false}]) {
    const {g,config,sealed,dispatch,secret} = await seedConfig(f);
    // Test seeds the underlying fixture database, NOT a method on the production DO.
    const denied = await g.object.fetch(await f.rpc.request('authorize',businessAccount,{task:'absent',account:businessAccount,token:'absent',snapshot:'absent',generation:'g1',credentialRevision:1}));
    expect(denied.ok).toBe(false);
    const planner = new BusinessPlanner(config,{ring:f.settings.credentials,protected:f.settings.protected,source:{transport:async url => String(url).startsWith('https://api.github.com/') ? Response.json({sha:'a'.repeat(40)}) : new Response('export default { fetch() { return new Response("test-only"); } };')}});
    const input = await planner.prepare('test-shell',{key:'upload-once',targets:[{account:businessAccount,actions}]});
    const task = await new TaskPreparation(config,sealed,dispatch,secret).submit(input);
    return {g,config,sealed,dispatch,task};
}

describe('production DO shell without loopback/admin/test hooks', () => {
    it('exposes only fetch/alarm, not stores, keys, bootstrap or dynamic handlers', () => {
        const f = fixture(), object = f.get(GLOBAL_OBJECT_NAME).object;
        expect(Object.getOwnPropertyNames(ProductionCoordinator.prototype).sort()).toEqual(['alarm','constructor','fetch']);
        expect(Object.keys(object).sort()).toEqual(['ctx','env']); // Only the mocked base class fields.
        for (const name of ['bootstrap','submit','bindTrusted','execute','db','rpc','config','flags','status']) expect((object as any)[name]).toBeUndefined();
    });
    it.each(['http://127.0.0.1/bootstrap','https://public.example/v1','https://coordinator.internal/flags'])('rejects public/test entry %s without role business tables', async url => {
        const f = fixture(), g = f.get(GLOBAL_OBJECT_NAME);
        const response = await g.object.fetch(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"bootstrap"}'}));
        expect(response.status).toBe(403); expect(await response.text()).toBe('{"error":"INVALID"}');
        expect(g.db.rows('SELECT role FROM coordinator_identity')).toEqual([]);
        expect(g.db.rows("SELECT name FROM sqlite_master WHERE name='config_meta'")).toEqual([]);
    });
    it('rejects valid signature sent to a different physical object', async () => {
        const f = fixture(), g = f.get(accountObjectName('d'.repeat(32)));
        const response = await g.object.fetch(await f.rpc.request('deliver',businessAccount,{})); expect(response.status).toBe(403);
        expect(g.db.rows('SELECT role FROM coordinator_identity')).toEqual([]);
    });
    it('does not initialize storage with missing production Secrets', () => {
        const env = productionEnv(); delete (env as any).RELIABILITY_SNAPSHOT_KEYS;
        const ctx = {storage:{sql:{exec:vi.fn()}}} as any;
        expect(() => new ProductionCoordinator(ctx, env)).toThrow('NOT_READY'); expect(ctx.storage.sql.exec).not.toHaveBeenCalled();
    });
    it('runs the real static executor with independent keys and persistent receipts after reconstruction', async () => {
        const f = fixture(), {g,dispatch,task} = await seed(f); let code = '';
        const network = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toMatch(new RegExp('^https://api.cloudflare.com/client/v4/accounts/'+businessAccount+'/'));
            expect(init?.redirect).toBe('manual');
            if (init?.method === 'PUT') { code = await ((init.body as FormData).get('script') as File).text(); return Response.json({success:true,result:{}}); }
            if (url.endsWith('/bindings')) return Response.json({success:true,result:[]}); return new Response(code);
        }); vi.stubGlobal('fetch',network);
        await g.object.alarm(); const a = f.get(accountObjectName(businessAccount)); await a.object.alarm();
        expect(new AccountQueue(a.db).inspect(task.id).state).toBe('succeeded');
        expect(network).toHaveBeenCalledTimes(3); expect(network.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);
        expect(a.db.rows('SELECT DISTINCT key_id FROM sealed_objects').map(r=>r.key_id)).toEqual(['snapshot_new']);
        expect(g.db.rows("SELECT payload FROM config_records WHERE domain='accounts'")[0].payload).toContain('v2:credential_new:');
        expect(JSON.stringify(a.db.rows('SELECT * FROM sealed_chunks'))).not.toContain('test-token-never-production');
        await f.restart(accountObjectName(businessAccount)).object.alarm();
        expect(dispatch.inspect(task.id)[0].state).toBe('terminal'); expect(network).toHaveBeenCalledTimes(3);
        await f.restart(GLOBAL_OBJECT_NAME).object.alarm(); await a.object.alarm(); expect(network).toHaveBeenCalledTimes(3);
        expect(a.ctx.storage.setAlarm).toHaveBeenCalled();
    });
    it('retains unknown and does not retry a lost external write after reconstruction', async () => {
        const f = fixture(), {g,dispatch,task} = await seed(f);
        const network = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method==='PUT') throw new Error('lost'); return Response.json({success:true,result:[]}); }); vi.stubGlobal('fetch',network);
        await g.object.alarm(); const name = accountObjectName(businessAccount), a = f.get(name); await a.object.alarm();
        expect(new AccountQueue(a.db).inspect(task.id).state).toBe('needs_review');
        await f.restart(name).object.alarm(); await f.restart(GLOBAL_OBJECT_NAME).object.alarm();
        expect(network.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1); expect(dispatch.inspect(task.id)[0].state).toBe('accepted');
    });
});

describe('production progress-to-authority integration',()=>{
    const create:BusinessAction={kind:'create_worker',template:'cmliu',worker:'created',ref:'latest',variables:[],namespaceTitle:'',echTokenEnabled:false};
    const domain:BusinessAction={kind:'configure_domain',template:'cmliu',worker:'created',enabled:true,customPrefix:''};
    function network() {
        let code='';
        const fetch=vi.fn(async (url:string,init?:RequestInit)=>{
            if(init?.method==='PUT'){code=await ((init.body as FormData).get('script') as File).text();return Response.json({success:true,result:{}});}
            if(init?.method==='POST')return Response.json({success:false},{status:403});
            if(url.endsWith('/bindings'))return Response.json({success:true,result:[]});
            return code?new Response(code):Response.json({success:false,errors:[{code:10007}]},{status:404});
        });vi.stubGlobal('fetch',fetch);return fetch;
    }
    it('adds the verified Worker before later domain failure and before releasing its global permit',async()=>{
        const f=fixture(),{g,config,dispatch,task}=await seed(f,[create,domain]),fetch=network();await g.object.alarm();const a=f.get(accountObjectName(businessAccount));await a.object.alarm();
        expect((config.read(['accounts']).records[0].value as any)[0].workers_cmliu).toEqual(['demo','created']);expect(dispatch.inspect(task.id)[0].state).toBe('accepted');
        await a.object.alarm();await f.restart(accountObjectName(businessAccount)).object.alarm();expect(dispatch.inspect(task.id)[0]).toMatchObject({state:'terminal',outcome:'partial_failed'});expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);expect(g.db.rows('SELECT state FROM business_facts ORDER BY seq').map(r=>r.state)).toEqual(['verified','failed']);
    });
    it.each(['before-commit','lost-ack'])('rebuilds progress after %s and restart without another external write',async mode=>{
        const f=fixture(),{g,config,dispatch,task}=await seed(f,[create]),fetch=network();let block=true;
        const binding=f.env.RELIABILITY_COORDINATOR,originalGet=binding.get.bind(binding);
        binding.get=((id:any)=>{const stub=originalGet(id);return {fetch:async(request:Request)=>{
            const body=await request.clone().json() as any;
            if(body.method==='progress'&&block){if(mode==='lost-ack')await stub.fetch(request);throw new Error('test-only disconnected');}
            return stub.fetch(request);
        }};}) as any;
        await g.object.alarm();const name=accountObjectName(businessAccount),a=f.get(name);await a.object.alarm();
        expect(new AccountQueue(a.db).inspect(task.id).state).toBe('succeeded');expect(dispatch.inspect(task.id)[0].state).toBe('accepted');expect((config.read(['accounts']).records[0].value as any)[0].workers_cmliu.includes('created')).toBe(mode==='lost-ack');
        const calls=fetch.mock.calls.length;block=false;await f.restart(name).object.alarm();expect(dispatch.inspect(task.id)[0].state).toBe('terminal');expect(fetch).toHaveBeenCalledTimes(calls);expect(g.db.rows('SELECT * FROM business_facts')).toHaveLength(1);expect(config.read(['accounts']).records[0].revision).toBe(2);
    });
    it('reports durable unknown on restart without inventing a creation or releasing a permit',async()=>{
        const f=fixture(),{g,config,dispatch,task}=await seed(f,[create]);const fetch=vi.fn(async(_url:string,init?:RequestInit)=>{if(init?.method==='PUT')throw new Error('lost upload');return Response.json({success:false,errors:[{code:10007}]},{status:404});});vi.stubGlobal('fetch',fetch);await g.object.alarm();const name=accountObjectName(businessAccount);await f.get(name).object.alarm();await f.restart(name).object.alarm();
        expect(g.db.rows('SELECT state FROM business_facts').map(r=>r.state)).toEqual(['unknown']);expect(config.read(['accounts']).records[0].revision).toBe(1);expect(dispatch.inspect(task.id)[0].state).toBe('accepted');expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);
    });
});


describe('signed production business admission and cancellation',()=>{
    const upload:BusinessAction={kind:'upload',template:'cmliu',worker:'demo',ref:'latest',overrides:'ignore',echTokenEnabled:false};
    const domain:BusinessAction={kind:'configure_domain',template:'cmliu',worker:'demo',enabled:true,customPrefix:''};
    const intent=(actions:BusinessAction[]=[upload])=>({key:'gateway-intent',targets:[{account:businessAccount,actions}]});
    function network(){
        let script='';
        const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
            if(url.startsWith('https://api.github.com/'))return Response.json({sha:'a'.repeat(40)});
            if(url.startsWith('https://raw.githubusercontent.com/'))return new Response('export default {fetch(){return new Response("gateway-test")}};');
            if(init?.method==='PUT'){script=await ((init.body as FormData).get('script') as File).text();return Response.json({success:true,result:{}});}
            if(url.endsWith('/bindings'))return Response.json({success:true,result:[]});
            return new Response(script);
        });vi.stubGlobal('fetch',fetch);return fetch;
    }
    async function call(f:ReturnType<typeof fixture>,method:'submit_task'|'inspect_task'|'cancel_task'|'list_tasks'|'wake_task',body:Json){
        const response=await f.get(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request(method,f.env.RELIABILITY_MANAGER_ACCOUNT,body));
        return {response,body:await response.json() as any};
    }
    it('uses the real production planner, survives restart and never resolves latest on an accepted retry',async()=>{
        const f=fixture(),{config,dispatch}=await seedConfig(f),fetch=network();
        const first=await call(f,'submit_task',{request:intent()} as unknown as Json);expect(first.response.status).toBe(200);
        const id=first.body.value.id;expect(fetch).toHaveBeenCalledTimes(2);config.setMaintenance(true,2);f.restart(GLOBAL_OBJECT_NAME);
        const again=await call(f,'submit_task',{request:intent()} as unknown as Json);expect(again.body.value).toEqual({id,duplicate:true});expect(fetch).toHaveBeenCalledTimes(2);
        const status=await call(f,'inspect_task',{id});expect(status.body.value.targets[0].steps[0].kind).toBe('upload');expect(JSON.stringify(status.body)).not.toMatch(/snapshot|token|credential|artifact/);
        expect(dispatch.inspect(id)[0].state).toBe('pending');
    });
    it('rejects a correctly signed gateway call under a non-manager account',async()=>{
        const f=fixture(),{g}=await seedConfig(f),fetch=network();
        const response=await g.object.fetch(await f.rpc.request('submit_task',businessAccount,{request:intent()} as unknown as Json));expect(response.status).toBe(403);expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects arbitrary prepared inputs and browser-selected scope',async()=>{
        const f=fixture();await seedConfig(f);const fetch=network();
        for(const body of [{request:{scope:'manager',generation:'g1',expected:[],targets:[]}}, {request:intent(),scope:'attacker'}, {request:{...intent(),handler:'execute'}}]){
            expect((await call(f,'submit_task',body as unknown as Json)).response.status).toBe(400);
        }expect(fetch).not.toHaveBeenCalled();
    });
    it('cancels pending work atomically at account admission and commits skipped facts before release',async()=>{
        const f=fixture(),{g,dispatch}=await seedConfig(f),fetch=network();
        const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;
        expect((await call(f,'cancel_task',{id})).body.value).toEqual({id,cancellationRequested:true});
        await g.object.alarm();const a=f.get(accountObjectName(businessAccount));expect(new AccountQueue(a.db).inspect(id)).toMatchObject({state:'cancelled',cancelRequested:true});
        expect(dispatch.inspect(id)[0].state).toBe('accepted');await a.object.alarm();
        expect(dispatch.inspect(id)[0]).toMatchObject({state:'terminal',outcome:'cancelled'});expect(g.db.rows('SELECT state FROM business_facts')).toEqual([{state:'skipped'}]);
        expect(fetch.mock.calls.some(([url])=>url.startsWith('https://api.cloudflare.com/'))).toBe(false);
        f.restart(GLOBAL_OBJECT_NAME);await f.restart(accountObjectName(businessAccount)).object.alarm();expect((await call(f,'cancel_task',{id})).response.status).toBe(200);
    });
    it('recovers cancelled delivery ACK loss without immutable inbox conflict or external writes',async()=>{
        const f=fixture(),{g,dispatch}=await seedConfig(f),fetch=network();const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;
        const binding=f.env.RELIABILITY_COORDINATOR,original=binding.get.bind(binding);let lose=true;
        binding.get=((id:any)=>{const stub=original(id);return {fetch:async(request:Request)=>{const body=await request.clone().json() as any;const response=await stub.fetch(request);if(body.method==='deliver'&&lose){lose=false;throw new Error('lost delivery ACK');}return response;}};}) as any;
        await g.object.alarm();expect(dispatch.inspect(id)[0].state).toBe('sending');await call(f,'cancel_task',{id});
        await f.restart(GLOBAL_OBJECT_NAME).object.alarm();const a=f.get(accountObjectName(businessAccount));await a.object.alarm();expect(dispatch.inspect(id)[0].outcome).toBe('cancelled');expect(fetch.mock.calls.some(([url])=>url.startsWith('https://api.cloudflare.com/'))).toBe(false);
    });
    it('delivers cancellation of accepted work during maintenance, including after RPC disconnection',async()=>{
        const f=fixture(),{g,config,dispatch}=await seedConfig(f),fetch=network();const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;
        await g.object.alarm();config.setMaintenance(true,2);await call(f,'cancel_task',{id});
        const binding=f.env.RELIABILITY_COORDINATOR,original=binding.get.bind(binding);let block=true;
        binding.get=((id:any)=>{const stub=original(id);return {fetch:async(request:Request)=>{if(block&&(await request.clone().json() as any).method==='cancel')throw new Error('offline');return stub.fetch(request);}};}) as any;
        await g.object.alarm();expect(dispatch.pendingCancels()).toHaveLength(1);expect(dispatch.inspect(id)[0].state).toBe('accepted');block=false;
        await f.restart(GLOBAL_OBJECT_NAME).object.alarm();const a=f.get(accountObjectName(businessAccount));await a.object.alarm();expect(dispatch.inspect(id)[0].outcome).toBe('cancelled');expect(fetch.mock.calls.some(([url])=>url.startsWith('https://api.cloudflare.com/'))).toBe(false);
    });
    it('cancels only later steps after verified work, keeping the actual successful effect',async()=>{
        const f=fixture(),{g,dispatch}=await seedConfig(f),fetch=network();const id=(await call(f,'submit_task',{request:intent([upload,domain])} as unknown as Json)).body.value.id;
        await g.object.alarm();const a=f.get(accountObjectName(businessAccount));await a.object.alarm();await call(f,'cancel_task',{id});await g.object.alarm();await a.object.alarm();
        expect(dispatch.inspect(id)[0].outcome).toBe('partial_cancelled');expect(g.db.rows('SELECT state FROM business_facts ORDER BY seq').map(r=>r.state)).toEqual(['verified','skipped']);expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);expect(fetch.mock.calls.some(([,i])=>i?.method==='POST')).toBe(false);
    });
    it('never unlocks unknown when cancellation is requested',async()=>{
        const f=fixture(),{g,dispatch}=await seedConfig(f),fetch=network();const id=(await call(f,'submit_task',{request:intent([upload,domain])} as unknown as Json)).body.value.id;
        const original=fetch.getMockImplementation()!;fetch.mockImplementation(async(url,init)=>{if(init?.method==='PUT')throw new Error('lost write ACK');return original(url,init);});
        await g.object.alarm();const a=f.get(accountObjectName(businessAccount));await a.object.alarm();await call(f,'cancel_task',{id});await g.object.alarm();await a.object.alarm();
        expect(new AccountQueue(a.db).inspect(id)).toMatchObject({state:'needs_review',cancelRequested:true});expect(dispatch.inspect(id)[0]).toMatchObject({state:'accepted',outcome:null});
        await f.restart(accountObjectName(businessAccount)).object.alarm();expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);
    });
    it('checks cancellation again before the next HTTP mutation inside an in-flight step',async()=>{
        const f=fixture(),{g,dispatch}=await seedConfig(f),fetch=network();const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;
        const original=fetch.getMockImplementation()!;let once=true;fetch.mockImplementation(async(url,init)=>{
            if(url.endsWith('/bindings')&&once){once=false;await call(f,'cancel_task',{id});await g.object.alarm();}
            return original(url,init);
        });
        await g.object.alarm();const a=f.get(accountObjectName(businessAccount));await a.object.alarm();
        expect(new AccountQueue(a.db).inspect(id)).toMatchObject({state:'needs_review',cancelRequested:true});expect(fetch.mock.calls.some(([,i])=>i?.method==='PUT')).toBe(false);expect(dispatch.inspect(id)[0].state).toBe('accepted');
    });
    it('rejects forged cancellation permits without changing a job',async()=>{
        const f=fixture(),{g}=await seedConfig(f);network();const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;await g.object.alarm();const a=f.get(accountObjectName(businessAccount));
        const delivery=JSON.parse(a.db.rows<{delivery:string}>('SELECT delivery FROM coordinator_inbox')[0].delivery);
        const {task,account,snapshot,generation,credentialRevision}=delivery;
        const denied=await a.object.fetch(await f.rpc.request('cancel',businessAccount,{task,account,snapshot,generation,credentialRevision,token:'wrong'}));
        expect(denied.status).toBe(409);expect(new AccountQueue(a.db).inspect(id).cancelRequested).toBe(false);
    });

    it('lists only scoped accepted admissions after reconstruction, including during maintenance',async()=>{
        const f=fixture(),{config}=await seedConfig(f),fetch=network();const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;
        config.setMaintenance(true,2);f.restart(GLOBAL_OBJECT_NAME);const page=await call(f,'list_tasks',{limit:2,cursor:null});
        expect(page.response.status).toBe(200);expect(page.body.value).toMatchObject({items:[{id,state:'queued',terminal:false,trigger:'manual',targets:[{account:businessAccount,state:'pending',outcome:null,cancellationRequested:false,steps:[{ordinal:0,kind:'upload',state:'pending',result:null}]}]}],cursor:null}); expect(page.body.value.items).toHaveLength(1); expect(JSON.stringify(page.body.value)).not.toMatch(/test-token|snapshot|evidence|token/);expect(fetch).toHaveBeenCalledTimes(2);
        expect((await call(f,'list_tasks',{limit:2,cursor:null,scope:'other'})).response.status).toBe(400);
    });
    it('requires manager signature, exact body, ownership and maintenance exit before wake',async()=>{
        const f=fixture(),{g,config,dispatch}=await seedConfig(f);network();const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;
        expect((await g.object.fetch(await f.rpc.request('wake_task',businessAccount,{id}))).status).toBe(403);
        expect((await call(f,'wake_task',{id,reset:true})).response.status).toBe(400);expect((await call(f,'wake_task',{id:'missing'})).response.status).toBe(404);
        config.setMaintenance(true,2);expect((await call(f,'wake_task',{id})).body).toEqual({error:'MAINTENANCE'});expect(dispatch.pendingWakes()).toEqual([]);
        config.setMaintenance(false,3);expect((await call(f,'wake_task',{id})).body.value).toEqual({id,wakeRequested:true});
    });
    it('wakes a parked receipt via original delivery, without repeating a finished HTTP write',async()=>{
        const f=fixture(),{g,dispatch}=await seedConfig(f),fetch=network();const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;
        await g.object.alarm();const name=accountObjectName(businessAccount),a=f.get(name);await a.object.alarm();expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);
        a.db.rows('UPDATE coordinator_alarm SET failures=8 WHERE id=1');a.db.rows('UPDATE coordinator_progress SET acknowledged=0');await a.object.alarm();expect(dispatch.inspect(id)[0].state).toBe('accepted');
        await call(f,'wake_task',{id});f.restart(name);await f.restart(GLOBAL_OBJECT_NAME).object.alarm();await f.get(name).object.alarm();
        expect(dispatch.inspect(id)[0]).toMatchObject({state:'terminal',outcome:'succeeded'});expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);
    });
    it('does not treat wake as reconciliation or a release of unknown permits',async()=>{
        const f=fixture(),{g,dispatch}=await seedConfig(f),fetch=network();const original=fetch.getMockImplementation()!;fetch.mockImplementation(async(url,init)=>{if(init?.method==='PUT')throw new Error('lost response');return original(url,init);});
        const id=(await call(f,'submit_task',{request:intent()} as unknown as Json)).body.value.id;await g.object.alarm();const name=accountObjectName(businessAccount),a=f.get(name);await a.object.alarm();const before=new AccountQueue(a.db).inspect(id);
        await call(f,'wake_task',{id});await g.object.alarm();await f.restart(name).object.alarm();expect(new AccountQueue(a.db).inspect(id)).toEqual(before);expect(dispatch.inspect(id)[0]).toMatchObject({state:'accepted',outcome:null});expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);
    });
});

describe('production role authenticated configuration integration', () => {
    it('reads masked authority and commits/replays edits through the actual production shell', async () => {
        const f = fixture(), { g, config } = await seedConfig(f);
        const call = async (method: any, body: any) => g.object.fetch(await f.rpc.request(method, f.env.RELIABILITY_MANAGER_ACCOUNT, body));
        const read = await call('read_config', { selector: { kind: 'accounts' } });
        expect(read.status).toBe(200); const accountView: any = (await read.json() as any).value;
        expect(accountView.value[0].apiToken).toBe('***'); expect(JSON.stringify(accountView)).not.toMatch(/test-token|v2:/);
        const input = { key: 'save-account', generation: 'g1', epoch: 2, revision: 1, selector: { kind: 'accounts' }, value: accountView.value.map((a: any) => ({ ...a, alias: 'safe-new-name' })) };
        const written = await call('edit_config', { request: input }); expect(written.status).toBe(200);
        f.restart(GLOBAL_OBJECT_NAME);
        const replay: any = await (await call('edit_config', { request: input })).json(); expect(replay.value).toMatchObject({ duplicate: true, revision: 2 });
        expect(config.read(['accounts']).records[0].revision).toBe(2);
        const protectedEdit = await call('edit_config', { request: { ...input, key: 'rotate-secret', revision: 2, value: input.value.map((a: any) => ({ ...a, apiToken: 'changed-token' })) } });
        expect(protectedEdit.status).toBe(409); expect(await protectedEdit.json()).toEqual({ error: 'MAINTENANCE' });
    });
    it('rejects configuration RPC from another manager and physically misaddressed account DOs', async () => {
        const f = fixture(), { g, config } = await seedConfig(f);
        const request = await f.rpc.request('read_config', businessAccount, { selector: { kind: 'accounts' } });
        expect((await g.object.fetch(request)).status).toBe(403);
        const account = f.get(accountObjectName(businessAccount));
        expect((await account.object.fetch(await f.rpc.request('read_config', f.env.RELIABILITY_MANAGER_ACCOUNT, { selector: { kind: 'accounts' } }))).status).toBe(403);
        expect(config.read(['accounts']).records[0].revision).toBe(1);
    });
    it('fails closed for raw patches or uninitialized config without publishing bootstrap', async () => {
        const f = fixture(), g = f.get(GLOBAL_OBJECT_NAME);
        expect((await g.object.fetch(await f.rpc.request('read_config', f.env.RELIABILITY_MANAGER_ACCOUNT, { selector: { kind: 'accounts' } }))).status).toBe(503);
        expect((await g.object.fetch(await f.rpc.request('edit_config', f.env.RELIABILITY_MANAGER_ACCOUNT, { request: {}, handler: 'bootstrap' }))).status).toBe(400);
        expect(Object.getOwnPropertyNames(ProductionCoordinator.prototype).sort()).toEqual(['alarm', 'constructor', 'fetch']);
    });
});

describe('production scheduler-only durable automation wiring',()=>{
 function network(){let script='',bindings:any[]=[];const fetch=vi.fn(async(url:string,init?:RequestInit)=>{if(url.startsWith('https://api.github.com/'))return Response.json({sha:'a'.repeat(40)});if(url.startsWith('https://raw.githubusercontent.com/'))return new Response('export default {fetch(){return new Response("cron-only-test")}};');if(url.endsWith('/graphql'))return Response.json({data:{viewer:{accounts:[{workersInvocationsAdaptive:[{sum:{requests:99000}}],pagesFunctionsInvocationsAdaptiveGroups:[]}]}}});if(url.startsWith('https://qyapi.weixin.qq.com/'))return Response.json({errcode:0});if(init?.method==='PUT'){script=await ((init.body as FormData).get('script') as File).text();bindings=JSON.parse((init.body as FormData).get('metadata') as string).bindings;return Response.json({success:true,result:{}});}if(url.endsWith('/bindings'))return Response.json({success:true,result:bindings});return new Response(script);});vi.stubGlobal('fetch',fetch);return fetch;}
 it('drives a signed cycle through existing account execution and real terminal receipts, not accepted-as-success',async()=>{
  const f=fixture(),{g,config,dispatch}=await seedConfig(f);config.compareAndSet('g1',[{domain:'autoConfig',expectedRevision:0,value:{enabled:true,interval:1,fuseThreshold:90,fuseWebhook:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=local-only'}},{domain:'vars:cmliu',expectedRevision:0,value:[{key:'UUID',value:'old'}]}]);const fetch=network(),scheduledAt=Date.now();
  const first=await g.object.fetch(await f.rpc.request('cron_cycle',f.env.RELIABILITY_MANAGER_ACCOUNT,{scheduledAt}));expect(first.status).toBe(200);const start:any=(await first.json() as any).value,task=start.lanes[0].task;expect(start.lanes[0].state).toBe('running');expect(fetch.mock.calls.some(([u])=>u.startsWith('https://qyapi.'))).toBe(false);
  await g.object.alarm();await f.get(accountObjectName(businessAccount)).object.alarm();await f.get(accountObjectName(businessAccount)).object.alarm();await g.object.alarm();expect(dispatch.inspect(task)[0].state).toBe('terminal');expect(fetch.mock.calls.filter(([u])=>u.startsWith('https://qyapi.'))).toHaveLength(1);
  await f.restart(GLOBAL_OBJECT_NAME).object.alarm();const replay=await f.get(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request('cron_cycle',f.env.RELIABILITY_MANAGER_ACCOUNT,{scheduledAt}));expect((await replay.json() as any).value.lanes[0].task).toBe(task);expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);expect(fetch.mock.calls.filter(([u])=>u.startsWith('https://qyapi.'))).toHaveLength(1);expect(config.read(['autoConfig']).records[0].revision).toBe(1);expect((config.readRuntime().value as any).lastCheck).toBeGreaterThanOrEqual(scheduledAt);
  const catalog=await f.get(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request('list_tasks',f.env.RELIABILITY_MANAGER_ACCOUNT,{limit:20,cursor:null}));const page:any=(await catalog.json() as any).value;expect(page.items).toHaveLength(1);expect(page.items[0]).toMatchObject({id:task,state:'succeeded',terminal:true,trigger:'automation',notification:'delivered',targets:[{steps:[{state:'verified',result:{worker:'demo',scriptVerified:true}}]}]});expect(JSON.stringify(page)).not.toMatch(/test-token|local-only|snapshot|permit/);
  const detail=await f.get(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request('inspect_task',f.env.RELIABILITY_MANAGER_ACCOUNT,{id:task}));expect((await detail.json() as any).value.revision).toMatch(/^[a-f0-9]{64}$/);
  const wake=await f.get(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request('wake_task',f.env.RELIABILITY_MANAGER_ACCOUNT,{id:task}));expect(wake.status).toBe(200);expect(fetch.mock.calls.filter(([,i])=>i?.method==='PUT')).toHaveLength(1);

 });
 it('rejects browser-shaped cron bodies and a scheduler envelope for a different installation',async()=>{const f=fixture(),{g}=await seedConfig(f),fetch=network();for(const body of [{scheduledAt:Date.now(),targets:[]},{scheduledAt:'now'},{scheduledAt:Date.now(),executor:'custom'}]){const res=await g.object.fetch(await f.rpc.request('cron_cycle',f.env.RELIABILITY_MANAGER_ACCOUNT,body as any));expect(res.ok).toBe(false);}const wrong=await g.object.fetch(await f.rpc.request('cron_cycle',businessAccount,{scheduledAt:Date.now()}));expect(wrong.status).toBe(403);expect(fetch).not.toHaveBeenCalled();});
});

it('reads legacy view through the actual signed production shell and consumes revision hints without modifying authority',async()=>{
 const f=fixture(),{g,config}=await seedConfig(f);config.compareAndSet('g1',[{domain:'vars:cmliu',expectedRevision:0,value:[{key:'UUID',value:'local-view'}]}]);const before=config.readAll();const r=await g.object.fetch(await f.rpc.request('read_view',f.env.RELIABILITY_MANAGER_ACCOUNT,{selector:{kind:'init',templates:['cmliu']}}));expect(r.status).toBe(200);const value:any=(await r.json() as any).value;expect(value.data.accounts[0].apiToken).toBe('***');expect(value.revisions['vars:cmliu']).toBe(1);await g.object.alarm();expect(g.db.rows('SELECT * FROM config_outbox WHERE acknowledged=0')).toHaveLength(0);expect(config.readAll()).toEqual(before);const wrong=await g.object.fetch(await f.rpc.request('read_view',businessAccount,{selector:{kind:'journal'}}));expect(wrong.status).toBe(403);
});

it('uses actual production shell read_external with current credentials, no tasks, scoped signatures and restart-stable views',async()=>{const f=fixture(),{g,config,dispatch}=await seedConfig(f),before=config.readAll();const fetch=vi.fn(async(_u:string,init?:RequestInit)=>{expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token-never-production');expect(init?.redirect).toBe('manual');return Response.json({success:true,result:[{id:'demo',modified_on:'2026-10-01T00:00:00Z'}]});});vi.stubGlobal('fetch',fetch);const request={kind:'workers',account:businessAccount};const r=await g.object.fetch(await f.rpc.request('read_external',f.env.RELIABILITY_MANAGER_ACCOUNT,{request}));expect(r.status).toBe(200);const result:any=(await r.json() as any).value;expect(result.data.workers[0].id).toBe('demo');expect(JSON.stringify(result)).not.toContain('test-token-never-production');const next=await f.restart(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request('read_external',f.env.RELIABILITY_MANAGER_ACCOUNT,{request}));expect((await next.json() as any).value).toEqual(result);expect(config.readAll()).toEqual(before);expect(g.db.rows('SELECT id FROM dispatch_tasks')).toHaveLength(0);expect(()=>dispatch.inspect('absent')).toThrow('NOT_READY');const wrong=await g.object.fetch(await f.rpc.request('read_external',businessAccount,{request}));expect(wrong.status).toBe(403);const accountObject=f.get(accountObjectName(businessAccount));expect((await accountObject.object.fetch(await f.rpc.request('read_external',f.env.RELIABILITY_MANAGER_ACCOUNT,{request}))).status).toBe(403);expect(fetch).toHaveBeenCalledTimes(2);});

it('archives the actual production global schema without omitting an unclassified state table',async()=>{const f=fixture(),seed=await seedConfig(f);await f.get(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request('read_config',f.env.RELIABILITY_MANAGER_ACCOUNT,{selector:{kind:'accounts'}}));const global=f.get(GLOBAL_OBJECT_NAME);const archive=new AuthorityArchive(global.db,new SealedStore(global.db,f.settings.snapshots),'test_manager',{role:'global'});await archive.create('prod-schema','g1',2);expect(archive.inspect('prod-schema')).toMatchObject({state:'ready',migrationReady:false});const root=await archive.rootPacket('prod-schema'),m:any=await new SealedStore(global.db,f.settings.snapshots).openPacket({id:'backup_prod-schema_root',kind:'config_backup',account:'archive_global',generation:'g1'},root);expect(m.tables.map((t:any)=>t.name)).toEqual(expect.arrayContaining(['business_admissions','deployment_runs','credential_policy','config_edit_receipts','automation_flows','webhook_outbox']));expect(seed.config.status().generation).toBe('g1');});

describe('independent production unknown observation',()=>{
 it('uses an independently authorized maintenance command across real production roles and preserves unknown on restart',async()=>{
  const f=fixture(),secret='c'.repeat(64),reader='d'.repeat(64);
  f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{reviewer:{secret,permissions:['review']},reader:{secret:reader,permissions:['inspect']}}});
  const {g,config,dispatch,task}=await seed(f,[{kind:'create_worker',template:'cmliu',worker:'created',ref:'latest',variables:[],namespaceTitle:'',echTokenEnabled:false}]);
  let observing=false;const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
   if(init?.method==='PUT')throw new Error('lost upload response');
   if(!observing)return Response.json({success:false,errors:[{code:10007}]},{status:404});
   if(url.endsWith('/bindings'))return Response.json({success:true,result:[{name:'SECRET',type:'secret_text'}]});
   if(url.endsWith('/subdomain'))return Response.json({success:true,result:{enabled:true,previews_enabled:false}});
   return new Response('export default {}',{headers:{'Content-Type':'application/javascript'}});
  });vi.stubGlobal('fetch',fetch);
  await g.object.alarm();const name=accountObjectName(businessAccount),a=f.get(name);await a.object.alarm();
  const before=new AccountQueue(a.db).inspect(task.id);expect(before.state).toBe('needs_review');
  const call=a.db.rows<{ordinal:number}>('SELECT ordinal FROM execution_calls WHERE mutation=1')[0].ordinal;
  config.setMaintenance(true,2);observing=true;
  const cmd={id:'review-production',action:'review_observe' as const,expected:{...config.status()},args:{task:task.id,account:businessAccount,step:0,call}};
  const send=async(command=cmd,operator='reviewer',key=secret)=>f.get(GLOBAL_OBJECT_NAME).object.fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signMaintenance({version:1,target:{account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE},operator,at:Date.now(),nonce:crypto.randomUUID(),command},key))}));
  const callsBefore=fetch.mock.calls.length;
  const inbox=JSON.parse(a.db.rows<{delivery:string}>('SELECT delivery FROM coordinator_inbox WHERE task=?',task.id)[0].delivery);
  const permit={task:inbox.task,account:inbox.account,generation:inbox.generation,snapshot:inbox.snapshot,token:inbox.token,credentialRevision:inbox.credentialRevision};
  const forged={id:'unsigned-review-grant',operator:'reviewer',permit,epoch:config.status().epoch,accountsRevision:config.read(['accounts']).records[0].revision,step:0,call};
  const denied=await a.object.fetch(await f.rpc.request('review_observe',businessAccount,forged));
  expect(denied.status).toBe(403);expect(fetch).toHaveBeenCalledTimes(callsBefore);
  expect((await send(cmd,'reader',reader)).status).toBe(403);expect(fetch).toHaveBeenCalledTimes(callsBefore);
  const response=await send();expect(response.status).toBe(200);const result:any=(await response.json() as any).value;
  expect(result).toMatchObject({state:'observed',settled:false,possibleInFlight:true,secretBindingsVerified:false});expect(result.reads[0].resourceState).toBe('present');
  expect(fetch).toHaveBeenCalledTimes(callsBefore+3);expect(fetch.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1);
  expect(new AccountQueue(a.db).inspect(task.id)).toEqual(before);expect(dispatch.inspect(task.id)[0]).toMatchObject({state:'accepted',outcome:null});
  expect(JSON.stringify(result)).not.toContain('test-token-never-production');
  f.restart(name);f.restart(GLOBAL_OBJECT_NAME);expect((await (await send()).json() as any).value).toEqual(result);expect(fetch).toHaveBeenCalledTimes(callsBefore+3);
  for(const patch of [{operator:'reader'},{call:call+1},{step:1}]){
   const response=await f.get(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request('authorize_review',businessAccount,{request:{...forged,id:cmd.id,...patch}}));expect(response.status).toBe(403);
  }
  f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{reviewer:{secret,permissions:['inspect']}}});f.restart(GLOBAL_OBJECT_NAME);
  expect((await f.get(GLOBAL_OBJECT_NAME).object.fetch(await f.rpc.request('authorize_review',businessAccount,{request:{...forged,id:cmd.id}}))).status).toBe(403);
  f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{reviewer:{secret,permissions:['review']},reader:{secret:reader,permissions:['inspect']}}});f.restart(GLOBAL_OBJECT_NAME);
  const authority=new CredentialAuthority(g.db,config,dispatch,f.settings.credentials);authority.revoke('g1',businessAccount,1);
  expect((await send({...cmd,id:'review-revoked'})).status).toBe(409);expect(fetch).toHaveBeenCalledTimes(callsBefore+3);expect(dispatch.inspect(task.id)[0].state).toBe('accepted');
 });
});

it('recovers an orphaned task backfill through independently signed maintenance without planning or external calls',async()=>{
 const f=fixture(),secret='c'.repeat(64),reader='d'.repeat(64);f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{ops:{secret,permissions:['recover']},reader:{secret:reader,permissions:['inspect']}}});
 const {g,config,dispatch}=await seedConfig(f),fetch=vi.fn(async()=>{throw new Error('No external request allowed');});vi.stubGlobal('fetch',fetch);
 const rows=g.db.rows.bind(g.db);let fail=true;vi.spyOn(g.db,'rows').mockImplementation((q,...p)=>{if(fail&&q.startsWith('UPDATE business_admissions SET task=')){fail=false;throw new Error('lost backfill ACK');}return rows(q,...p);});
 const request={key:'maintenance-orphan',targets:[{account:businessAccount,actions:[{kind:'delete_worker',template:'cmliu',worker:'demo'}]}]};
 expect((await g.object.fetch(await f.rpc.request('submit_task',f.env.RELIABILITY_MANAGER_ACCOUNT,{request}))).status).toBe(503);
 const orphan=g.db.rows<{id:string}>('SELECT id FROM business_admissions WHERE task IS NULL')[0].id,task=g.db.rows<{id:string}>('SELECT id FROM dispatch_tasks')[0].id;config.setMaintenance(true,2);
 const call=async(command:any,operator='ops',key=secret)=>f.get(GLOBAL_OBJECT_NAME).object.fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signMaintenance({version:1,target:{account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE},operator,at:Date.now(),nonce:crypto.randomUUID(),command},key))}));
 const listing={id:'orphan-list',action:'admission_list',expected:null,args:{limit:10,cursor:null}};
 const page=await call(listing,'reader',reader);expect(page.status).toBe(200);expect((await page.json() as any).value.items[0].id).toBe(orphan);
 const recovery={id:'orphan-recover',action:'admission_recover',expected:{...config.status()},args:{id:orphan}};
 expect((await call(recovery,'reader',reader)).status).toBe(403);f.restart(GLOBAL_OBJECT_NAME);
 const result=await call(recovery);expect(result.status).toBe(200);expect((await result.json() as any).value).toEqual({id:task,duplicate:true});
 expect(g.db.rows('SELECT id FROM dispatch_tasks')).toHaveLength(1);expect(g.db.rows<{task:string}>('SELECT task FROM business_admissions')[0].task).toBe(task);expect(dispatch.inspect(task)[0].state).toBe('pending');expect(fetch).not.toHaveBeenCalled();
 f.restart(GLOBAL_OBJECT_NAME);expect((await (await call(recovery)).json() as any).value).toEqual({id:task,duplicate:true});expect(fetch).not.toHaveBeenCalled();
});

it('archives and transfers encrypted packets through independent production maintenance without recursive audit payloads',async()=>{
 const f=fixture(),secret='c'.repeat(64),reader='d'.repeat(64);f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{ops:{secret,permissions:['archive']},reader:{secret:reader,permissions:['inspect']}}});const {g,config}=await seedConfig(f);config.setMaintenance(true,2);
 const call=async(command:any,operator='ops',key=secret)=>f.get(GLOBAL_OBJECT_NAME).object.fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signMaintenance({version:1,target:{account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE},operator,at:Date.now(),nonce:crypto.randomUUID(),command},key))}));
 const create={id:'archive-command',action:'archive_create',expected:{...config.status()},args:{id:'backup-prod'}};expect((await call(create,'reader',reader)).status).toBe(403);const created=await call(create);expect(created.status).toBe(200);expect((await created.json() as any).value).toMatchObject({state:'ready',migrationReady:false});
 const start=await call({id:'export-start',action:'archive_export_begin',expected:null,args:{id:'export1',archive:'backup-prod',part:null}});expect(start.status).toBe(200);const descriptor=(await start.json() as any).value.descriptor;
 const command={id:'frame0',action:'archive_export_frame',expected:null,args:{id:'export1',ordinal:0}},frame=(await (await call(command)).json() as any).value;expect(frame.data.length).toBeLessThanOrEqual(4096);expect(JSON.stringify(frame)).not.toContain('test-token-never-production');
 const audit=g.db.rows<{result:string}>('SELECT result FROM maintenance_receipts WHERE id=?','frame0')[0];expect(audit.result).not.toContain(frame.data);expect(JSON.parse(audit.result).archiveFrame.digest).toBe(frame.digest);
 f.restart(GLOBAL_OBJECT_NAME);expect((await (await call(command)).json() as any).value).toEqual(frame);
 const expected={...config.status()},begin={id:'import-start',action:'archive_import_begin',expected,args:{descriptor:{...descriptor,id:'import1'}}};expect((await call(begin)).status).toBe(200);
 for(let ordinal=0;ordinal<descriptor.frames;ordinal++){const read=ordinal===0?frame:(await (await call({id:'frame'+ordinal,action:'archive_export_frame',expected:null,args:{id:'export1',ordinal}})).json() as any).value;const result=await call({id:'put'+ordinal,action:'archive_import_frame',expected,args:{id:'import1',ordinal,data:read.data}});expect(result.status).toBe(200);const stored=g.db.rows<{intent:string}>('SELECT intent FROM maintenance_receipts WHERE id=?','put'+ordinal)[0].intent;expect(stored).not.toContain(read.data);expect(JSON.parse(stored).command.args.data).toMatch(/^hmac:[a-f0-9]{64}$/);}
 const commit=await call({id:'import-commit',action:'archive_import_commit',expected,args:{id:'import1'}});expect(commit.status).toBe(200);expect((await commit.json() as any).value).toMatchObject({state:'complete',migrationReady:false});expect(config.status()).toEqual(expected);
});

it('drives archive-backed generation migration and atomic activation audit through actual production maintenance roles',async()=>{
 const f=fixture(),secret='c'.repeat(64);f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{ops:{secret,permissions:['archive','migrate','activate','drain','inspect']}}});const {g,config}=await seedConfig(f);config.recordRuntime('before_migration',{lastCheck:123,lastGc:100});config.setMaintenance(true,2);
 const call=async(command:any)=>f.get(GLOBAL_OBJECT_NAME).object.fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signMaintenance({version:1,target:{account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE},operator:'ops',at:Date.now(),nonce:crypto.randomUUID(),command},secret))}));
 const expected={...config.status()};expect((await call({id:'gen-backup',action:'archive_create',expected,args:{id:'before-migration'}})).status).toBe(200);
 const begin=await call({id:'gen-begin',action:'generation_begin',expected,args:{id:'move',target:'g2',source:'before-migration',credentials:'migrate'}});expect(begin.status).toBe(200);
 const stage=await call({id:'gen-resume',action:'generation_resume',expected,args:{id:'move',limit:100}});expect(stage.status).toBe(200);expect((await stage.json() as any).value.state).toBe('verified');expect(config.status().generation).toBe('g1');
 const activate={id:'gen-activate',action:'generation_activate',expected,args:{importId:'move',drainId:'gen-drain'}};expect((await call(activate)).status).toBe(503);expect(config.status().generation).toBe('g1');
 expect((await call({id:'gen-drain-begin',action:'drain_begin',expected,args:{id:'gen-drain'}})).status).toBe(200);expect((await call({id:'gen-drain-advance',action:'drain_advance',expected,args:{id:'gen-drain',limit:100}})).status).toBe(200);
 const result=await call(activate);expect(result.status).toBe(200);const receipt=(await result.json() as any).value;expect(receipt).toMatchObject({generation:'g2',epoch:4,legacyCutover:false,maintenance:true});expect(config.status()).toEqual({generation:'g2',epoch:4,maintenance:1});
 const stored=g.db.rows<{result:string;state:string}>('SELECT result,state FROM maintenance_receipts WHERE id=?','gen-activate')[0];expect(stored.state).toBe('complete');expect(JSON.parse(stored.result)).toEqual(receipt);expect(config.readRuntime().value).toEqual({lastCheck:123,lastGc:100});
 f.restart(GLOBAL_OBJECT_NAME);expect((await (await call(activate)).json() as any).value).toEqual(receipt);expect(g.db.rows('SELECT * FROM generation_activations')).toHaveLength(1);expect(g.db.rows('SELECT * FROM credential_policy')).toHaveLength(2);
});

it('archives physical account DOs only under a durable independent archive grant, with retained enumeration and bounded frames',async()=>{
 const f=fixture(),secret='c'.repeat(64),reader='d'.repeat(64);f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{ops:{secret,permissions:['archive']},reader:{secret:reader,permissions:['inspect']}}});const {g,config,dispatch}=await seedConfig(f);config.setMaintenance(true,2);
 const target={account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE};
 const msg=(command:any,operator='ops')=>({version:1 as const,target,operator,at:Date.now(),nonce:crypto.randomUUID(),command});
 const call=async(command:any,operator='ops',key=secret)=>f.get(GLOBAL_OBJECT_NAME).object.fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signMaintenance(msg(command,operator),key))}));
 const list={id:'accounts-list',action:'archive_accounts',expected:null,args:{after:null,limit:10,digest:null}};
 expect((await call(list,'reader',reader)).status).toBe(403);const listed=await call(list);expect(listed.status).toBe(200);expect((await listed.json() as any).value.items).toEqual([businessAccount]);
 const command={id:'account-backup',action:'account_archive',expected:{...config.status()},args:{account:businessAccount,action:'archive_create',args:{id:'account-snapshot'}}};
 const account=f.get(accountObjectName(businessAccount));const forged=await account.object.fetch(await f.rpc.request('account_archive',businessAccount,{message:msg({...command,id:'forged'})}));expect(forged.status).toBe(403);expect(account.db.rows("SELECT name FROM sqlite_master WHERE name='authority_archives'")).toEqual([]);
 const created=await call(command);expect(created.status).toBe(200);expect((await created.json() as any).value).toMatchObject({state:'ready',scope:'one_durable_object',migrationReady:false});
 expect(g.db.rows('SELECT account FROM account_archive_registry')).toEqual([{account:businessAccount}]);
 const begin={id:'account-export',action:'account_archive',expected:null,args:{account:businessAccount,action:'archive_export_begin',args:{id:'account-transfer',archive:'account-snapshot',part:null}}};const exported=await call(begin);expect(exported.status).toBe(200);const descriptor=(await exported.json() as any).value.descriptor;
 const frameCommand={id:'account-frame',action:'account_archive',expected:null,args:{account:businessAccount,action:'archive_export_frame',args:{id:'account-transfer',ordinal:0}}};const frame=(await (await call(frameCommand)).json() as any).value;expect(frame.data.length).toBeLessThanOrEqual(4096);expect(g.db.rows<{result:string}>('SELECT result FROM maintenance_receipts WHERE id=?','account-frame')[0].result).not.toContain(frame.data);
 f.restart(GLOBAL_OBJECT_NAME);f.restart(accountObjectName(businessAccount));expect((await (await call(frameCommand)).json() as any).value).toEqual(frame);
 const beforeQueue=account.db.rows('SELECT * FROM account_jobs'),expected={...config.status()};
 expect((await call({id:'account-import',action:'account_archive',expected,args:{account:businessAccount,action:'archive_import_begin',args:{descriptor:{...descriptor,id:'account-import-transfer'}}}})).status).toBe(200);
 for(let ordinal=0;ordinal<descriptor.frames;ordinal++){const read=(await (await call({...frameCommand,id:'account-read-'+ordinal,args:{...frameCommand.args,args:{id:'account-transfer',ordinal}}})).json() as any).value;const command={id:'account-put-'+ordinal,action:'account_archive',expected,args:{account:businessAccount,action:'archive_import_frame',args:{id:'account-import-transfer',ordinal,data:read.data}}};const response=await call(command);expect(response.status).toBe(200);const intent=g.db.rows<{intent:string}>('SELECT intent FROM maintenance_receipts WHERE id=?',command.id)[0].intent;expect(intent).not.toContain(read.data);expect(JSON.parse(intent).command.args.args.data).toMatch(/^hmac:/);}
 expect((await call({id:'account-commit',action:'account_archive',expected,args:{account:businessAccount,action:'archive_import_commit',args:{id:'account-import-transfer'}}})).status).toBe(200);
 expect(account.db.rows('SELECT * FROM account_jobs')).toEqual(beforeQueue);expect(account.db.rows("SELECT name FROM sqlite_master WHERE name='config_meta'")).toEqual([]);

 g.db.rows('UPDATE config_records SET payload=? WHERE generation=? AND domain=?','[]','g1','accounts');expect((await (await call({...list,id:'retained-list'})).json() as any).value.items).toEqual([businessAccount]);
 expect((await call({...command,id:'unknown-account',args:{...command.args,account:'b'.repeat(32)}})).status).toBe(404);
 await dispatch.submit({scope:'archive-history',key:'history1',targets:[{account:'b'.repeat(32),snapshot:'history-snapshot',steps:['upload']}]});
 const first=(await (await call({id:'page-start',action:'archive_accounts',expected:null,args:{after:null,limit:1,digest:null}})).json() as any).value;expect(first.items).toEqual(['b'.repeat(32)]);
 const page={id:'page-end',action:'archive_accounts',expected:null,args:{after:first.after,limit:1,digest:first.digest}};expect((await (await call(page)).json() as any).value.items).toEqual([businessAccount]);
 await dispatch.submit({scope:'archive-history',key:'history2',targets:[{account:'c'.repeat(32),snapshot:'history-snapshot2',steps:['upload']}]});expect((await call({...page,id:'page-drift'})).status).toBe(409);
 f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{ops:{secret,permissions:['inspect']}}});f.restart(GLOBAL_OBJECT_NAME);
 const denied=await f.get(accountObjectName(businessAccount)).object.fetch(await f.rpc.request('account_archive',businessAccount,{message:msg(frameCommand)}));expect(denied.status).toBe(403);
});

 it('binds actual production attestation and failure approval to independent durable commands, not RPC authority',async()=>{
 const f=fixture(),observer='c'.repeat(64),attestor='d'.repeat(64),reviewer='e'.repeat(64),inspector='f'.repeat(64);f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{observer:{secret:observer,permissions:['review']},attestor:{secret:attestor,permissions:['attest']},reviewer:{secret:reviewer,permissions:['adjudicate']},inspector:{secret:inspector,permissions:['inspect']}}});
 const {g,config,dispatch,task}=await seed(f,[{kind:'create_worker',template:'cmliu',worker:'created',ref:'latest',variables:[],namespaceTitle:'',echTokenEnabled:false}]);let observing=false;const fetch=vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='PUT')throw Error('lost upload ACK');if(!observing)return Response.json({success:false,errors:[{code:10007}]},{status:404});if(url.endsWith('/bindings'))return Response.json({success:true,result:[]});if(url.endsWith('/subdomain'))return Response.json({success:true,result:{enabled:true,previews_enabled:false}});return new Response('export default {}',{headers:{'Content-Type':'application/javascript'}});});vi.stubGlobal('fetch',fetch);await g.object.alarm();const name=accountObjectName(businessAccount),a=f.get(name);await a.object.alarm();const call=a.db.rows<{ordinal:number}>('SELECT ordinal FROM execution_calls WHERE mutation=1')[0].ordinal;config.setMaintenance(true,2);observing=true;
 const send=async(command:any,operator:string,key:string)=>f.get(GLOBAL_OBJECT_NAME).object.fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signMaintenance({version:1,target:{account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE},operator,at:Date.now(),nonce:crypto.randomUUID(),command},key))}));
 const candidateCommand={id:'candidate-page',action:'review_candidates',expected:null,args:{task:task.id,account:businessAccount,after:null,limit:20}};expect((await send(candidateCommand,'observer',observer)).status).toBe(403);const candidatesResponse=await send(candidateCommand,'inspector',inspector);expect(candidatesResponse.status).toBe(200);const candidates=(await candidatesResponse.json() as any).value;expect(candidates).toMatchObject({state:'needs_review',settlementProven:false,missingEvidence:false});expect(candidates.items[0]).toMatchObject({step:0,call,eligibleAtCapture:true,callState:'unknown'});expect(JSON.stringify(candidates)).not.toMatch(/test-token-never-production|"snapshot":|"credentialRevision":|"permit":|Authorization/);const candidateTail=await send({...candidateCommand,id:'candidate-tail',args:{...candidateCommand.args,after:candidates.items[0].position}},'inspector',inspector);expect((await candidateTail.json() as any).value.items).toEqual([]);
 const selector={task:task.id,account:businessAccount,step:0,call},observed=await send({id:'observe-for-adjudication',action:'review_observe',expected:{...config.status()},args:selector},'observer',observer);expect(observed.status).toBe(200);const result=(await observed.json() as any).value;
 const attest={id:'attest-production',action:'review_attest',expected:{...config.status()},args:{...selector,observation:'observe-for-adjudication',evidence:result.evidence,statement:'provider_confirmed_terminal',reference:'private-provider-case-reference',document:'Private evidence attachment: provider confirmed the exact original operation terminal.'}};
 expect((await send(attest,'reviewer',reviewer)).status).toBe(403);const ar=await send(attest,'attestor',attestor);expect(ar.status).toBe(200);const att=(await ar.json() as any).value;expect(att).toMatchObject({approved:false,machineVerified:false});expect(new AccountQueue(a.db).inspect(task.id).state).toBe('needs_review');
 const originalDelivery=JSON.parse(a.db.rows<{delivery:string}>('SELECT delivery FROM coordinator_inbox WHERE task=?',task.id)[0].delivery),manualPermit={task:originalDelivery.task,account:originalDelivery.account,token:originalDelivery.token,snapshot:originalDelivery.snapshot,generation:originalDelivery.generation,credentialRevision:originalDelivery.credentialRevision};const forgedFact=await g.object.fetch(await f.rpc.request('progress',businessAccount,{permit:manualPermit,facts:[{ordinal:0,kind:'create_worker',state:'failed',evidence:'a'.repeat(64),result:{kind:'create_worker',code:'OPERATOR_CLOSED_UNCONFIRMED',adjudication:'not-authorized'}}]}));expect(forgedFact.status).toBe(409);
 const decision={id:'close-production',action:'review_close_failed',expected:{...config.status()},args:{...selector,attestation:attest.id,proof:att.proof}};expect((await send(decision,'attestor',attestor)).status).toBe(403);const originalRows=g.db.rows.bind(g.db);let loseDecision=true;vi.spyOn(g.db,'rows').mockImplementation((q,...p)=>{if(loseDecision&&q.startsWith("UPDATE maintenance_receipts SET state='complete'")&&p.at(-1)===decision.id){loseDecision=false;throw Error('lost outer decision ACK');}return originalRows(q,...p);});const approved=await send(decision,'reviewer',reviewer);expect(approved.status).toBe(503);const receipt=JSON.parse(a.db.rows<{summary:string}>('SELECT summary FROM unknown_adjudications WHERE id=?',decision.id)[0].summary);expect(receipt).toMatchObject({outcome:'failed',code:'OPERATOR_CLOSED_UNCONFIRMED',externalSuccessClaimed:false});expect(new AccountQueue(a.db).inspect(task.id).state).toBe('failed');
 const auditPage=await send({id:'audit-production',action:'audit_list',expected:null,args:{limit:50,cursor:null}},'inspector',inspector);expect(auditPage.status).toBe(200);const audits=(await auditPage.json() as any).value;expect(audits.items.some((r:any)=>r.action==='review_attest')).toBe(true);expect(JSON.stringify(audits)).not.toMatch(/private-provider-case-reference|Private evidence attachment|"permit":|"snapshot":/);
 expect(JSON.stringify(g.db.rows('SELECT * FROM maintenance_receipts'))).not.toMatch(/private-provider-case-reference|Private evidence attachment/);expect(JSON.stringify(g.db.rows('SELECT * FROM maintenance_attempts'))).not.toMatch(/private-provider-case-reference|Private evidence attachment/);expect(fetch.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1);expect(dispatch.inspect(task.id)[0].state).toBe('accepted');
 await a.object.alarm();expect(dispatch.inspect(task.id)[0]).toMatchObject({state:'terminal',outcome:'failed'});expect(g.db.rows<{state:string}>('SELECT state FROM business_step_state WHERE task=?',task.id)[0].state).toBe('failed');expect(g.db.rows<{payload:string}>("SELECT payload FROM business_facts WHERE task=? AND state='failed'",task.id)[0].payload).toContain('OPERATOR_CLOSED_UNCONFIRMED');config.setMaintenance(false,3);config.setMaintenance(true,4);
 f.restart(name);f.restart(GLOBAL_OBJECT_NAME);expect((await (await send(decision,'reviewer',reviewer)).json() as any).value).toEqual(receipt);
 const drain=new AuthorityDrain(g.db,config,async(method,account,body)=>{const response=await f.get(accountObjectName(account)).object.fetch(await f.rpc.request(method,account,body));const payload=await response.json() as any;if(!response.ok)throw Error(payload.error);return payload.value;});drain.begin('manual-drain');await drain.advance('manual-drain',100);expect(drain.inspect('manual-drain')).toMatchObject({state:'ready',probed:1});expect(JSON.parse(g.db.rows<{payload:string}>('SELECT payload FROM authority_drain_accounts WHERE drain=?','manual-drain')[0].payload)).toMatchObject({humanSettlements:1,blockers:{mutations:0}});expect(a.db.rows<{state:string}>('SELECT state FROM execution_calls WHERE mutation=1')[0].state).toBe('unknown');
 const ga=new AuthorityArchive(g.db,new SealedStore(g.db,f.settings.snapshots),'adjudication_bundle',{role:'global'}),aa=new AuthorityArchive(a.db,new SealedStore(a.db,f.settings.snapshots),'adjudication_bundle',{role:'account',account:businessAccount});await ga.create('global_manual','g1',5);await aa.create('account_manual','g1',5);const bundle=await verifyArchiveBundle({archive:ga,id:'global_manual'},'manual-drain',[{archive:aa,id:'account_manual'}]);expect(bundle.manifest.accounts[0]).toMatchObject({humanSettlements:1});const reportRow=g.db.rows<{payload:string}>('SELECT payload FROM authority_drain_accounts WHERE drain=?','manual-drain')[0];g.db.rows('UPDATE authority_drain_accounts SET payload=? WHERE drain=?',canonical({...JSON.parse(reportRow.payload),humanSettlements:2}),'manual-drain');await ga.create('wrong_human_count','g1',5);await expect(verifyArchiveBundle({archive:ga,id:'wrong_human_count'},'manual-drain',[{archive:aa,id:'account_manual'}])).rejects.toThrow('CONFLICT');
 a.db.rows("UPDATE unknown_attestations SET operator='forged'");const deniedDrain=await f.get(name).object.fetch(await f.rpc.request('probe_drain',businessAccount,{id:'another-drain',generation:'g1',epoch:5,challenge:'another-challenge'}));expect(deniedDrain.status).not.toBe(200);

 const denied=await f.get(name).object.fetch(await f.rpc.request('adjudicate',businessAccount,{message:{version:1,target:{account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE},operator:'reviewer',at:Date.now(),nonce:'forged',command:{...decision,id:'rpc-only'}},observation:{id:'observe-for-adjudication',operator:'observer',permit:{task:task.id,account:businessAccount,generation:'g1',snapshot:'fake',token:'fake',credentialRevision:1},epoch:3,accountsRevision:1,step:0,call}}));expect(denied.status).toBe(403);
 });


it('uses the actual production initial-source actions, distinct roles, pinned database identity and durable original activation ACK',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(10000);const f=fixture();f.env.ACCESS_CODE='local-retained-production-test';const oldCipher=await encryptInitialTestKey({ACCESS_CODE:f.env.ACCESS_CODE} as any,'local-only-initial-token'),source=await initialCutoverFixture(opened,undefined,{ACCOUNTS_UNIFIED_STORAGE:JSON.stringify([{accountId:businessAccount,alias:'local initial',email:'',globalKey:'',apiToken:oldCipher,authMode:'token',workers_cmliu:['one']}])}),inspectKey='c'.repeat(64),migrateKey='d'.repeat(64),activateKey='e'.repeat(64);
 f.env.RELIABILITY_MAINTENANCE_KEYS=canonical({operators:{inspector:{secret:inspectKey,permissions:['inspect']},importer:{secret:migrateKey,permissions:['migrate']},activator:{secret:activateKey,permissions:['activate']}}});
 const target={account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE};
 const call=async(command:any,operator='importer',key=migrateKey,name=GLOBAL_OBJECT_NAME)=>f.get(name).object.fetch(new Request('https://maintenance.internal/v1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signMaintenance({version:1,target,operator,at:Date.now(),nonce:crypto.randomUUID(),command},key))}));
 const identity=(await (await call({id:'initial-identity',action:'initial_identity',args:{},expected:null},'inspector',inspectKey)).json() as any).value;expect(identity).toMatchObject({target,sourceAnchorConfigured:false,generation:null,maintenance:1});
 const expected={generation:null,epoch:0,maintenance:1},begin={id:'production-source-begin',action:'initial_source_begin',args:{id:'source1'},expected};expect((await call(begin)).status).toBe(503);expect((await call(begin,'inspector',inspectKey)).status).toBe(403);
 const pin={...source.rawPin,installation:identity.installation,legacyKeySource:'retained_ACCESS_CODE' as const};f.env.RELIABILITY_INITIAL_CUTOVER_PIN=canonical(pin);f.restart(GLOBAL_OBJECT_NAME);
 expect((await call(begin)).status).toBe(200);for(const [ordinal,data]of source.frames.entries())expect((await call({id:'production-source-frame-'+ordinal,action:'initial_source_frame',args:{id:'source1',ordinal,data},expected})).status).toBe(200);
 expect((await call({id:'production-source-commit',action:'initial_source_commit',args:{id:'source1'},expected})).status).toBe(200);
 expect((await call({id:'production-import-begin',action:'initial_import_begin',args:{},expected})).status).toBe(200);expect((await call({id:'production-import-resume',action:'initial_import_resume',args:{limit:100},expected})).status).toBe(200);
 const activate={id:'production-initial-activate',action:'initial_activate',args:{},expected};expect((await call(activate)).status).toBe(403);expect((await call(activate,'activator',activateKey,accountObjectName(businessAccount))).status).toBe(403);
 const response=await call(activate,'activator',activateKey);expect(response.status).toBe(200);const original=(await response.json() as any).value;expect(original).toMatchObject({generation:'g1',maintenance:true,scope:'initial_authority'});const g=f.get(GLOBAL_OBJECT_NAME);expect(new ConfigStore(g.db).status()).toEqual({generation:'g1',maintenance:1,epoch:1});
 expect(productionConfig(f.env).credentials.legacySecret).toBeUndefined();expect(g.db.rows('SELECT state FROM initial_cutover_proofs')).toEqual([{state:'consumed'}]);expect(JSON.stringify(g.db.rows('SELECT * FROM maintenance_receipts'))).not.toContain(source.frames[0]);
 vi.mocked(Date.now).mockReturnValue(90000);f.restart(GLOBAL_OBJECT_NAME);expect((await (await call(activate,'activator',activateKey)).json() as any).value).toEqual(original);expect(g.db.rows('SELECT * FROM initial_generation_activations')).toHaveLength(1);
 expect((await call({...activate,id:'production-other-activate'},'activator',activateKey)).status).toBe(409);expect((await call({id:'read-initial-ack',action:'initial_activation_inspect',args:{id:activate.id},expected:null},'inspector',inspectKey)).status).toBe(200);
});


describe('production GitHub credential wiring without snapshot leakage',()=>{
 it.each(['manual','cron'])('uses retained GITHUB_TOKEN only for GitHub API in the %s source planner',async kind=>{
  const token='MOCK_GITHUB_TOKEN_ONLY_FOR_SOURCE_API',f=fixture();f.env.GITHUB_TOKEN=token;const {g,config,sealed}=await seedConfig(f);
  const network=vi.fn(async(url:string,init?:RequestInit)=>{
   const authorization=new Headers(init?.headers).get('authorization');
   if(url.startsWith('https://api.github.com/')){expect(authorization).toBe('Bearer '+token);return Response.json({sha:'a'.repeat(40)});}
   if(url.startsWith('https://raw.githubusercontent.com/')){expect(authorization).toBeNull();return new Response('export default {fetch(){return new Response("token-source-test")}};');}
   throw Error('No provider business mutation allowed during source admission');
  });vi.stubGlobal('fetch',network);
  let response:Response;
  if(kind==='manual')response=await g.object.fetch(await f.rpc.request('submit_task',f.env.RELIABILITY_MANAGER_ACCOUNT,{request:{key:'github-token-manual',targets:[{account:businessAccount,actions:[{kind:'upload',template:'cmliu',worker:'demo',ref:'latest',overrides:'apply',echTokenEnabled:false}]}]}}));
  else {config.compareAndSet('g1',[{domain:'autoConfig',expectedRevision:0,value:{enabled:true,interval:1,fuseThreshold:0}}]);response=await g.object.fetch(await f.rpc.request('cron_cycle',f.env.RELIABILITY_MANAGER_ACCOUNT,{scheduledAt:Math.floor(Date.now()/300000)*300000}));}
  expect(response.status).toBe(200);const result:any=await response.json();if(kind==='manual')expect(result.value.id).toBeTypeOf('string');else expect(result.value.lanes).toHaveLength(1);
  expect(network).toHaveBeenCalledTimes(2);expect(JSON.stringify(result)).not.toContain(token);
  const row=g.db.rows<{snapshot:string}>('SELECT snapshot FROM dispatch_outbox')[0];expect(row).toBeDefined();
  const snapshot=await sealed.get({id:row.snapshot,kind:'task_snapshot',account:businessAccount,generation:'g1'});expect(JSON.stringify(snapshot)).not.toContain(token);
 });
});
