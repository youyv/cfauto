import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessAdmission } from '../../src/reliability/business-admission';
import { BusinessPlanner } from '../../src/reliability/business-planner';
import { BusinessEffects } from '../../src/reliability/business-effects';
import { ConfigStore } from '../../src/reliability/config-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { TaskPreparation } from '../../src/reliability/task-preparation';
import { SealedStore } from '../../src/reliability/sealed-store';
import { migrateCredentialAccounts } from '../../src/reliability/credential-accounts';
import { manifestDigest, type Json } from '../../src/reliability/protocol';
import { sqliteFixture } from './sqlite-fixture';
const opened: ReturnType<typeof sqliteFixture>[] = [];
const aid = 'a'.repeat(32), bid = 'b'.repeat(32), sha = 'c'.repeat(40);
const ring = { currentId: 'test', keys: { test: 'non-production-secret-material-32-bytes' } };
const secret = new Uint8Array(32).fill(7);
const action = () => ({kind:'upload' as const,template:'cmliu',worker:'demo',ref:'latest',overrides:'ignore' as const,echTokenEnabled:false});
const request = () => ({key:'request-never-plaintext',targets:[{account:aid,actions:[action()]}]});
async function fixture() {
    const f = sqliteFixture(); opened.push(f);
    const config = new ConfigStore(f.db), sealed = new SealedStore(f.db,ring), dispatch = new TaskDispatch(f.db,secret);
    new BusinessEffects(f.db);
    const accounts = await migrateCredentialAccounts([aid,bid].map(accountId => ({accountId,alias:accountId,email:'',globalKey:'',apiToken:'secret-account-token',authMode:'token' as const,workers_cmliu:['demo']})),ring,'plaintext');
    const records = [{domain:'accounts',revision:1,value:accounts as unknown as Json}];
    config.beginImport('g1',await manifestDigest(records),1); config.stage('g1',records[0]); await config.activateInitial('g1',0); config.setMaintenance(false,1);
    const transport = vi.fn(async (url: string) => url.startsWith('https://api.github.com/') ? Response.json({sha}) : new Response('export default {};'));
    const planner = new BusinessPlanner(config,{ring,protected:{workers:[],namespaces:[]},source:{transport}});
    const prepare = vi.spyOn(planner,'prepare'), prep = new TaskPreparation(config,sealed,dispatch,secret);
    const submit = vi.fn((input: any) => prep.submit(input));
    const admission = (key = secret) => new BusinessAdmission(f.db,config,sealed,dispatch,planner,submit,key);
    return {...f,config,sealed,dispatch,transport,prepare,prep,submit,admission};
}
afterEach(()=>{opened.splice(0).forEach(f=>f.sql.close());vi.restoreAllMocks();});
describe('durable business intent admission',()=>{
    it('finds the accepted task before latest/config/maintenance can change the plan',async()=>{
        const f=await fixture(),a=f.admission(),first=await a.submit('admin',request());
        f.config.compareAndSet('g1',[{domain:'vars:cmliu',expectedRevision:0,value:[{key:'UUID',value:'changed'}]}]);
        f.config.setMaintenance(true,2); f.transport.mockRejectedValue(new Error('offline'));
        expect(await f.admission().submit('admin',request())).toEqual({id:first.id,duplicate:true});
        expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.transport).toHaveBeenCalledTimes(2);
        expect(f.db.rows('SELECT id FROM dispatch_tasks')).toHaveLength(1);
    });
    it('deduplicates simultaneous identical intents before any source download',async()=>{
        const f=await fixture(),a=f.admission();
        const results=await Promise.all(Array.from({length:12},()=>a.submit('admin',request())));
        expect(new Set(results.map(r=>r.id)).size).toBe(1);expect(results.filter(r=>!r.duplicate)).toHaveLength(1);expect(f.prepare).toHaveBeenCalledTimes(1);
    });
    it('rejects a changed intent under the same key without resolving a new ref',async()=>{
        const f=await fixture(),a=f.admission();await a.submit('admin',request());
        const changed=request();changed.targets[0].actions[0].ref='d'.repeat(40);
        await expect(a.submit('admin',changed)).rejects.toThrow('CONFLICT');expect(f.prepare).toHaveBeenCalledTimes(1);
    });
    it('keeps scopes separate and task IDs do not grant read access',async()=>{
        const f=await fixture(),a=f.admission(),one=await a.submit('admin',request()),two=await a.submit('other',request());
        expect(one.id).not.toBe(two.id);await expect(a.inspect('other',one.id)).rejects.toMatchObject({status:404});
        await expect(a.inspect('admin','absent')).rejects.toMatchObject({status:404});
    });
    it('normalizes target ordering but preserves command order',async()=>{
        const f=await fixture(),a=f.admission(),input=request();input.targets.push({account:bid,actions:[action()]});
        const first=await a.submit('admin',input);input.targets.reverse();expect(await a.submit('admin',input)).toEqual({id:first.id,duplicate:true});
        expect(f.prepare).toHaveBeenCalledTimes(1);
    });
    it('freezes intent synchronously and does not persist raw keys/credentials',async()=>{
        const f=await fixture(),a=f.admission(),input=request(),pending=a.submit('admin',input);
        input.key='evil';input.targets[0].actions[0].worker='evil';const task=await pending;
        const data=JSON.stringify([...f.db.rows('SELECT * FROM business_admissions'),...f.db.rows('SELECT * FROM sealed_chunks')]);
        for(const value of ['request-never-plaintext','secret-account-token','admin','export default'])expect(data).not.toContain(value);
        const status=JSON.stringify(await a.inspect('admin',task.id));for(const value of ['token','digest','snapshot','credential','secret','export default'])expect(status).not.toContain(value);
        expect(JSON.parse(status).targets[0].steps).toEqual([{ordinal:0,kind:'upload',state:'pending'}]);
    });
    it('recovers a lost submit response using the stored plan even under maintenance',async()=>{
        const f=await fixture();f.submit.mockImplementationOnce(async input=>{await f.prep.submit(input);throw new Error('ACK lost');});
        await expect(f.admission().submit('admin',request())).rejects.toThrow('ACK lost');
        const id=f.db.rows<{id:string}>('SELECT id FROM dispatch_tasks')[0].id;f.config.setMaintenance(true,2);
        expect(await f.admission().submit('admin',request())).toEqual({id,duplicate:true});expect(f.prepare).toHaveBeenCalledTimes(1);
    });
    it('recovers interruption after the manifest but before dispatch without replanning',async()=>{
        const f=await fixture();f.submit.mockRejectedValueOnce(new Error('process stopped'));
        await expect(f.admission().submit('admin',request())).rejects.toThrow('process stopped');
        expect(f.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);
        expect(await f.admission().submit('admin',request())).toMatchObject({duplicate:false});expect(f.prepare).toHaveBeenCalledTimes(1);
    });
    it('refuses stale prepared dependencies after restart instead of replacing the sealed plan',async()=>{
        const f=await fixture();f.submit.mockRejectedValueOnce(new Error('interrupted'));
        await expect(f.admission().submit('admin',request())).rejects.toThrow();
        f.config.compareAndSet('g1',[{domain:'vars:cmliu',expectedRevision:0,value:[]}]);
        await expect(f.admission().submit('admin',request())).rejects.toThrow('CONFLICT');expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);
    });
    it('fails closed on an unfinished pre-manifest reservation, without resolving latest again',async()=>{
        const f=await fixture();await f.admission().submit('admin',request());
        // Simulate a separate request interrupted before any artifact/task was committed.
        const row=f.db.rows<any>('SELECT * FROM business_admissions')[0];
        f.db.rows('UPDATE business_admissions SET id=?, task=NULL WHERE receipt=?','interrupted-before-manifest',row.receipt);
        await expect(f.admission().submit('admin',request())).rejects.toThrow('NOT_READY');expect(f.prepare).toHaveBeenCalledTimes(1);
    });
    it('retains a stable planning refusal and requires a new intent key to retry resolution',async()=>{
        const f=await fixture();f.transport.mockRejectedValueOnce(new Error('provider contains token=secret'));
        await expect(f.admission().submit('admin',request())).rejects.toThrow('NOT_READY');
        await expect(f.admission().submit('admin',request())).rejects.toThrow('NOT_READY');expect(f.prepare).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(f.db.rows('SELECT * FROM business_admissions'))).not.toContain('provider');
        const next=request();next.key='new-intent';await f.admission().submit('admin',next);expect(f.prepare).toHaveBeenCalledTimes(2);
    });
    it('rejects idempotency key material changes for both submits and reads',async()=>{
        const f=await fixture(),first=await f.admission().submit('admin',request()),changed=f.admission(new Uint8Array(32).fill(9));
        await expect(changed.submit('admin',request())).rejects.toThrow('CONFLICT');await expect(changed.inspect('admin',first.id)).rejects.toThrow('CONFLICT');
    });
    it('does not reserve new work during maintenance',async()=>{
        const f=await fixture();f.config.setMaintenance(true,2);await expect(f.admission().submit('admin',request())).rejects.toThrow('MAINTENANCE');expect(f.db.rows('SELECT * FROM business_admissions')).toEqual([]);expect(f.prepare).not.toHaveBeenCalled();
    });
    it.each(['scope','generation','expected','handler','credential','operation','targetsSnapshot'])('rejects browser-owned %s fields before planning',async field=>{
        const f=await fixture();await expect(f.admission().submit('admin',{...request(),[field]:'evil'})).rejects.toThrow('INVALID');expect(f.prepare).not.toHaveBeenCalled();
    });
    it('does not expose raw result payloads when showing unknown progress',async()=>{
        const f=await fixture(),a=f.admission(),task=await a.submit('admin',request());
        f.db.rows('INSERT INTO business_step_state VALUES (?,?,?,?)',task.id,aid,0,'unknown');
        const view=await a.inspect('admin',task.id) as any;expect(view.targets[0].steps[0].state).toBe('unknown');expect(view.targets[0].outcome).toBeNull();
    });
    it('refuses a corrupted sealed manifest rather than creating a replacement task',async()=>{
        const f=await fixture();f.submit.mockRejectedValueOnce(new Error('stop'));await expect(f.admission().submit('admin',request())).rejects.toThrow();
        const row=f.db.rows<any>('SELECT id FROM business_admissions')[0];f.db.rows('UPDATE sealed_chunks SET ciphertext=? WHERE id=?','corrupt',row.id);
        await expect(f.admission().submit('admin',request())).rejects.toThrow('INVALID');expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);
    });
});


describe('batch intent mode remains pinned after acceptance',()=>{
    it('does not switch replace to create when a lost ACK is retried after registry removal',async()=>{
        const f=await fixture(),input={key:'batch-mode',targets:[{account:aid,actions:[{kind:'deploy_worker' as const,template:'cmliu',worker:'demo',ref:'latest',variables:[],namespaceTitle:'',echTokenEnabled:false}]}]};
        f.submit.mockImplementationOnce(async prepared=>{await f.prep.submit(prepared);throw new Error('lost ACK');});
        await expect(f.admission().submit('admin',input)).rejects.toThrow('lost ACK');
        const row=f.config.read(['accounts']).records[0],accounts=JSON.parse(JSON.stringify(row.value));accounts[0].workers_cmliu=[];
        f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:accounts}]);f.transport.mockRejectedValue(new Error('offline'));
        const recovered=await f.admission().submit('admin',input);expect(recovered.duplicate).toBe(true);
        expect(f.dispatch.reserve()[0]).toMatchObject({task:recovered.id,steps:['replace_worker']});expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.transport).toHaveBeenCalledTimes(2);
    });
});


describe('scoped retained task listing',()=>{
    it('paginates newest-first with a principal-bound cursor and no duplicates under inserts',async()=>{
        const f=await fixture(),a=f.admission(),ids:string[]=[];
        for(let i=0;i<3;i++)ids.push((await a.submit('admin',{...request(),key:'list-'+i})).id);
        await a.submit('other',request());const page=await a.list('admin',{limit:2,cursor:null}) as any;
        expect(page.items.map((i:any)=>i.id)).toEqual([ids[2],ids[1]]);expect(page.cursor).toMatch(/^v1/);
        await a.submit('admin',{...request(),key:'new-after-page'});
        const next=await f.admission().list('admin',{limit:2,cursor:page.cursor}) as any;
        expect(next.items.map((i:any)=>i.id)).toEqual([ids[0]]);expect(next.cursor).toBe(null);
        expect(page.items[0]).toEqual({id:ids[2],targets:[{account:aid,state:'pending',outcome:null,cancellationRequested:false}]});
        expect(JSON.stringify(page)).not.toMatch(/secret-account-token|snapshot|credential|digest|artifact|request-never-plaintext/);
        await expect(a.list('other',{limit:2,cursor:page.cursor})).rejects.toThrow('INVALID');
        await expect(a.list('admin',{limit:2,cursor:page.cursor.replace('v1.','v1X')})).rejects.toThrow('INVALID');
        await expect(a.list('admin',{limit:2,cursor:page.cursor+'0'})).rejects.toThrow('INVALID');
    });
    it('lists current cancellation state while in maintenance without contacting source',async()=>{
        const f=await fixture(),a=f.admission(),{id}=await a.submit('admin',request());f.dispatch.requestCancel(id);f.config.setMaintenance(true,2);f.transport.mockRejectedValue(new Error('offline'));
        expect(await a.list('admin',{limit:50,cursor:null})).toEqual({items:[{id,targets:[{account:aid,state:'pending',outcome:null,cancellationRequested:true}]}],cursor:null});expect(f.transport).toHaveBeenCalledTimes(2);
    });
    it('does not call unfinished preparations accepted tasks and detects changed key material',async()=>{
        const f=await fixture();f.prepare.mockRejectedValue(new Error('source unavailable'));await expect(f.admission().submit('admin',request())).rejects.toThrow('NOT_READY');
        expect(await f.admission().list('admin',{limit:1,cursor:null})).toEqual({items:[],cursor:null});await expect(f.admission(new Uint8Array(32).fill(9)).list('admin',{limit:1,cursor:null})).rejects.toThrow('CONFLICT');
    });
    it.each([null,{}, {limit:0,cursor:null},{limit:51,cursor:null},{limit:1.5,cursor:null},{limit:'1',cursor:null},{limit:1,cursor:''},{limit:1,cursor:'v1.9007199254740992.'+'a'.repeat(64)},{limit:1,cursor:null,scope:'other'}])('rejects malformed list input %j',async input=>{
        const f=await fixture();await expect(f.admission().list('admin',input)).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
});


describe('durable config-changing admission',()=>{
    const fuse=()=>({key:'fuse-once',targets:[{account:aid,actions:[{kind:'fuse',template:'cmliu',echTokenEnabled:false}]}]});
    it('recovers the same rotated UUID after lost submit ACK and coordinator reconstruction',async()=>{
        const f=await fixture();let id='';f.submit.mockImplementationOnce(async input=>{const r=await f.prep.submit(input);id=r.id;throw new Error('lost ACK');});
        await expect(f.admission().submit('cron',fuse())).rejects.toThrow('lost ACK');
        const first=f.config.read(['override:cmliu:'+aid]).records[0];expect(first.revision).toBe(1);
        f.transport.mockRejectedValue(new Error('offline'));
        expect(await f.admission().submit('cron',fuse())).toEqual({id,duplicate:true});
        expect(f.config.read(['override:cmliu:'+aid]).records[0]).toEqual(first);expect(f.prepare).toHaveBeenCalledTimes(1);
        const delivery=f.dispatch.reserve()[0],snapshot:any=await f.sealed.get({id:delivery.snapshot,kind:'task_snapshot',account:aid,generation:'g1'});
        expect(snapshot.changes[0].value).toEqual(first.value);
        expect(snapshot.operation.operation.commands[0].variables).toEqual(first.value);
        expect(JSON.stringify(await f.admission().list('cron',{limit:20,cursor:null}))).not.toContain((first.value as any)[0].value);
    });
    it('same-key fuse does not undo a later manual configuration change',async()=>{
        const f=await fixture(),a=f.admission(),first=await a.submit('cron',fuse());
        f.config.compareAndSet('g1',[{domain:'override:cmliu:'+aid,expectedRevision:1,value:null}]);
        expect(await f.admission().submit('cron',fuse())).toEqual({id:first.id,duplicate:true});
        expect(f.config.read(['override:cmliu:'+aid]).records[0]).toMatchObject({revision:2,value:null});
    });
    it('failed source resolution never changes the override and same-key retry does not rotate again',async()=>{
        const f=await fixture();f.transport.mockRejectedValue(new Error('offline'));
        await expect(f.admission().submit('cron',fuse())).rejects.toThrow();
        await expect(f.admission().submit('cron',fuse())).rejects.toThrow();expect(f.prepare).toHaveBeenCalledTimes(1);
        expect(f.config.read(['override:cmliu:'+aid]).records[0]).toMatchObject({revision:0,value:null});expect(f.db.rows('SELECT * FROM dispatch_tasks')).toHaveLength(0);
    });
    it('clear cancellation never rolls back the explicitly accepted user configuration',async()=>{
        const f=await fixture();f.config.compareAndSet('g1',[{domain:'override:cmliu:'+aid,expectedRevision:0,value:[{key:'UUID',value:'old'}]}]);
        const input={key:'clear',targets:[{account:aid,actions:[{...action(),overrides:'clear'}]}]},result=await f.admission().submit('admin',input);
        f.dispatch.requestCancel(result.id);expect(f.config.read(['override:cmliu:'+aid]).records[0]).toMatchObject({revision:2,value:null});
        expect(await f.admission().submit('admin',input)).toEqual({id:result.id,duplicate:true});
    });
});


describe('manual admission recovery and byte budgets',()=>{
    const requestManual=()=>({key:'manual-key',targets:[{account:aid,actions:[{kind:'manual_deploy',template:'cmliu',source:{kind:'custom',code:'export default {}; /*'+ 'x'.repeat(180000)+'*/'},variables:[{key:'UUID',value:'private-manual-value',secret:true}],deletedVariables:['REMOVE'],echTokenEnabled:false,echDisableWorkersDev:false}]}]});
    it('admits >128KiB custom bytes and restores the exact sealed task after lost ACK without replanning',async()=>{
        const f=await fixture(),input=requestManual();f.config.compareAndSet('g1',[{domain:'override:cmliu:'+aid,expectedRevision:0,value:[{key:'UUID',value:'prior'}]}]);
        f.submit.mockImplementationOnce(async plan=>{await f.prep.submit(plan);throw new Error('lost ACK');});
        await expect(f.admission().submit('admin',input)).rejects.toThrow('lost ACK');
        f.config.compareAndSet('g1',[{domain:'override:cmliu:'+aid,expectedRevision:2,value:[{key:'UUID',value:'later'}]}]);f.config.setMaintenance(true,2);
        const first=f.db.rows<{id:string}>('SELECT id FROM dispatch_tasks')[0].id;
        expect(await f.admission().submit('admin',input)).toEqual({id:first,duplicate:true});expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.transport).not.toHaveBeenCalled();
        expect(f.config.read(['override:cmliu:'+aid]).records[0]).toMatchObject({revision:3,value:[{key:'UUID',value:'later'}]});
        const publicStatus=JSON.stringify(await f.admission().inspect('admin',first));expect(publicStatus).not.toMatch(/private-manual-value|export default|digest|snapshot/);
        expect(JSON.stringify(f.db.rows('SELECT * FROM sealed_chunks'))).not.toContain('private-manual-value');
    });
    it.each(['code','deletedVariables','variables'])('same idempotency key rejects changed manual %s without new task',async field=>{
        const f=await fixture(),input=requestManual();await f.admission().submit('admin',input);const a:any=input.targets[0].actions[0];if(field==='code')a.source.code+='\n//different';else if(field==='deletedVariables')a.deletedVariables=['OTHER'];else a.variables[0].value='changed';
        await expect(f.admission().submit('admin',input)).rejects.toThrow('CONFLICT');expect(f.prepare).toHaveBeenCalledTimes(1);
    });
    it('rejects an oversize aggregate intent before reserving admission or reading source',async()=>{
        const f=await fixture(),input=requestManual();input.targets[0].actions[0].source.code='x'.repeat(1024*1024);
        input.targets.push({...input.targets[0],account:bid});await expect(f.admission().submit('admin',input)).rejects.toThrow('INVALID');expect(f.db.rows('SELECT * FROM business_admissions')).toHaveLength(0);expect(f.prepare).not.toHaveBeenCalled();
    });
});


describe('repair admission preserves frozen account rotation',()=>{
    it('does not generate another subdomain or latest source after lost ACK and reconstruction',async()=>{
        const f=await fixture();const input={key:'repair-once',targets:[{account:aid,actions:[{kind:'repair',template:'cmliu',workers:['demo'],rotateSubdomain:true}]}]};
        f.submit.mockImplementationOnce(async plan=>{await f.prep.submit(plan);throw new Error('lost ACK');});
        await expect(f.admission().submit('admin',input)).rejects.toThrow('lost ACK');
        const id=f.db.rows<{id:string}>('SELECT id FROM dispatch_tasks')[0].id;
        f.transport.mockRejectedValue(new Error('offline'));
        expect(await f.admission().submit('admin',input)).toEqual({id,duplicate:true});expect(f.prepare).toHaveBeenCalledTimes(1);
        const delivery=f.dispatch.reserve()[0],snapshot:any=await f.sealed.get({id:delivery.snapshot,kind:'task_snapshot',account:aid,generation:'g1'});
        const subdomain=snapshot.operation.operation.commands[1].subdomain;expect(subdomain).toMatch(/^repair-[a-f0-9]{24}$/);
        expect(JSON.stringify(await f.admission().inspect('admin',id))).not.toContain(subdomain);
        input.targets[0].actions[0].rotateSubdomain=false;await expect(f.admission().submit('admin',input)).rejects.toThrow('CONFLICT');
    });
});

describe('incomplete admission maintenance recovery',()=>{
 it('finds original dispatch after lost task backfill before attempting recovery',async()=>{
  const f=await fixture();f.submit.mockImplementationOnce(async input=>{await f.prep.submit(input);throw new Error('ACK lost');});
  await expect(f.admission().submit('admin',request())).rejects.toThrow();const row=f.db.rows<{id:string}>('SELECT id FROM business_admissions WHERE task IS NULL')[0],task=f.db.rows<{id:string}>('SELECT id FROM dispatch_tasks')[0].id;
  const lookup=vi.spyOn(f.dispatch,'lookupReceipt'),order:string[]=[];lookup.mockImplementation(async(scope,key)=>{order.push('lookup');return TaskDispatch.prototype.lookupReceipt.call(f.dispatch,scope,key);});
  f.submit.mockImplementation(async input=>{order.push('submit');return f.prep.submit(input);});f.config.setMaintenance(true,2);f.transport.mockRejectedValue(new Error('offline'));
  const page=await f.admission().listIncomplete('admin',{limit:10,cursor:null}) as any;expect(page.items[0]).toMatchObject({id:row.id,manifestStored:true});expect(JSON.stringify(page)).not.toMatch(/secret-account-token|request-never-plaintext/);
  expect(await f.admission().recover('admin',row.id)).toEqual({id:task,duplicate:true});expect(order).toEqual(['lookup','submit']);expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.transport).toHaveBeenCalledTimes(2);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toHaveLength(1);
  expect(await f.admission().recover('admin',row.id)).toEqual({id:task,duplicate:true});expect((await f.admission().listIncomplete('admin',{limit:10,cursor:null}) as any).items).toEqual([]);
 });
 it('refuses an incomplete manifest rather than rerunning its planner',async()=>{
  const f=await fixture();f.prepare.mockRejectedValueOnce(new Error('interrupted planner'));await expect(f.admission().submit('admin',request())).rejects.toThrow();const row=f.db.rows<{id:string}>('SELECT id FROM business_admissions')[0];
  await expect(f.admission().recover('admin',row.id)).rejects.toThrow('NOT_READY');expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);
  await expect(f.admission().recover('other',row.id)).rejects.toMatchObject({status:404});
 });
 it('restores a complete unsubmitted plan without source downloads, and enforces its original CAS',async()=>{
  const f=await fixture();f.submit.mockRejectedValueOnce(new Error('before dispatch'));await expect(f.admission().submit('admin',request())).rejects.toThrow();const row=f.db.rows<{id:string}>('SELECT id FROM business_admissions')[0];
  f.transport.mockRejectedValue(new Error('offline'));const result=await f.admission().recover('admin',row.id);expect(result.duplicate).toBe(false);expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toHaveLength(1);
  const g=await fixture();g.submit.mockRejectedValueOnce(new Error('before dispatch'));await expect(g.admission().submit('admin',request())).rejects.toThrow();const other=g.db.rows<{id:string}>('SELECT id FROM business_admissions')[0];g.config.setMaintenance(true,2);await expect(g.admission().recover('admin',other.id)).rejects.toThrow();expect(g.db.rows('SELECT * FROM dispatch_tasks')).toEqual([]);
 });
 it('paginates incomplete admissions with scope-isolated cursors and no raw intent',async()=>{
  const f=await fixture();for(let i=0;i<3;i++){f.prepare.mockRejectedValueOnce(new Error('interrupted'));await expect(f.admission().submit('admin',{...request(),key:'request-'+i})).rejects.toThrow();}
  const a=f.admission(),first=await a.listIncomplete('admin',{limit:2,cursor:null}) as any,second=await a.listIncomplete('admin',{limit:2,cursor:first.cursor}) as any;
  expect(first.items).toHaveLength(2);expect(second.items).toHaveLength(1);expect(new Set([...first.items,...second.items].map(r=>r.id)).size).toBe(3);expect(second.cursor).toBeNull();await expect(a.listIncomplete('other',{limit:2,cursor:first.cursor})).rejects.toThrow('INVALID');
 });
});

it('looks up a dispatch receipt without writes or key initialization, and refuses a changed key',async()=>{
 const f=await fixture();expect(await f.dispatch.lookupReceipt('admin','missing')).toBeNull();expect(f.db.rows('SELECT * FROM dispatch_key')).toEqual([]);
 const accepted=await f.admission().submit('admin',request()),before=f.db.rows('SELECT * FROM dispatch_outbox');expect(await f.dispatch.lookupReceipt('admin',request().key)).toEqual({id:accepted.id});expect(await f.dispatch.lookupReceipt('other',request().key)).toBeNull();expect(f.db.rows('SELECT * FROM dispatch_outbox')).toEqual(before);
 await expect(new TaskDispatch(f.db,new Uint8Array(32).fill(9)).lookupReceipt('admin',request().key)).rejects.toThrow('CONFLICT');
});
it('does not recover corrupt manifest ciphertext or change a potentially accepted dispatch',async()=>{
 const f=await fixture();f.submit.mockImplementationOnce(async plan=>{await f.prep.submit(plan);throw new Error('lost ACK');});await expect(f.admission().submit('admin',request())).rejects.toThrow();const row=f.db.rows<{id:string}>('SELECT id FROM business_admissions')[0],before=f.db.rows('SELECT * FROM dispatch_outbox');f.db.rows("UPDATE sealed_chunks SET ciphertext='AAAA' WHERE id=?",row.id);await expect(f.admission().recover('admin',row.id)).rejects.toThrow();expect(f.db.rows('SELECT * FROM dispatch_outbox')).toEqual(before);expect(f.db.rows('SELECT task FROM business_admissions')).toEqual([{task:null}]);expect(f.prepare).toHaveBeenCalledTimes(1);
});
