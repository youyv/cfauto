import {MAX_SOURCE_BYTES} from '../../src/reliability/source-artifact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteFixture } from './sqlite-fixture';
import { ConfigStore } from '../../src/reliability/config-store';
import { BusinessPlanner } from '../../src/reliability/business-planner';
import { parseBusinessOperation, type BusinessAction } from '../../src/reliability/business-command';
import { validateDeploymentPlans } from '../../src/reliability/deployment-plan';
import { migrateCredentialAccounts } from '../../src/reliability/credential-accounts';
import { manifestDigest } from '../../src/reliability/protocol';
import { TaskPreparation } from '../../src/reliability/task-preparation';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { SealedStore } from '../../src/reliability/sealed-store';
const open: ReturnType<typeof sqliteFixture>[]=[];
const aid='a'.repeat(32), bid='b'.repeat(32), ns='c'.repeat(32), sha='d'.repeat(40);
const ring={currentId:'new',keys:{new:'mock-only-at-least-32-byte-material'}};
const account={accountId:aid,alias:'one',email:'',globalKey:'',apiToken:'private-token',authMode:'token' as const,workers_cmliu:['demo','second'],defaultZoneId:'e'.repeat(32),defaultZoneName:'example.test'};
const action=()=>({kind:'upload' as const,template:'cmliu',worker:'demo',ref:'latest',overrides:'apply' as const,echTokenEnabled:false});
const request=()=>({key:'request1',targets:[{account:aid,actions:[action()]}]});
async function fixture() {
    const f=sqliteFixture();open.push(f);const config=new ConfigStore(f.db);
    const records=[{domain:'accounts',revision:1,value:await migrateCredentialAccounts([account],ring,'plaintext') as any}, {domain:'vars:cmliu',revision:2,value:[{key:'UUID',value:'global'},{key:'PROXYIP',value:'global-proxy'}]}, {domain:'override:cmliu:'+aid,revision:3,value:[{key:'UUID',value:'account'},{key:'PROXYIP',value:'ignored-proxy'}]}];
    config.beginImport('g1',await manifestDigest(records),records.length);records.forEach(r=>config.stage('g1',r));await config.activateInitial('g1',0);config.setMaintenance(false,1);
    const transport=vi.fn(async(url:string)=>url.startsWith('https://api.github.com/')?Response.json({sha}):new Response('export default {};'));
    const policy={workers:[] as {account:string;worker:string}[],namespaces:[] as {account:string;namespace:string}[]};
    const planner=()=>new BusinessPlanner(config,{ring,protected:policy,source:{transport}});
    return {...f,config,transport,policy,planner};
}
afterEach(()=>{for(const f of open.splice(0))f.sql.close();vi.restoreAllMocks();});
describe('trusted business planning',()=>{
    it('records actual dependencies including absent upstream, applies UUID-only override and seals credentials',async()=>{
        const f=await fixture();const plan=await f.planner().prepare('admin',request());
        expect(plan.expected).toEqual([{domain:'accounts',revision:1},{domain:'override:cmliu:'+aid,revision:3},{domain:'template:cmliu',revision:0},{domain:'upstream:cmliu',revision:0},{domain:'vars:cmliu',revision:2}]);
        expect(plan.targets[0]).toMatchObject({account:aid,steps:['upload'],operation:{credentialRevision:1,input:{now:0},operation:{account:aid,credential:{apiToken:'private-token'},commands:[{artifact:{commit:sha},variables:[{key:'UUID',value:'account'},{key:'PROXYIP',value:'global-proxy'}]}]}}});
        const sealed=new SealedStore(f.db,ring),dispatch=new TaskDispatch(f.db,new Uint8Array(32).fill(3)),prep=new TaskPreparation(f.config,sealed,dispatch,new Uint8Array(32).fill(3));
        await prep.submit(plan);expect(JSON.stringify(f.sql.prepare('SELECT * FROM sealed_chunks').all())).not.toContain('private-token');
        const replay=await f.planner().prepare('admin',request());expect(await prep.submit(replay)).toMatchObject({duplicate:true});
    });
    it('downloads a shared source once for multiple worker commands',async()=>{
        const f=await fixture(),input=request();input.targets[0].actions.push({...action(),worker:'second'});const plan=await f.planner().prepare('admin',input);expect(f.transport).toHaveBeenCalledTimes(2);expect(plan.targets[0].steps).toEqual(['upload','upload']);
    });
    it('keeps same template at different full refs distinct',async()=>{
        const f=await fixture(),input=request(); input.targets[0].actions.push({...action(),worker:'second',ref:'f'.repeat(40)});
        f.transport.mockImplementation(async(url:string)=>url.includes('api.github.com')?Response.json({sha:url.endsWith('/latest')?sha:url.split('/').pop()==='main'?sha:'f'.repeat(40)}):new Response('export default {};'));
        const plan=await f.planner().prepare('admin',input);expect(f.transport).toHaveBeenCalledTimes(4);expect((plan.targets[0].operation as any).operation.commands.map((c:any)=>c.artifact.commit)).toEqual([sha,'f'.repeat(40)]);
    });
    it('does not acquire irrelevant deployment/cron/journal dependencies',async()=>{
        const f=await fixture();const plan=await f.planner().prepare('admin',{key:'delete',targets:[{account:aid,actions:[{kind:'delete_worker',template:'cmliu',worker:'demo'}]}]});expect(plan.expected).toEqual([{domain:'accounts',revision:1}]);expect(f.transport).not.toHaveBeenCalled();
    });
    it('splits custom-domain and workers.dev writes into separate persistent steps',async()=>{
        const f=await fixture();const plan=await f.planner().prepare('admin',{key:'domain',targets:[{account:aid,actions:[{kind:'configure_domain',template:'cmliu',worker:'demo',enabled:false,customPrefix:'demo'}]}]});expect(plan.targets[0].steps).toEqual(['configure_domain','configure_domain']);expect((plan.targets[0].operation as any).operation.commands).toMatchObject([{hostname:'demo.example.test',zone:account.defaultZoneId},{hostname:'',zone:'',enabled:false}]);
    });
    it.each([['vars:cmliu',2],['override:cmliu:'+aid,3],['upstream:cmliu',0]] as const)('rejects a %s edit during download',async(domain,rev)=>{
        const f=await fixture();f.transport.mockImplementationOnce(async()=>{f.config.compareAndSet('g1',[{domain,expectedRevision:rev,value:[]}]);return Response.json({sha});});await expect(f.planner().prepare('admin',request())).rejects.toThrow('CONFLICT');
    });
    it.each([false,true])('rejects maintenance / maintenance ABA during download (%s)',async(reopen)=>{
        const f=await fixture();f.transport.mockImplementationOnce(async()=>{f.config.setMaintenance(true,2);if(reopen)f.config.setMaintenance(false,3);return Response.json({sha});});await expect(f.planner().prepare('admin',request())).rejects.toThrow(reopen?'CONFLICT':'MAINTENANCE');
    });
    it('rejects known maintenance before network and rechecks later admission CAS',async()=>{
        const f=await fixture();f.config.setMaintenance(true,2);await expect(f.planner().prepare('admin',request())).rejects.toThrow('MAINTENANCE');expect(f.transport).not.toHaveBeenCalled();f.config.setMaintenance(false,3);
        const plan=await f.planner().prepare('admin',request());f.config.compareAndSet('g1',[{domain:'vars:cmliu',expectedRevision:2,value:[]}]);const prep=new TaskPreparation(f.config,new SealedStore(f.db,ring),new TaskDispatch(f.db,new Uint8Array(32).fill(3)),new Uint8Array(32).fill(3));await expect(prep.submit(plan)).rejects.toThrow('CONFLICT');expect(f.sql.prepare('SELECT * FROM dispatch_tasks').all()).toHaveLength(0);
    });
    it('freezes request, credentials and policy before await',async()=>{
        const f=await fixture(),input=request(),planner=f.planner();const pending=planner.prepare('admin',input);input.targets[0].account=bid;input.targets[0].actions[0].worker='attacker';f.policy.workers.push({account:aid,worker:'demo'});const plan=await pending;expect(plan.targets[0].account).toBe(aid);expect((plan.targets[0].operation as any).operation.commands[0].worker).toBe('demo');
    });
    it.each([
        {kind:'fetch',url:'https://evil.test'}, {...action(),worker:'../manager'}, {...action(),template:'__proto__'}, {...action(),worker:'unregistered'}, {...action(),code:'arbitrary source'}, {kind:'write_nodes',template:'ech',worker:'demo',content:'nodes'}, {kind:'delete_kv',namespace:'../other'}
    ])('rejects invalid/unregistered action %j',async action=>{
        const f=await fixture();await expect(f.planner().prepare('admin',{key:'invalid',targets:[{account:aid,actions:[action as any]}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
    it('rejects unknown identities, duplicate accounts and impersonation fields',async()=>{
        const f=await fixture(),input=request();input.targets[0].account=bid;await expect(f.planner().prepare('admin',input)).rejects.toThrow('INVALID');input.targets=[request().targets[0],request().targets[0]];await expect(f.planner().prepare('admin',input)).rejects.toThrow('INVALID');await expect(f.planner().prepare('admin',{...request(),scope:'admin2'} as any)).rejects.toThrow('INVALID');
    });
    it('protects manager worker, its account subdomain and configuration namespace',async()=>{
        const f=await fixture();f.policy.workers.push({account:aid,worker:'demo'});f.policy.namespaces.push({account:aid,namespace:ns});for(const item of [action(),{kind:'change_subdomain',subdomain:'other-name'},{kind:'delete_kv',namespace:ns}])await expect(f.planner().prepare('admin',{key:'protected',targets:[{account:aid,actions:[item as any]}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
});

describe('explicit batch creation planning',()=>{
    const create=()=>({kind:'create_worker' as const,template:'cmliu',worker:'new-worker',ref:'latest',variables:[{key:'UUID',value:'batch-uuid',secret:true},{key:'EMPTY',value:''}],namespaceTitle:'batch-kv',echTokenEnabled:false});
    it('freezes creation parameters, downloads official source and does not consume unrelated global vars',async()=>{
        const f=await fixture(),action=create();const pending=f.planner().prepare('admin',{key:'create1',targets:[{account:aid,actions:[action]}]});action.variables[0].value='mutated';const plan=await pending;
        const secret=new Uint8Array(32).fill(3),dispatch=new TaskDispatch(f.db,secret),prep=new TaskPreparation(f.config,new SealedStore(f.db,ring),dispatch,secret);
        await prep.submit(plan);expect(dispatch.reserve()[0].steps).toEqual(['create_worker']);
        expect(plan.expected).toEqual([{domain:'accounts',revision:1},{domain:'template:cmliu',revision:0},{domain:'upstream:cmliu',revision:0}]);
        expect(plan.targets[0]).toMatchObject({steps:['create_worker'],operation:{operation:{commands:[{kind:'create_worker',worker:'new-worker',namespaceTitle:'batch-kv',artifact:{commit:sha},variables:[{key:'UUID',value:'batch-uuid',secret:true}]}]}}});
    });
    it('can configure a newly created worker later in the same immutable task',async()=>{
        const f=await fixture();const plan=await f.planner().prepare('admin',{key:'create-domains',targets:[{account:aid,actions:[create(),{kind:'configure_domain',template:'cmliu',worker:'new-worker',enabled:false,customPrefix:'new-worker'}]}]});
        expect(plan.targets[0].steps).toEqual(['create_worker','configure_domain','configure_domain']);
    });
    it.each([{worker:'demo'},{namespaceTitle:' padded '},{namespaceTitle:'x\n'},{namespaceTitle:'x'.repeat(513)},{variables:[{key:'KV',value:'collision'}]},{variables:[{key:'x',value:'1'},{key:'x',value:'2'}]},{url:'https://evil.test'},{template:'ech',namespaceTitle:'has-no-binding'}])('refuses ambiguous or unsafe creation %j',async patch=>{
        const f=await fixture();await expect(f.planner().prepare('admin',{key:'bad-create',targets:[{account:aid,actions:[{...create(),...patch} as any]}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
    it('rejects duplicate creation in one account rather than using it as an overwrite',async()=>{
        const f=await fixture();await expect(f.planner().prepare('admin',{key:'duplicate',targets:[{account:aid,actions:[create(),create()]}]})).rejects.toThrow('INVALID');
    });
    it('blocks manager creation even when the authority list does not register it',async()=>{
        const f=await fixture();f.policy.workers.push({account:aid,worker:'new-worker'});await expect(f.planner().prepare('admin',{key:'manager',targets:[{account:aid,actions:[create()]}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
});


describe('snapshot-stable existing-target batch planning',()=>{
    const batch=(worker='demo')=>({kind:'deploy_worker' as const,template:'cmliu',worker,ref:'latest',variables:[{key:'UUID',value:'batch-uuid',secret:true}],namespaceTitle:'batch-kv',echTokenEnabled:false});
    it('resolves registered targets to replacement and new targets to creation in one snapshot',async()=>{
        const f=await fixture();const plan=await f.planner().prepare('manager',{key:'batch',targets:[{account:aid,actions:[batch(),batch('new-worker')]}]});
        expect(plan.targets[0].steps).toEqual(['replace_worker','create_worker']);
        expect(plan.expected).toEqual([{domain:'accounts',revision:1},{domain:'template:cmliu',revision:0},{domain:'upstream:cmliu',revision:0}]);
        expect((plan.targets[0].operation as any).operation.commands.map((c:any)=>c.kind)).toEqual(['replace_worker','create_worker']);
        expect(f.transport).toHaveBeenCalledTimes(2);
        const secret=new Uint8Array(32).fill(3), dispatch=new TaskDispatch(f.db,secret);
        await new TaskPreparation(f.config,new SealedStore(f.db,ring),dispatch,secret).submit(plan);
        expect(dispatch.reserve()[0].steps).toEqual(['replace_worker','create_worker']);
    });
    it('allows explicit replacement only for an already registered target',async()=>{
        const f=await fixture();const plan=await f.planner().prepare('manager',{key:'replace',targets:[{account:aid,actions:[{...batch(),kind:'replace_worker'}]}]});
        expect(plan.targets[0].steps).toEqual(['replace_worker']);
        await expect(f.planner().prepare('manager',{key:'missing',targets:[{account:aid,actions:[{...batch('missing'),kind:'replace_worker'}]}]})).rejects.toThrow('INVALID');
    });
    it.each(['replace_worker','deploy_worker'] as const)('refuses cross-template ownership for %s',async kind=>{
        const f=await fixture();const row=f.config.read(['accounts']).records[0];
        const values=JSON.parse(JSON.stringify(row.value));values[0].workers_joey=['demo'];
        f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:values}]);
        await expect(f.planner().prepare('manager',{key:'ambiguous',targets:[{account:aid,actions:[{...batch(),kind}]}]})).rejects.toThrow('INVALID');
        expect(f.transport).not.toHaveBeenCalled();
    });
    it('uses the registry mutation barrier instead of changing mode after source await',async()=>{
        const f=await fixture();f.transport.mockImplementationOnce(async()=>{
            const row=f.config.read(['accounts']).records[0];const values=JSON.parse(JSON.stringify(row.value));values[0].workers_cmliu=[];
            f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:values}]);return Response.json({sha});
        });
        await expect(f.planner().prepare('manager',{key:'race',targets:[{account:aid,actions:[batch()]}]})).rejects.toThrow('CONFLICT');
    });
    it.each(['replace_worker','deploy_worker'] as const)('blocks management Worker for %s before source lookup',async kind=>{
        const f=await fixture();f.policy.workers.push({account:aid,worker:'demo'});
        await expect(f.planner().prepare('manager',{key:'protected-batch',targets:[{account:aid,actions:[{...batch(),kind}]}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
});


describe('atomic manual-clear and account-wide fuse planning',()=>{
    const fuse=()=>({kind:'fuse' as const,template:'cmliu',echTokenEnabled:false});
    const clear=()=>({key:'clear-once',targets:[{account:aid,actions:['demo','second'].map(worker=>({...action(),worker,overrides:'clear' as const}))}]});
    const task=(f:Awaited<ReturnType<typeof fixture>>)=>new TaskPreparation(f.config,new SealedStore(f.db,ring),new TaskDispatch(f.db,new Uint8Array(32).fill(3)),new Uint8Array(32).fill(3));
    it('manual clear freezes global values and atomically tombstones the whole account override once',async()=>{
        const f=await fixture(),plan=await f.planner().prepare('admin',clear());
        expect(plan.changes).toEqual([{domain:'override:cmliu:'+aid,expectedRevision:3,value:null}]);
        expect(f.config.read(['override:cmliu:'+aid]).records[0].revision).toBe(3);
        for(const c of (plan.targets[0].operation as any).operation.commands) expect(c.variables.find((v:any)=>v.key==='UUID').value).toBe('global');
        const prep=task(f),first=await prep.submit(plan);await expect(prep.submit(plan)).resolves.toEqual({id:first.id,duplicate:true});
        expect(f.config.read(['override:cmliu:'+aid]).records[0]).toMatchObject({revision:4,value:null});
        expect(f.db.rows('SELECT * FROM config_outbox WHERE domain=? AND revision=4','override:cmliu:'+aid)).toHaveLength(1);
    });
    it('no-op clear does not create a tombstone revision for an already absent override',async()=>{
        const f=await fixture();f.config.compareAndSet('g1',[{domain:'override:cmliu:'+aid,expectedRevision:3,value:null}]);
        expect((await f.planner().prepare('admin',clear())).changes).toBeUndefined();
    });
    it.each(['subset','duplicate','mixed'])('refuses %s manual clear before upstream reads',async mode=>{
        const f=await fixture(),input=clear();
        if(mode==='subset')input.targets[0].actions.pop();
        if(mode==='duplicate')input.targets[0].actions[1].worker='demo';
        if(mode==='mixed')(input.targets[0].actions[1] as any).overrides='apply';
        await expect(f.planner().prepare('admin',input)).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
    it('fuse generates one UUID shared by every registered worker and only mutates its account override',async()=>{
        const f=await fixture(),plan=await f.planner().prepare('cron',{key:'fuse-once',targets:[{account:aid,actions:[fuse()]}]});
        const commands=(plan.targets[0].operation as any).operation.commands, rotated=(plan.changes![0].value as any)[0].value;
        expect(rotated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(commands.map((c:any)=>c.worker)).toEqual(['demo','second']);
        expect(commands.map((c:any)=>c.variables.find((v:any)=>v.key==='UUID').value)).toEqual([rotated,rotated]);
        expect(commands.every((c:any)=>c.variables.find((v:any)=>v.key==='PROXYIP').value==='global-proxy')).toBe(true);
        expect(plan.expected).toContainEqual({domain:'deploy:cmliu',revision:0});
        expect(plan.changes).toHaveLength(1);expect(plan.changes![0].domain).toBe('override:cmliu:'+aid);
        await task(f).submit(plan);expect(f.config.read(['vars:cmliu']).records[0].revision).toBe(2);
        expect(f.transport).toHaveBeenCalledTimes(2);
    });
    it('pins the configured fixed commit and preserves UUID secret metadata',async()=>{
        const f=await fixture();f.config.compareAndSet('g1',[{domain:'deploy:cmliu',expectedRevision:0,value:{mode:'fixed',currentSha:sha}},{domain:'override:cmliu:'+aid,expectedRevision:3,value:[{key:'UUID',value:'old',secret:true}]}]);
        const plan=await f.planner().prepare('cron',{key:'fixed',targets:[{account:aid,actions:[fuse()]}]});
        expect(f.transport).toHaveBeenCalledTimes(2);expect(String(f.transport.mock.calls[0][0])).toContain('/commits/'+sha);expect(String(f.transport.mock.calls[1][0])).toContain('/'+sha+'/');
        expect((plan.changes![0].value as any)[0].secret).toBe(true);
    });
    it.each([{mode:'fixed'},{mode:'fixed',currentSha:'latest'},{mode:'custom'},{mode:'fixed',currentSha:'bad'},'bad'])('rejects unsafe saved deployment mode %j',async value=>{
        const f=await fixture();f.config.compareAndSet('g1',[{domain:'deploy:cmliu',expectedRevision:0,value}]);
        await expect(f.planner().prepare('cron',{key:'bad',targets:[{account:aid,actions:[fuse()]}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
    it.each(['duplicate','mixed','protected','empty'])('rejects %s fuse without writing config or reading source',async mode=>{
        const f=await fixture();const actions:any[]=[fuse()];
        if(mode==='duplicate')actions.push(fuse());if(mode==='mixed')actions.push(action());
        if(mode==='protected')f.policy.workers.push({account:aid,worker:'second'});
        if(mode==='empty'){const row=f.config.read(['accounts']).records[0];(row.value as any)[0].workers_cmliu=[];f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:1,value:row.value}]);}
        await expect(f.planner().prepare('cron',{key:'bad',targets:[{account:aid,actions}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
        expect(f.config.read(['override:cmliu:'+aid]).records[0].revision).toBe(3);
    });
    it('concurrent config changes reject clear and do not create a task or overwrite newer values',async()=>{
        const f=await fixture(),plan=await f.planner().prepare('admin',clear());
        f.config.compareAndSet('g1',[{domain:'override:cmliu:'+aid,expectedRevision:3,value:[{key:'UUID',value:'newer'}]}]);
        await expect(task(f).submit(plan)).rejects.toThrow('CONFLICT');expect(f.db.rows('SELECT * FROM dispatch_tasks')).toHaveLength(0);
        expect(f.config.read(['override:cmliu:'+aid]).records[0].value).toEqual([{key:'UUID',value:'newer'}]);
    });
});


describe('complete manual deployment intent',()=>{
    const manual=(source:any={kind:'custom',code:'export default {fetch(){return new Response("manual")}};'})=>({kind:'manual_deploy',template:'cmliu',source,variables:[{key:'UUID',value:'manual-secret',secret:true},{key:'EMPTY',value:'  '}],deletedVariables:['REMOVE'],echTokenEnabled:false,echDisableWorkersDev:false});
    const intent=(a=manual())=>({key:'manual-1',targets:[{account:aid,actions:[a as any]}]});
    it('expands every registered worker, seals custom bytes and atomically clears only the selected override',async()=>{
        const f=await fixture(),plan=await f.planner().prepare('admin',intent());
        expect(f.transport).not.toHaveBeenCalled();expect(plan.targets[0].steps).toEqual(['manual_upload','manual_upload']);
        const commands=(plan.targets[0].operation as any).operation.commands;
        expect(commands.map((c:any)=>c.worker)).toEqual(['demo','second']);
        expect(commands[0]).toMatchObject({artifact:{kind:'custom',code:manual().source.code},variables:[{key:'UUID',value:'manual-secret',secret:true}],deletedVariables:['REMOVE']});
        expect(commands[0].artifact).not.toHaveProperty('commit');expect(commands[1].artifact).toEqual(commands[0].artifact);
        expect(plan.expected).toEqual([{domain:'accounts',revision:1},{domain:'override:cmliu:'+aid,revision:3},{domain:'template:cmliu',revision:0}]);
        expect(plan.changes).toEqual([{domain:'override:cmliu:'+aid,expectedRevision:3,value:null}]);
        const secret=new Uint8Array(32).fill(3),dispatch=new TaskDispatch(f.db,secret),prep=new TaskPreparation(f.config,new SealedStore(f.db,ring),dispatch,secret);
        const accepted=await prep.submit(plan);expect(accepted.duplicate).toBe(false);expect(f.config.read(['override:cmliu:'+aid]).records[0].value).toBe(null);
        expect(f.config.read(['vars:cmliu']).records[0].revision).toBe(2);expect(JSON.stringify(f.sql.prepare('SELECT * FROM sealed_chunks').all())).not.toContain('manual-secret');
    });
    it('freezes explicit deletes with legacy deletion-wins and blank-preserves semantics',async()=>{
        const f=await fixture(),a=manual();a.deletedVariables=['REMOVE','UUID'];const plan=await f.planner().prepare('admin',intent(a));
        expect((plan.targets[0].operation as any).operation.commands[0].variables).toEqual([]);
    });
    it('freezes full upstream SHA once for all workers, not mutable latest URLs',async()=>{
        const f=await fixture(),plan=await f.planner().prepare('admin',intent(manual({kind:'upstream',ref:sha})));
        expect(f.transport).toHaveBeenCalledTimes(2);expect(plan.expected.map(r=>r.domain)).toEqual(['accounts','override:cmliu:'+aid,'template:cmliu','upstream:cmliu']);
        expect((plan.targets[0].operation as any).operation.commands.every((c:any)=>c.artifact.commit===sha)).toBe(true);
    });
    it('copies variables/deletions/custom source before crypto awaits',async()=>{
        const f=await fixture(),a=manual(),pending=f.planner().prepare('admin',intent(a));a.source.code='changed';a.variables[0].value='changed';a.deletedVariables.push('KV');
        const command=(await pending).targets[0].operation as any;expect(command.operation.commands[0]).toMatchObject({variables:[{value:'manual-secret'}],deletedVariables:['REMOVE'],artifact:{code:manual().source.code}});
    });
    it('rejects manager workers before resolving any custom artifact',async()=>{const f=await fixture();f.policy.workers.push({account:aid,worker:'second'});await expect(f.planner().prepare('admin',intent())).rejects.toThrow('INVALID');});
    it('rejects multiple or mixed intents for the same template without removing an override',async()=>{const f=await fixture(),r=intent();r.targets[0].actions.push(action() as any);await expect(f.planner().prepare('admin',r)).rejects.toThrow('INVALID');expect(f.config.read(['override:cmliu:'+aid]).records[0].revision).toBe(3);});
    it.each([
        {source:{kind:'custom',code:'   '}},{source:{kind:'custom',code:'<html>error</html>'}},{source:{kind:'custom',code:'x'.repeat(MAX_SOURCE_BYTES+1)}},
        {source:{kind:'custom',code:'export default {};',commit:sha}},{source:{kind:'upstream',ref:'main'}},{source:{kind:'url',url:'https://evil.test'}},
        {deletedVariables:['X','X']},{deletedVariables:['../X']},{deletedVariables:['KV']},{source:{kind:'custom',code:'\ud800'}},{worker:'only-one'}
    ])('rejects unsafe manual shape #%# before download',async patch=>{const f=await fixture();await expect(f.planner().prepare('admin',intent({...manual(),...patch} as any))).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();});
    it('rejects an override edit during source resolution with no task/config mutation',async()=>{
        const f=await fixture();f.transport.mockImplementationOnce(async()=>{f.config.compareAndSet('g1',[{domain:'override:cmliu:'+aid,expectedRevision:3,value:[]}]);return Response.json({sha});});
        await expect(f.planner().prepare('admin',intent(manual({kind:'upstream',ref:'latest'})))).rejects.toThrow('CONFLICT');
    });
});


describe('1101 immutable repair planning',()=>{
    const repair=(rotateSubdomain=false)=>({kind:'repair' as const,template:'cmliu',workers:['second','demo'],rotateSubdomain});
    it('requires the confirmed complete registry, fixes latest once and freezes one account rotation',async()=>{
        const f=await fixture();const plan=await f.planner().prepare('admin',{key:'repair',targets:[{account:aid,actions:[repair(true)]}]});
        expect(plan.targets[0].steps).toEqual(['repair_worker','repair_worker','change_subdomain']);
        const commands=(plan.targets[0].operation as any).operation.commands;
        expect(commands.map((c:any)=>c.worker)).toEqual(['demo','second',undefined]);
        expect(commands[0]).toMatchObject({artifact:{commit:sha},variables:[{key:'UUID',value:'global'},{key:'PROXYIP',value:'global-proxy'}],echTokenEnabled:true});
        expect(commands[2].subdomain).toMatch(/^repair-[a-f0-9]{24}$/);
        expect(plan.expected.map(r=>r.domain)).toEqual(['accounts','template:cmliu','upstream:cmliu','vars:cmliu']);
        expect(f.transport).toHaveBeenCalledTimes(2);expect(plan.changes).toBeUndefined();
    });
    it.each([['demo'],['demo','demo'],['demo','second','stale'],[]].map(workers=>[workers]))('refuses stale/partial/duplicate confirmations %j',async workers=>{
        const f=await fixture();await expect(f.planner().prepare('admin',{key:'repair',targets:[{account:aid,actions:[{...repair(),workers}]}]})).rejects.toThrow('INVALID');expect(f.transport).not.toHaveBeenCalled();
    });
    it('refuses another action on a repair target and refuses protected-account rotation',async()=>{
        const f=await fixture();await expect(f.planner().prepare('admin',{key:'repair',targets:[{account:aid,actions:[repair(),action()]}]})).rejects.toThrow('INVALID');
        f.policy.workers.push({account:aid,worker:'manager'});
        await expect(f.planner().prepare('admin',{key:'rotate',targets:[{account:aid,actions:[repair(true)]}]})).rejects.toThrow('INVALID');
        expect(f.transport).not.toHaveBeenCalled();
        expect((await f.planner().prepare('admin',{key:'no-rotate',targets:[{account:aid,actions:[repair()]}]})).targets[0].steps).toEqual(['repair_worker','repair_worker']);
    });
    it('does not accept precomputed repair commands from public JSON',async()=>{
        const f=await fixture();for(const kind of ['repair_worker','rotate_subdomain','change_subdomain'])await expect(f.planner().prepare('admin',{key:'forged',targets:[{account:aid,actions:[{...repair(),kind} as any]}]})).rejects.toThrow('INVALID');
    });
});


describe('ECH manual domain step isolation',()=>{
    it('expands one independent workers.dev configuration per frozen manual upload',async()=>{
        const f=await fixture(),row=f.config.read(['accounts']).records[0],value:any=row.value;
        value[0].workers_ech=['ech-one','ech-two'];f.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:row.revision,value}]);
        const plan=await f.planner().prepare('admin',{key:'manual-ech',targets:[{account:aid,actions:[{kind:'manual_deploy',template:'ech',source:{kind:'custom',code:'export default {};'},variables:[],deletedVariables:[],echTokenEnabled:false,echDisableWorkersDev:true}]}]});
        expect(plan.targets[0].steps).toEqual(['manual_upload','configure_domain','manual_upload','configure_domain']);
        expect((plan.targets[0].operation as any).operation.commands.filter((c:any)=>c.kind==='configure_domain')).toEqual(['ech-one','ech-two'].map(worker=>({kind:'configure_domain',template:'ech',worker,enabled:false,hostname:'',zone:''})));
    });
});

describe('short legacy ref input never remains in an executable snapshot',()=>{
 it('accepts a manual favorite prefix and stores a resolved full commit in commands and ledger plans',async()=>{const f=await fixture(),plan=await f.planner().prepare('manager',{key:'short-manual',targets:[{account:aid,actions:[{kind:'manual_deploy',template:'cmliu',source:{kind:'upstream',ref:sha.slice(0,7)},variables:[],deletedVariables:[],echTokenEnabled:false,echDisableWorkersDev:false}]}]});const commands=(plan.targets[0].operation as any).operation.commands;expect(commands.every(c=>c.artifact?.commit===sha)).toBe(true);expect(plan.deployment).toHaveLength(1);expect(plan.deployment![0]).toMatchObject({sha});expect(f.transport.mock.calls[1][0]).toContain('/'+sha+'/');});
 it('resolves a migrated fixed short ref before account-wide fuse',async()=>{const f=await fixture();f.config.compareAndSet('g1',[{domain:'deploy:cmliu',expectedRevision:0,value:{mode:'fixed',currentSha:sha.slice(0,7)}}]);const plan=await f.planner().prepare('cron',{key:'short-fixed-fuse',targets:[{account:aid,actions:[{kind:'fuse',template:'cmliu',echTokenEnabled:false}]}]});expect((plan.targets[0].operation as any).operation.commands.every(c=>c.artifact.commit===sha)).toBe(true);expect(f.transport).toHaveBeenCalledTimes(2);});
});

describe('short source references at each admission boundary', () => {
    it.each(['upload', 'create_worker', 'replace_worker', 'deploy_worker'] as const)('resolves %s input to a full immutable SHA', async kind => {
        const f = await fixture(), ref = sha.slice(0, 12).toUpperCase();
        const intent: BusinessAction = kind === 'upload' ? {...action(), ref}
            : {kind, template:'cmliu', worker:kind === 'create_worker' ? 'new-worker' : 'demo', ref, variables:[], namespaceTitle:'', echTokenEnabled:false};
        const plan = await f.planner().prepare('manager', {key:'short-' + kind, targets:[{account:aid, actions:[intent]}]});
        expect(plan.targets[0]).toMatchObject({operation:{operation:{commands:[{artifact:{commit:sha}}]}}});
        expect(plan.deployment).toHaveLength(1);
        expect(plan.deployment![0]).toMatchObject({sha, mode:'fixed'});
        expect(f.transport.mock.calls[0][0]).toContain('/commits/' + ref.toLowerCase());
        expect(f.transport.mock.calls[1][0]).toContain('/' + sha + '/');
    });
    it('still rejects an abbreviated commit in an executable command', async () => {
        const f = await fixture(), plan = await f.planner().prepare('manager', request());
        const operation = structuredClone((plan.targets[0].operation as any).operation);
        operation.commands[0].artifact.commit = sha.slice(0, 7);
        expect(() => parseBusinessOperation(operation, aid)).toThrow('INVALID');
    });
    it('still rejects an abbreviated SHA in the deployment ledger plan', async () => {
        const f = await fixture(), plan = await f.planner().prepare('manager', request());
        const deployment = structuredClone(plan.deployment!);
        deployment[0].sha = sha.slice(0, 7);
        expect(() => validateDeploymentPlans(deployment, plan.targets)).toThrow('INVALID');
    });
});


describe('frozen template compatibility dates', () => {
    const action = { kind: 'upload' as const, template: 'cmliu', worker: 'demo', ref: 'latest', overrides: 'ignore' as const, echTokenEnabled: false };
    it('freezes the configured date into upload commands and falls back to the template default', async () => {
        const f = await fixture();
        f.config.compareAndSet('g1', [{ domain: 'template:cmliu', expectedRevision: 0, value: { compatibilityDate: '2025-06-01' } }]);
        const plan = await f.planner().prepare('admin', { key: 'compat-frozen', targets: [{ account: aid, actions: [action] }] });
        expect(plan.expected).toContainEqual({ domain: 'template:cmliu', revision: 1 });
        const commands = (plan.targets[0].operation as any).operation.commands;
        expect(commands[0]).toMatchObject({ kind: 'upload', compatibilityDate: '2025-06-01' });
        const g = await fixture();
        const fallback = await g.planner().prepare('admin', { key: 'compat-default', targets: [{ account: aid, actions: [action] }] });
        expect((fallback.targets[0].operation as any).operation.commands[0].compatibilityDate).toBe('2024-04-05');
    });
});
