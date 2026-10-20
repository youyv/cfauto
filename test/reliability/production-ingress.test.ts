import {afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('cloudflare:workers',()=>({DurableObject:class {constructor(public ctx:any,public env:any){}}}));
import worker,{ProductionCoordinator} from '../../src/index';
import {getRoute,listRoutes} from '../../src/routes/register';
import {productionEnv,businessAccount} from './production-fixture';
import {productionConfig} from '../../src/reliability/production-config';
import {ConfigStore} from '../../src/reliability/config-store';
import {TaskDispatch} from '../../src/reliability/task-dispatch';
import {CredentialAuthority} from '../../src/reliability/credential-authority';
import {migrateCredentialAccounts} from '../../src/reliability/credential-accounts';
import {GLOBAL_OBJECT_NAME} from '../../src/reliability/coordinator-rpc';
import {signMaintenance} from '../../src/reliability/maintenance-protocol';
import {reliabilityConfigured} from '../../src/reliability/production-ingress';
import {manifestDigest,canonical} from '../../src/reliability/protocol';
import {sqliteFixture} from './sqlite-fixture';
const opened:ReturnType<typeof sqliteFixture>[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();opened.splice(0).forEach(f=>f.sql.close());});
function fixture(){const reads:string[]=[],kv={get:vi.fn(async(key:string)=>{reads.push(key);if(key==='SESSION_session')return 'csrf';throw Error('BUSINESS_KV_FORBIDDEN');}),put:vi.fn(async()=>{throw Error('BUSINESS_KV_FORBIDDEN');}),delete:vi.fn(async()=>{throw Error('BUSINESS_KV_FORBIDDEN');}),list:vi.fn(async()=>{throw Error('BUSINESS_KV_FORBIDDEN');})},env:any={...productionEnv(),CONFIG_KV:kv,ACCESS_CODE:'local-login',RELIABILITY_MAINTENANCE_KEYS:canonical({operators:{ops:{secret:'c'.repeat(64),permissions:['inspect']}}})};const entries=new Map<string,any>(),promises:Promise<any>[]=[];const identity=(name:string)=>({toString:()=>name,equals:(other:any)=>other.toString()===name});
 const get=(name:string)=>{if(entries.has(name))return entries.get(name);const f=sqliteFixture();opened.push(f);const ctx={id:identity(name),waitUntil:(p:Promise<any>)=>promises.push(p),blockConcurrencyWhile:(fn:any)=>fn(),storage:{sql:{exec:(q:string,...p:any[])=>({toArray:()=>f.db.rows(q,...p)})},transactionSync:(fn:any)=>f.db.transaction(fn),setAlarm:vi.fn(async()=>{})}};const value={...f,ctx,object:new ProductionCoordinator(ctx,env)};entries.set(name,value);return value;};env.RELIABILITY_COORDINATOR={idFromName:identity,get:(id:any)=>({fetch:(r:Request)=>get(id.toString()).object.fetch(r)})};
 const request=(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>new Request('https://panel.test'+path,{method,headers:{cookie:'__Host-auth=session','x-csrf-token':'csrf',origin:'https://panel.test','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const ctx={waitUntil:(p:Promise<any>)=>promises.push(p)} as ExecutionContext;
 const call=(path:string,method='GET',body?:unknown,headers?:Record<string,string>)=>worker.fetch(request(path,method,body,headers),env,ctx);
 const seed=async()=>{const g=get(GLOBAL_OBJECT_NAME),config=new ConfigStore(g.db),settings=productionConfig(env),dispatch=new TaskDispatch(g.db,new TextEncoder().encode(settings.idempotencySecret)),authority=new CredentialAuthority(g.db,config,dispatch,settings.credentials);const value=await migrateCredentialAccounts([{accountId:businessAccount,alias:'test',email:'',apiToken:'test-only-token',authMode:'token',workers_cmliu:['demo']}],settings.credentials,'plaintext'),record={domain:'accounts',revision:1,value:value as any};config.beginImport('g1',await manifestDigest([record]),1);config.stage('g1',record);await config.activateInitial('g1',0);await authority.initialize('g1',1);config.setMaintenance(false,1);return {g,config,dispatch};};return {env,kv,reads,request,call,seed,get,ctx,promises};}
describe('real production index authority ingress, not route stubs',()=>{
 it('reads authority, admits a real task and serves the registered persistent task routes without business KV',async()=>{const f=fixture(),{dispatch}=await f.seed();vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('external call forbidden during admission');}));const accounts=await f.call('/api/accounts');expect(accounts.status).toBe(200);expect(accounts.headers.get('x-reliability-protocol')).toBe('1');expect((await accounts.json() as any)[0].apiToken).toBe('***');const task=await f.call('/api/reliability/tasks','POST',{key:'http-entry',targets:[{account:businessAccount,actions:[{kind:'delete_worker',template:'cmliu',worker:'demo'}]}]});expect(task.status).toBe(202);const accepted=await task.json() as any;expect(dispatch.inspect(accepted.id)[0].state).toBe('pending');expect(getRoute('GET','/api/reliability/tasks/'+accepted.id)).not.toBeNull();const detail=await f.call('/api/reliability/tasks/'+accepted.id);expect(detail.status).toBe(200);expect((await detail.json() as any).id).toBe(accepted.id);expect((await f.call('/api/reliability/tasks')).status).toBe(200);expect(f.reads.every(k=>k.startsWith('SESSION_'))).toBe(true);expect(f.kv.put).not.toHaveBeenCalled();expect(f.kv.delete).not.toHaveBeenCalled();expect(f.kv.list).not.toHaveBeenCalled();});
 it('accepts a worker-list account edit that echoes read-model statistics (accountId) from /api/stats',async()=>{const f=fixture();await f.seed();const read=await f.call('/api/accounts');expect(read.status).toBe(200);const headers={'x-reliability-protocol':'1','idempotency-key':'account-edit-1','x-config-generation':read.headers.get('x-config-generation')!,'x-config-epoch':read.headers.get('x-config-epoch')!,'x-config-revision':read.headers.get('x-config-revision')!};const accounts=await read.json() as any[];expect(accounts[0].apiToken).toBe('***');
  // Simulate the panel after 刷新用量: state.accounts[].stats now carries the /api/stats display object.
  accounts[0].workers_cmliu=['demo','second'];accounts[0].stats={accountId:businessAccount,alias:'test',total:12,max:100000};
  const response=await f.call('/api/accounts','POST',accounts,headers);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({domain:'accounts',duplicate:false});
  const saved=await (await f.call('/api/accounts')).json() as any[];expect(saved[0].workers_cmliu).toEqual(['demo','second']);expect(saved[0].stats).toMatchObject({accountId:businessAccount,total:12,max:100000});});
 it('refuses every registered legacy business path when authority configuration is incomplete, including direct registry access',async()=>{const f=fixture();delete f.env.RELIABILITY_RPC_SECRET;for(const route of listRoutes()){if(route==='POST /api/login')continue;const [method,pattern]=route.split(' '),path=pattern.replace(':id','task');const request=f.request(path,method,method==='POST'?{}:undefined);expect((await getRoute(method,path)!(request,f.env)).status,route).toBe(503);}expect(f.reads).toEqual([]);expect(f.kv.put).not.toHaveBeenCalled();expect(f.kv.list).not.toHaveBeenCalled();});
 it('routes every registered authority business API away from KV even with valid bindings and no active generation',async()=>{const f=fixture(),external=vi.fn(async()=>{throw Error('unexpected public network');});vi.stubGlobal('fetch',external);for(const route of listRoutes()){if(['POST /api/login','POST /api/reliability/maintenance','GET /api/get_regions_data'].includes(route))continue;const [method,pattern]=route.split(' '),path=pattern.replace(':id','task');const result=await f.call(path,method,method==='POST'?{}:undefined);expect(result.status>=400||['/api/reliability/recovery','/api/reliability/tasks'].includes(path)&&method==='GET',route).toBe(true);}expect(f.reads.every(k=>k==='SESSION_session')).toBe(true);expect(f.kv.put).not.toHaveBeenCalled();expect(f.kv.delete).not.toHaveBeenCalled();expect(f.kv.list).not.toHaveBeenCalled();expect(external).not.toHaveBeenCalled();});
 it('rejects all retired KV backup/restore calls and exposes only a workflow descriptor, not a downloadable backup',async()=>{const f=fixture();await f.seed();for(const [method,path] of [['GET','/api/backup'],['POST','/api/restore'],['POST','/api/restore/preview'],['GET','/api/restore/snapshot?id=old']]){const r=await f.call(path,method,method==='POST'?{ACCOUNTS:[]}:undefined);expect(r.status).toBe(409);expect(await r.json()).toMatchObject({error:'INDEPENDENT_MAINTENANCE_REQUIRED'});}const guide=await f.call('/api/reliability/recovery');expect(await guide.json()).toMatchObject({mode:'authority',status:{generation:'g1',browserMutationAllowed:false,activationPerformed:false}});expect(f.kv.put).not.toHaveBeenCalled();expect(f.kv.list).not.toHaveBeenCalled();});
 it('keeps independent maintenance before cookies and denies unsigned requests without consulting sessions',async()=>{const f=fixture();delete f.env.ACCESS_CODE;const message=await signMaintenance({version:1,target:{account:f.env.RELIABILITY_MANAGER_ACCOUNT,worker:f.env.RELIABILITY_MANAGER_WORKER,namespace:f.env.RELIABILITY_CONFIG_NAMESPACE},operator:'ops',at:Date.now(),nonce:'nonce',command:{id:'status-entry',action:'status',expected:null,args:{}}},'c'.repeat(64));expect((await f.call('/api/reliability/maintenance','POST',message,{cookie:''})).status).toBe(200);expect((await f.call('/api/reliability/maintenance','POST',{}, {cookie:''})).status).toBe(403);expect(f.reads).toEqual([]);});
 it('uses platform scheduled timestamps for persistent Cron and never falls back on binding failure',async()=>{const f=fixture(),{g}=await f.seed();await worker.scheduled({scheduledTime:Date.now()} as ScheduledEvent,f.env,f.ctx);await Promise.all(f.promises);expect(g.db.rows('SELECT id FROM automation_cycles')).toHaveLength(1);expect(f.reads).toEqual([]);const broken=fixture();delete broken.env.RELIABILITY_RPC_SECRET;const log=vi.spyOn(console,'error').mockImplementation(()=>{});await worker.scheduled({scheduledTime:Date.now()} as ScheduledEvent,broken.env,broken.ctx);await expect(Promise.all(broken.promises)).rejects.toThrow('NOT_READY');expect(broken.reads).toEqual([]);expect(broken.kv.put).not.toHaveBeenCalled();log.mockRestore();});
 it('requires explicit legacy mode, rejects mixing it with reliability slots and never honors a request mode override',async()=>{const f=fixture();expect(reliabilityConfigured({CONFIG_KV:f.kv} as any)).toBe(true);expect(reliabilityConfigured({CONFIG_KV:f.kv,CFAUTO_STORAGE_MODE:'legacy'} as any)).toBe(false);expect(reliabilityConfigured({CONFIG_KV:f.kv,CFAUTO_STORAGE_MODE:'legacy',RELIABILITY_typo:'x'} as any)).toBe(true);const env:any={CONFIG_KV:f.kv,ACCESS_CODE:'local-login',CFAUTO_STORAGE_MODE:'legacy'};const r=await worker.fetch(f.request('/api/reliability/recovery'),env,f.ctx);expect(await r.json()).toMatchObject({mode:'legacy'});delete env.CFAUTO_STORAGE_MODE;expect((await worker.fetch(f.request('/api/accounts','GET',undefined,{'x-storage-mode':'legacy'}),env,f.ctx)).status).toBe(503);expect(f.reads.every(k=>k.startsWith('SESSION_'))).toBe(true);});
});


describe('editable per-template compatibility dates through the real authority ingress', () => {
    it('serves defaults in init_data and commits a template date with the config CAS protocol', async () => {
        const f = fixture();
        await f.seed();
        const init = await f.call('/api/init_data');
        expect(init.status).toBe(200);
        const body = await init.json() as any;
        expect(body.templateSettings).toMatchObject({
            cmliu: { compatibilityDate: '2024-04-05' },
            joey: { compatibilityDate: '2026-01-20' },
            ech: { compatibilityDate: '2024-04-05' }
        });
        const read = await f.call('/api/reliability/config?kind=template&template=joey');
        expect(read.status).toBe(200);
        const current = await read.json() as any;
        expect(current).toMatchObject({ generation: 'g1', epoch: 2, revision: 0, value: { compatibilityDate: '2026-01-20' } });
        const saved = await f.call('/api/reliability/config', 'POST', { key: 'compat-joey-1', generation: current.generation, epoch: current.epoch, revision: current.revision, selector: { kind: 'template', template: 'joey' }, value: { compatibilityDate: '2025-12-01' } }, {
            'x-reliability-protocol': '1',
            'idempotency-key': 'compat-joey-1',
            'x-config-generation': current.generation,
            'x-config-epoch': String(current.epoch),
            'x-config-revision': String(current.revision)
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toMatchObject({ domain: 'template:joey', revision: 1, duplicate: false });
        const after = await f.call('/api/reliability/config?kind=template&template=joey');
        expect(await after.json()).toMatchObject({ revision: 1, value: { compatibilityDate: '2025-12-01' } });
    });
});
