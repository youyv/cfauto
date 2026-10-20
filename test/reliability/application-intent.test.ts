import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationPlanner, legacyHttpIntent, parseApplicationIntent } from '../../src/reliability/application-intent';
import { BusinessPlanner } from '../../src/reliability/business-planner';
import { BusinessAdmission } from '../../src/reliability/business-admission';
import { BusinessEffects } from '../../src/reliability/business-effects';
import { ConfigStore } from '../../src/reliability/config-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { TaskPreparation } from '../../src/reliability/task-preparation';
import { SealedStore } from '../../src/reliability/sealed-store';
import { migrateCredentialAccounts } from '../../src/reliability/credential-accounts';
import { manifestDigest, type Json } from '../../src/reliability/protocol';
import { sqliteFixture } from './sqlite-fixture';
const aid='a'.repeat(32),bid='b'.repeat(32),sha='c'.repeat(40),secret=new Uint8Array(32).fill(6);
const ring={currentId:'test',keys:{test:'test-only-secret-at-least-thirty-two-bytes'}};
const open:ReturnType<typeof sqliteFixture>[]=[];
const http=(path:string,value:unknown,key='legacy-intent')=>legacyHttpIntent(new Request('https://panel.test'+path,{method:'POST',headers:{'Idempotency-Key':key}}),value);
const manual=(extra={})=>http('/api/deploy?type=cmliu',{variables:[{key:'UUID',value:'new'}],...extra});
const batch=(extra={})=>http('/api/batch_deploy',{template:'cmliu',workerName:'new-worker',targetAccounts:['first'],config:{UUID:'from-config'},...extra});
const repair=(targets=[{accountId:aid,workerName:'first-worker'},{accountId:bid,workerName:'second-worker'}])=>http('/api/fix_1101',{type:'cmliu',expectedTargets:targets});
async function fixture(aliases=['first','second']) {
    const f=sqliteFixture();open.push(f);
    const config=new ConfigStore(f.db),sealed=new SealedStore(f.db,ring),dispatch=new TaskDispatch(f.db,secret);new BusinessEffects(f.db);
    const accounts=await migrateCredentialAccounts([aid,bid].map((accountId,i)=>({accountId,alias:aliases[i],email:'',globalKey:'',apiToken:'private-account-token',authMode:'token' as const,workers_cmliu:[i?'second-worker':'first-worker'],defaultZoneId:'d'.repeat(32),defaultZoneName:'example.test'})),ring,'plaintext');
    const records=[{domain:'accounts',revision:1,value:accounts as unknown as Json}];
    config.beginImport('g1',await manifestDigest(records),1);config.stage('g1',records[0]);await config.activateInitial('g1',0);config.setMaintenance(false,1);
    const transport=vi.fn(async(url:string)=>url.startsWith('https://api.github.com/')?Response.json({sha}):new Response('export default {};'));
    const resources={workers:[] as {account:string;worker:string}[],namespaces:[]};
    const inventory=vi.fn(async()=>Response.json({success:true,result:[{name:'KV',type:'kv_namespace',namespace_id:'e'.repeat(32)}]}));
    const business=()=>new BusinessPlanner(config,{ring,protected:resources,source:{transport},inventory});
    const planner=new ApplicationPlanner(config,business()),prepare=vi.spyOn(planner,'prepare');
    const prep=new TaskPreparation(config,sealed,dispatch,secret),submit=vi.fn((input:any)=>prep.submit(input));
    const admission=()=>new BusinessAdmission(f.db,config,sealed,dispatch,planner,submit,secret,parseApplicationIntent);
    return {...f,config,accounts,transport,inventory,planner,prepare,submit,admission,resources,business};
}
const commands=(p:any,i=0)=>p.targets[i].operation.operation.commands;
afterEach(()=>{open.splice(0).forEach(f=>f.sql.close());vi.restoreAllMocks();});
describe('explicit legacy HTTP normalization',()=>{
    it('keeps account selection unresolved and accepts large custom bytes without a fake SHA',()=>{
        const intent=manual({customCode:'export default {}; /*'+'x'.repeat(180000)+'*/'});
        expect(intent.operation).toMatchObject({kind:'manual',accounts:null,action:{source:{kind:'custom'}}});expect(intent).not.toHaveProperty('targets');
    });
    it('defaults nullable manual inputs without inventing target accounts',()=>{
        expect(manual({targetSha:null,customCode:null,targetAccountIds:null}).operation).toMatchObject({accounts:null,action:{source:{kind:'upstream',ref:'latest'},echTokenEnabled:false,echDisableWorkersDev:false}});
    });
    it('preserves source config vs saved binding variables and secret flags separately',()=>{
        expect(batch({template:'ech',enableKV:false,savedVars:[{key:'PROXYIP',value:'binding-value',secret:true}],config:{PROXYIP:'source-value'}}).operation).toMatchObject({action:{variables:[{key:'PROXYIP',value:'binding-value',secret:true}],sourceVariables:[{key:'PROXYIP',value:'source-value',secret:false}]}});
    });
    it('uses template fallback variables when savedVars is empty',()=>{
        expect(batch({savedVars:[]}).operation).toMatchObject({action:{variables:expect.arrayContaining([{key:'UUID',value:'from-config',secret:false}])}});
    });
    it.each([
        ()=>manual({targetSha:'short'}),()=>manual({targetSha:sha,customCode:'export default {};'}),()=>manual({targetAccountIds:[]}),()=>manual({targetAccountIds:[aid,aid]}),
        ()=>manual({echTokenEnabled:'true'}),()=>manual({scope:'evil'}),()=>manual({variables:[{key:'UUID',value:'a'},{key:'UUID',value:'b'}]}),
        ()=>batch({targetAccounts:['first','first']}),()=>batch({targetAccounts:['']}),()=>batch({config:{UUID:12}}),()=>batch({config:[]}),
        ()=>batch({enableKV:true,kvName:''}),()=>batch({template:'ech',enableKV:true,kvName:'bad'}),()=>batch({enableKV:'false'}),()=>batch({workerName:'Bad Name'}),
        ()=>repair([]),()=>repair([{accountId:aid,workerName:'first-worker'},{accountId:aid,workerName:'first-worker'}]),
        ()=>http('/api/deploy?type=cmliu&type=ech',{}),()=>http('/api/deploy?type=cmliu&scope=x',{}),()=>http('/api/batch_deploy?x=1',{}),
        ()=>http('/api/deploy?type=cmliu',{},''),()=>http('/api/fix_1101',{type:'cmliu',expectedTargets:[{accountId:aid,workerName:'x',token:'secret'}]})
    ])('rejects malformed/ambiguous or privileged request %# before any planning',make=>expect(make).toThrow('INVALID'));
    it('canonicalizes set ordering without changing variable/command semantics',()=>{
        expect(manual({targetAccountIds:[bid,aid]})).toEqual(manual({targetAccountIds:[aid,bid]}));
        expect(batch({targetAccounts:['second','first']})).toEqual(batch({targetAccounts:['first','second']}));
    });
    it('does not allow mixed native and unresolved intent or executable commands',()=>{
        expect(()=>parseApplicationIntent({...manual(),targets:[]})).toThrow('INVALID');
        const forged:any=batch();forged.operation.action.kind='replace_worker';expect(()=>parseApplicationIntent(forged)).toThrow('INVALID');
    });
});
describe('trusted authoritative expansion before durable task preparation',()=>{
    it('expands all manual targets and clears overrides in the same plan',async()=>{
        const f=await fixture();f.config.compareAndSet('g1',[{domain:'override:cmliu:'+aid,expectedRevision:0,value:[{key:'UUID',value:'old'}]}]);
        const p=await f.planner.prepare('manager',manual());expect(p.targets.map(t=>t.account)).toEqual([aid,bid]);expect(commands(p)[0].kind).toBe('manual_upload');
        expect(p.changes).toEqual([{domain:'override:cmliu:'+aid,expectedRevision:1,value:null}]);
    });
    it('supports explicit manual subset, but never silently drops an unknown account',async()=>{
        const f=await fixture();expect((await f.planner.prepare('manager',manual({targetAccountIds:[bid]}))).targets.map(t=>t.account)).toEqual([bid]);
        await expect(f.planner.prepare('manager',manual({targetAccountIds:['f'.repeat(32)]}))).rejects.toThrow('INVALID');
    });
    it('resolves aliases from DO and freezes create/replace plus separate domain steps',async()=>{
        const f=await fixture();const created=await f.planner.prepare('manager',batch({customDomainPrefix:'demo'}));
        expect(commands(created).map((c:any)=>c.kind)).toEqual(['create_worker','configure_domain','configure_domain']);
        expect(commands(created)[1]).toMatchObject({hostname:'demo.example.test',zone:'d'.repeat(32)});
        const replaced=await f.planner.prepare('manager',batch({workerName:'first-worker'}));expect(commands(replaced)[0].kind).toBe('replace_worker');
    });
    it.each([['same','same'],['first','second']])('rejects duplicate or missing aliases without any source HTTP: %j',async(first,second)=>{
        const f=await fixture();f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:f.accounts.map((a,i)=>({...a,alias:i?second:first})) as unknown as Json}]);await expect(f.planner.prepare('manager',batch({targetAccounts:['same']}))).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
    it('requires the complete repair set across the entire installation, not just selected accounts',async()=>{
        const f=await fixture();await expect(f.planner.prepare('manager',repair([{accountId:aid,workerName:'first-worker'}]))).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
        const p=await f.planner.prepare('manager',repair());expect(p.targets).toHaveLength(2);expect(commands(p).map((c:any)=>c.kind)).toEqual(['repair_worker','change_subdomain']);
    });
    it('refuses account revision change while source is fetched',async()=>{
        const f=await fixture();let changed=false;f.transport.mockImplementation(async url=>{if(!changed){changed=true;f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:f.accounts as unknown as Json}]);}return url.startsWith('https://api.github.com/')?Response.json({sha}):new Response('export default {};');});
        await expect(f.planner.prepare('manager',manual())).rejects.toThrow('CONFLICT');
    });
    it('rechecks server-owned manager Worker protection',async()=>{
        const f=await fixture();f.resources.workers.push({account:aid,worker:'first-worker'});
        const planner=new ApplicationPlanner(f.config,f.business());await expect(planner.prepare('manager',manual())).rejects.toThrow('INVALID');
    });
    it('deduplicates original intent after lost ACK/restart even if aliases, accounts, maintenance and upstream changed',async()=>{
        const f=await fixture();f.submit.mockImplementationOnce(async input=>{await new TaskPreparation(f.config,new SealedStore(f.db,ring),new TaskDispatch(f.db,secret),secret).submit(input);throw new Error('lost');});
        const request=batch();await expect(f.admission().submit('manager',request)).rejects.toThrow('lost');
        const old=f.db.rows<{id:string}>('SELECT id FROM dispatch_tasks')[0].id;
        const changed=f.accounts.map(a=>({...a,alias:'changed-'+a.alias}));f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:changed as unknown as Json}]);f.config.setMaintenance(true,2);f.transport.mockRejectedValue(new Error('offline'));
        expect(await f.admission().submit('manager',request)).toEqual({id:old,duplicate:true});expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.transport).toHaveBeenCalledTimes(2);
        const storage=JSON.stringify([...f.db.rows('SELECT * FROM business_admissions'),...f.db.rows('SELECT * FROM sealed_chunks')]);expect(storage).not.toMatch(/legacy-intent|from-config|private-account-token/);
    });
    it('changed unresolved intent conflicts under the same key before re-expanding it',async()=>{
        const f=await fixture();await f.admission().submit('manager',batch());await expect(f.admission().submit('manager',batch({targetAccounts:['second']}))).rejects.toThrow('CONFLICT');expect(f.prepare).toHaveBeenCalledTimes(1);
    });
});


describe('remaining resource HTTP intents',()=>{
    const removal=(deleteKv=false)=>http('/api/delete_worker',{accountId:aid,workerName:'first-worker',deleteKv});
    const nodes=(extra={})=>http('/api/save_yxip',{type:'cmliu',accountId:aid,rawContent:'1.2.3.4:443#HK',...extra});
    it('plans discovery-only deletion without inventing a template or reading bindings',async()=>{
        const f=await fixture();const p=await f.planner.prepare('manager',http('/api/delete_worker',{accountId:aid,workerName:'unregistered'}));
        expect(commands(p)[0]).toMatchObject({kind:'remove_worker',worker:'unregistered',namespaces:null});expect(f.inventory).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
    });
    it('freezes bound namespace cleanup separately, and all conditional config reset dependencies',async()=>{
        const f=await fixture(),p=await f.planner.prepare('manager',removal(true));
        expect(commands(p).map((c:any)=>c.kind)).toEqual(['remove_worker','cleanup_kv']);expect(commands(p)[1]).toMatchObject({namespace:'e'.repeat(32),worker:'first-worker'});
        expect(commands(p)[0].cleanup).toContainEqual({domain:'vars:cmliu',revision:0});expect(commands(p)[0].cleanup).toContainEqual({domain:'override:cmliu:'+aid,revision:0});
        expect(f.inventory.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/accounts/'+aid+'/workers/scripts/first-worker/bindings');expect(f.inventory.mock.calls[0][1]).toMatchObject({method:'GET',redirect:'error'});
    });
    it('reuses the admitted plan after bindings or metadata change, without another preflight',async()=>{
        const f=await fixture();const first=await f.admission().submit('manager',removal(true));f.inventory.mockRejectedValue(new Error('offline'));
        f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:f.accounts.map(a=>({...a,alias:a.alias+'-edited'})) as any}]);
        expect(await f.admission().submit('manager',removal(true))).toMatchObject({id:first.id,duplicate:true});expect(f.inventory).toHaveBeenCalledTimes(1);
    });
    it('fails closed if account authority changes during inventory preflight',async()=>{
        const f=await fixture();f.inventory.mockImplementation(async()=>{f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:f.accounts as any}]);return Response.json({success:true,result:[]});});
        await expect(f.planner.prepare('manager',removal(true))).rejects.toThrow('CONFLICT');
    });
    it('rejects protected manager deletion before any inventory read',async()=>{
        const f=await fixture();f.resources.workers.push({account:aid,worker:'first-worker'});
        await expect(new ApplicationPlanner(f.config,f.business()).prepare('manager',removal(true))).rejects.toThrow('INVALID');expect(f.inventory).not.toHaveBeenCalled();
    });
    it('rejects cleanup of CONFIG_KV before task acceptance',async()=>{
        const f=await fixture();f.resources.namespaces.push({account:aid,namespace:'e'.repeat(32)});
        await expect(new ApplicationPlanner(f.config,f.business()).prepare('manager',removal(true))).rejects.toThrow('INVALID');
    });
    it('expands exact frozen nodes to every registered worker without a source download',async()=>{
        const f=await fixture();f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:f.accounts.map(a=>a.accountId===aid?{...a,workers_cmliu:['second','first-worker']}:a) as any}]);
        const p=await f.planner.prepare('manager',nodes());expect(commands(p)).toEqual(['first-worker','second'].map(worker=>({kind:'write_nodes',template:'cmliu',worker,content:'1.2.3.4:443#HK'})));expect(f.transport).not.toHaveBeenCalled();
    });
    it('normalizes the legacy subdomain once and accepts one-character names',async()=>{
        const f=await fixture(),p=await f.planner.prepare('manager',http('/api/change_subdomain',{accountId:aid,newSubdomain:' A '}));expect(commands(p)).toEqual([{kind:'rename_subdomain',subdomain:'a'}]);expect(f.inventory).not.toHaveBeenCalled();
    });
    it.each([
        ['/api/delete_worker',{accountId:aid,workerName:'demo',deleteKv:'true'}],
        ['/api/delete_worker',{accountId:aid,workerName:'demo',namespace:'e'.repeat(32)}],
        ['/api/change_subdomain',{accountId:aid,newSubdomain:'../elsewhere'}],
        ['/api/change_subdomain',{accountId:aid,newSubdomain:'new',globalKey:'secret'}],
        ['/api/save_yxip',{type:'cmliu',accountId:aid,rawContent:''}],
        ['/api/save_yxip',{type:'ech',accountId:aid,rawContent:'nodes'}],
        ['/api/save_yxip',{type:'cmliu',accountId:aid,rawContent:'nodes',workerName:'untrusted'}],
        ['/api/save_yxip',{type:'joey_var',rawContent:'nodes'}]
    ])('rejects ambiguous or privileged resource input %s %j',(path,body)=>expect(()=>http(path,body)).toThrow('INVALID'));
});


describe('explicit repair preservation of control-plane subdomains',()=>{
 it('repairs every confirmed Worker while preserving only protected account subdomains',async()=>{const f=await fixture();f.resources.workers.push({account:aid,worker:'manager'});const planner=new ApplicationPlanner(f.config,f.business()),intent=http('/api/fix_1101',{type:'cmliu',expectedTargets:[{accountId:aid,workerName:'first-worker'},{accountId:bid,workerName:'second-worker'}],preserveProtectedSubdomains:true});const plan=await planner.prepare('manager',intent);expect(plan.targets).toHaveLength(2);expect(commands(plan,0).map((c:any)=>c.kind)).toEqual(['repair_worker']);expect(commands(plan,1).map((c:any)=>c.kind)).toEqual(['repair_worker','change_subdomain']);expect(f.transport).toHaveBeenCalledTimes(2);});
 it('keeps the original protected-account rejection when the preservation policy was not acknowledged',async()=>{const f=await fixture();f.resources.workers.push({account:aid,worker:'manager'});await expect(new ApplicationPlanner(f.config,f.business()).prepare('manager',repair())).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();});
 it.each([false,null,'true',{}])('refuses an ambiguous preservation policy: %j',value=>{expect(()=>http('/api/fix_1101',{type:'cmliu',expectedTargets:[{accountId:aid,workerName:'first-worker'}],preserveProtectedSubdomains:value})).toThrow('INVALID');});
});
