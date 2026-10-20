import {sendCoordinatorRpc} from '../../../src/reliability/production-rpc';
import { ExternalReads } from '../../../src/reliability/external-reads';
import { AuthorityViews } from '../../../src/reliability/authority-views';
import { ConfigProjection } from '../../../src/reliability/config-projection';
import { TaskCatalog } from '../../../src/reliability/task-catalog';
import { AutomationFlow } from '../../../src/reliability/automation-flow';
import { AutomationPlanner } from '../../../src/reliability/automation-planner';
import { WebhookOutbox } from '../../../src/reliability/webhook-outbox';
import { AutomationCycles } from '../../../src/reliability/automation-cycle';
import { RetainedCustomSource } from '../../../src/reliability/retained-custom-source';
import { DeploymentLedger } from '../../../src/reliability/deployment-ledger';
import { BusinessAdmission } from '../../../src/reliability/business-admission';
import { ApplicationPlanner, parseApplicationIntent, legacyHttpIntent, type ApplicationIntent } from '../../../src/reliability/application-intent';
import { BusinessPlanner } from '../../../src/reliability/business-planner';
import { executeBusinessOperation } from '../../../src/reliability/business-executor';
import { DurableObject } from 'cloudflare:workers';
import { CoordinatorEndpoint, type RoleRuntime } from '../../../src/reliability/coordinator-endpoint';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME, accountObjectName, type CoordinatorRole, type RpcMethod } from '../../../src/reliability/coordinator-rpc';
import { GlobalCoordinatorRuntime, AccountCoordinatorRuntime } from '../../../src/reliability/coordinator-runtime';
import { ConfigStore, type SqlDatabase } from '../../../src/reliability/config-store';
import { CredentialAuthority } from '../../../src/reliability/credential-authority';
import { ConfigEditor } from '../../../src/reliability/config-editor';
import { migrateCredentialAccounts } from '../../../src/reliability/credential-accounts';
import { SealedStore } from '../../../src/reliability/sealed-store';
import { TaskDispatch } from '../../../src/reliability/task-dispatch';
import { TaskPreparation } from '../../../src/reliability/task-preparation';
import { AccountQueue } from '../../../src/reliability/account-queue';
import { fetchWithTimeout } from '../../../src/lib/cloudflare-api';
import { manifestDigest, sha256, type Json } from '../../../src/reliability/protocol';
interface Env { LOCAL_ROLES: DurableObjectNamespace; LOCAL_BUSINESS?: DurableObjectNamespace; LOCAL_RESOURCES?: DurableObjectNamespace; LOCAL_LEDGER?: DurableObjectNamespace; LOCAL_SCRIPT?: DurableObjectNamespace; LOCAL_AUTOMATION?: DurableObjectNamespace; LOCAL_LARGE_SOURCE?: DurableObjectNamespace; LOCAL_HUGE_SOURCE?: DurableObjectNamespace; LOCAL_LARGE_SOURCE_MODE?: boolean; LOCAL_HUGE_SOURCE_MODE?: boolean; LOCAL_HARNESS: string; LOCAL_BUSINESS_MODE?: boolean }
const secret = 'local-role-test-key-never-production-secret';
const ring = { currentId: 'mock', keys: { mock: secret } };
const businessAccount = 'e'.repeat(32);
const hugeAccounts=[businessAccount,...Array.from({length:8},(_,i)=>(i+16).toString(16).padStart(32,'0'))];
const largeCodeCache=new Map<number,string>();
function largeFixtureCode(bytes=1726148):string {let code=largeCodeCache.get(bytes);if(code===undefined){const tail='*/export default {fetch(){return new Response("large-local-only")}};',part=bytes===1726148?'x':'"quoted"\\path\n';code='/*'+part.repeat(Math.ceil(bytes/part.length)).slice(0,bytes-2-tail.length)+tail;largeCodeCache.set(bytes,code);}return code;}
let hugeDigest:Promise<string>|undefined;
const hugeSourceDigest=()=>hugeDigest??=sha256(largeFixtureCode(5142235));
const accounts = ['a1','a2','a3','a4',businessAccount];
/** TEST ONLY. Contains loopback bootstrap/inspection/fault injection. Never deploy. */
export class LocalRoleCoordinator extends DurableObject<Env> {
    #db: SqlDatabase;
    #rpc = new CoordinatorRpc(secret);
    #endpoint: CoordinatorEndpoint;
    #global?: { config: ConfigStore; authority: CredentialAuthority; dispatch: TaskDispatch; runtime: GlobalCoordinatorRuntime };
    #queue?: AccountQueue;
    #flow?: AutomationFlow;
    #admission?: BusinessAdmission<ApplicationIntent>;
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.#db = { rows: <T extends Record<string, unknown>>(query: string, ...params: (string | number | null)[]) => ctx.storage.sql.exec(query, ...params).toArray() as T[], transaction: fn => ctx.storage.transactionSync(fn) };
        this.#db.rows('CREATE TABLE IF NOT EXISTS role_business_source (id INTEGER PRIMARY KEY, code TEXT NOT NULL)');
        this.#db.rows('CREATE TABLE IF NOT EXISTS role_business_workers (name TEXT PRIMARY KEY, code TEXT NOT NULL, bindings TEXT NOT NULL)');
        if(this.env.LOCAL_HUGE_SOURCE_MODE)this.#db.rows('CREATE TABLE IF NOT EXISTS role_huge_sources (name TEXT PRIMARY KEY,bytes INTEGER NOT NULL,digest TEXT NOT NULL)');
        this.#db.rows('CREATE TABLE IF NOT EXISTS role_repair_domains (hostname TEXT PRIMARY KEY, payload TEXT NOT NULL)');
        this.#db.rows('CREATE TABLE IF NOT EXISTS role_repair_state (key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
        this.#db.rows('CREATE TABLE IF NOT EXISTS role_business_namespaces (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
        this.#db.rows('CREATE TABLE IF NOT EXISTS role_resource_values (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        this.#db.rows('CREATE TABLE IF NOT EXISTS role_fixture (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
        this.#endpoint = new CoordinatorEndpoint(this.#db, this.#rpc, name => ctx.id.equals(env.LOCAL_ROLES.idFromName(name)), role => this.#create(role));
    }
    #flag(key: string): number { return this.#db.rows<{ value: number }>('SELECT value FROM role_fixture WHERE key=?',key)[0]?.value ?? 0; }
    #set(key: string, value: number): void { this.#db.rows('INSERT INTO role_fixture VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value); }
    async #send(method: RpcMethod, account: string, body: Json): Promise<Json> {
        if(this.env.LOCAL_HUGE_SOURCE_MODE)return sendCoordinatorRpc(this.env.LOCAL_ROLES,this.#rpc,method,account,body);
        if (method === 'progress' && this.#flag('progressBlocked')) throw new Error('local progress failure');
        if (method === 'complete' && this.#flag('receiptBlocked')) throw new Error('local receipt failure');
        const target = (method === 'deliver' || method === 'cancel') ? accountObjectName(account) : GLOBAL_OBJECT_NAME;
        const response = await this.env.LOCAL_ROLES.get(this.env.LOCAL_ROLES.idFromName(target)).fetch(await this.#rpc.request(method, account, body));
        if (method === 'progress' && this.#flag('loseProgress')) { this.#set('loseProgress',0); throw new Error('local lost progress response'); }
        if (method === 'deliver' && this.#flag('loseDelivery')) { this.#set('loseDelivery',0); throw new Error('local lost delivery response'); }
        if (!response.ok) throw new Error('LOCAL_RPC_REJECTED');
        return (await response.json() as { value: Json }).value;
    }
    #create(role: CoordinatorRole): RoleRuntime {
        const sealed = new SealedStore(this.#db, ring);
        const wakeup = { admit: <T>(fn: () => Promise<T>) => this.ctx.blockConcurrencyWhile(fn), arm: (delay: number) => this.ctx.storage.setAlarm(Date.now() + delay) };
        if (role.role === 'global') {
            const config = new ConfigStore(this.#db), dispatch = new TaskDispatch(this.#db,new TextEncoder().encode(secret)), authority = new CredentialAuthority(this.#db,config,dispatch,ring,()=>Date.now()+this.#flag('credentialTimeOffset'));
            const editor = new ConfigEditor(this.#db,config,authority,ring,new TextEncoder().encode(secret));
            const preparation = new TaskPreparation(config,sealed,dispatch,new TextEncoder().encode(secret));
            const runtime = new GlobalCoordinatorRuntime(this.#db,config,sealed,dispatch,authority,preparation,(...args) => this.#send(...args),wakeup,this.env.LOCAL_BUSINESS_MODE === true);
            this.#global = { config, dispatch, authority, runtime };
            if (this.env.LOCAL_BUSINESS_MODE) this.#admission = new BusinessAdmission(this.#db,config,sealed,dispatch,
                new ApplicationPlanner(config,new BusinessPlanner(config,{ring,protected:{workers:[],namespaces:[]},customSource:new RetainedCustomSource(this.#db,sealed),inventory:async url=>{
                    this.#set('inventoryReads',this.#flag('inventoryReads')+1);
                    if(this.#flag('inventoryOffline'))throw new Error('local inventory offline');
                    const worker=new URL(url).pathname.split('/workers/scripts/')[1]?.split('/')[0];
                    return this.env.LOCAL_ROLES.get(this.env.LOCAL_ROLES.idFromName(accountObjectName(businessAccount))).fetch(new Request('http://127.0.0.1/inventory',{method:'POST',body:JSON.stringify({target:businessAccount,action:'inventoryRead',worker})}));
                },source:{transport:async url=>{
                    this.#set('sourceReads',this.#flag('sourceReads')+1);
                    if(this.#flag('sourceOffline'))throw new Error('local source unavailable');
                    return String(url).startsWith('https://api.github.com/') ? Response.json({sha:(this.#flag('alternateSource')?'b':'a').repeat(40)}) : new Response(this.#flag('largeSource')?largeFixtureCode(this.env.LOCAL_HUGE_SOURCE_MODE?5142235:1726148):'export default {fetch(){return new Response("admission-local")}};');
                }}})),async input=>{
                    const result=await runtime.submit(input);
                    if(this.#flag('loseSubmitAck')){this.#set('loseSubmitAck',0);throw new Error('local lost task response');}
                    return result;
                },new TextEncoder().encode(secret),parseApplicationIntent);
            if(this.env.LOCAL_BUSINESS_MODE) {
                const cycles=new AutomationCycles(this.#db,config,sealed);
                this.#flow=new AutomationFlow(this.#db,config,cycles,sealed,new AutomationPlanner(this.#db,config,cycles,{ring,protected:{workers:[],namespaces:[]},customSource:new RetainedCustomSource(this.#db,sealed),statistics:async()=>[{accountId:businessAccount,alias:'local',total:99,max:100}],source:{transport:async url=>{this.#set('sourceReads',this.#flag('sourceReads')+1);if(this.#flag('sourceOffline'))throw new Error('local source unavailable');return String(url).startsWith('https://api.github.com/')?Response.json({sha:'a'.repeat(40)}):new Response('export default {fetch(){return new Response("automation-local")}};');}}}),dispatch,new WebhookOutbox(this.#db,sealed,{transport:async()=>{this.#set('webhookWrites',this.#flag('webhookWrites')+1);if(this.#flag('loseWebhook'))throw new Error('local lost notice');return Response.json({errcode:0});}}),{submit:async(plan,guard)=>{const task=await runtime.submit(plan,guard);if(this.#flag('loseSubmitAck')){this.#set('loseSubmitAck',0);throw new Error('local lost cron ACK');}return task;},arm:wakeup.arm,now:()=>this.#flag('automationClock')||Date.now()});
            }
            const external=new ExternalReads(config,authority,{ring,transport:async(url,init)=>{
                // LOCAL-ONLY fake provider. No secret or fixture is ever deployed.
                this.#set('externalReadCalls',this.#flag('externalReadCalls')+1);
                if(init.method!=='GET'||init.redirect!=='manual')throw new Error('unsafe local read');
                const target=new URL(url);
                if(target.pathname==='/client/v4/zones'){
                    const page=Number(target.searchParams.get('page'));
                    if(page===1&&this.#flag('revokeRead'))authority.revoke('g1',businessAccount,1);
                    return Response.json({success:true,result:[{id:(page===1?'b':'c').repeat(32),name:(page===1?'one':'two')+'.test'}],result_info:{page,per_page:1,count:1,total_count:2,total_pages:2}});
                }
                if(target.pathname.endsWith('/bindings'))return Response.json({success:true,result:[{type:'secret_text',name:'TOKEN',text:'local-hidden-read-value'},{type:'plain_text',name:'NAME',text:'local-visible-value'}]});
                if(target.pathname.endsWith('/workers/scripts'))return Response.json({success:true,result:[{id:'mock-worker'}]});
                throw new Error('unexpected local external read');
            }});
            const projection=new ConfigProjection(this.#db,config),views=new AuthorityViews(config,ring,projection);
            const catalog=this.#admission?new TaskCatalog(this.#db,dispatch,this.#admission,new TextEncoder().encode(secret),'local-admission'):null;
            if (this.#admission) return {handle:message=>message.method==='read_external'?external.read((message.body as any).request):message.method==='read_view'?views.read((message.body as any).selector):message.method==='list_tasks'?catalog!.list('local-admission',message.body):message.method==='inspect_task'?catalog!.inspect('local-admission',(message.body as any).id):message.method==='cron_cycle'?this.#flow!.start((message.body as any).scheduledAt):message.method==='read_config' ? editor.read((message.body as any).selector)
                : message.method==='edit_config' ? editor.edit((message.body as any).request)
                : message.method==='submit_task' ? this.#admission!.submit('local-admission',(message.body as any).request)
                : runtime.handle(message),tick:async()=>{await runtime.tick();await this.#flow!.tick();if(!this.#flag('holdProjection')&&config.status().generation)projection.consume();}};
            return runtime;
        }
        if (this.env.LOCAL_BUSINESS_MODE && !this.#flag('workerSeeded')) { this.#db.rows('INSERT OR IGNORE INTO role_business_workers VALUES (?,?,?)','mock-worker','export default {};','[]');this.#set('workerSeeded',1); }
        const queue = new AccountQueue(this.#db); this.#queue = queue;
        return new AccountCoordinatorRuntime(this.#db,queue,sealed,role.account,(...args) => this.#send(...args),wakeup,{
            digestSecret: secret,
            businessEffects: this.env.LOCAL_BUSINESS_MODE === true,
            transport: async (url, init) => {
                if (this.env.LOCAL_BUSINESS_MODE) return this.#businessTransport(url,init);
                if (role.account === businessAccount) {
                    this.#set('calls',this.#flag('calls')+1);
                    if (init?.method === 'PUT' && init.body instanceof FormData) {
                        this.#set('businessWrites',this.#flag('businessWrites')+1);
                        const code = await (init.body.get('script') as File).text();
                        this.#db.rows('INSERT INTO role_business_source VALUES (1,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code',code);
                        return Response.json({success:true,result:{}});
                    }
                    if (url.endsWith('/bindings')) return Response.json({success:true,result:[]});
                    return new Response(this.#db.rows<{code:string}>('SELECT code FROM role_business_source WHERE id=1')[0]?.code || '');
                }
                this.#set('calls',this.#flag('calls')+1); if (this.#flag('unknown')) throw new Error('local uncertain write'); return Response.json({ success:true }); },
            execute: async (operation, step) => {
                if (role.account === businessAccount || this.env.LOCAL_HUGE_SOURCE_MODE) return executeBusinessOperation(role.account,operation,step,{workers:[],namespaces:[]});
                const response = await fetchWithTimeout('https://api.cloudflare.com/client/v4/accounts/' + role.account + '/workers/scripts/mock-only', { method:'PUT',body:'mock-only' }); return { outcome:'verified',result:await response.json() as Json }; }
        });
    }
    async #businessTransport(url: string, init?: RequestInit): Promise<Response> {
        this.#set('calls',this.#flag('calls')+1);
        const target = new URL(url), name = target.pathname.split('/workers/scripts/')[1]?.split('/')[0];
        if (init?.method === 'PUT' && init.body instanceof FormData) {
            this.#set('businessWrites',this.#flag('businessWrites')+1);
            const metadata = JSON.parse(init.body.get('metadata') as string);
            if(this.env.LOCAL_HUGE_SOURCE_MODE){
                // The real provider is outside the Worker isolate. Do not model it by
                // retaining another full source in each local DO's SQLite/cache.
                // Validate ALL received bytes, then persist their digest and size;
                // reads reconstruct only this exact immutable, synthetic fixture.
                const bytes=await (init.body.get('script') as File).arrayBuffer(),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
                if(bytes.byteLength!==5142235||digest!==await hugeSourceDigest())throw new Error('LOCAL_PROVIDER_SOURCE_BYTES_CHANGED');
                this.#db.transaction(()=>{this.#db.rows('INSERT INTO role_business_workers VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET code=excluded.code,bindings=excluded.bindings',name,'__local_verified_source__',JSON.stringify(metadata.bindings));this.#db.rows('INSERT INTO role_huge_sources VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes,digest=excluded.digest',name,bytes.byteLength,digest);});
            }else{const code=await (init.body.get('script') as File).text();this.#db.rows('INSERT INTO role_business_workers VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET code=excluded.code,bindings=excluded.bindings',name,code,JSON.stringify(metadata.bindings));}
            if(this.#flag('loseScriptResponse'))throw new Error('local lost script response after mutation');
            return Response.json({success:true,result:{}});
        }
        const valuePath=/\/storage\/kv\/namespaces\/[a-f0-9]{32}\/values\/(.+)$/.exec(target.pathname);
        if(valuePath){
            if(init?.method==='PUT'){this.#set('nodeWrites',this.#flag('nodeWrites')+1);this.#db.rows('INSERT INTO role_resource_values VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',valuePath[1],init.body as string);return Response.json({success:true,result:{}});}
            return new Response(this.#db.rows<{value:string}>('SELECT value FROM role_resource_values WHERE key=?',valuePath[1])[0]?.value || '');
        }
        if(target.pathname.endsWith('/workers/scripts'))return Response.json({success:true,result:this.#db.rows<{name:string}>('SELECT name FROM role_business_workers ORDER BY name').map(r=>({id:r.name}))});
        if(/\/storage\/kv\/namespaces\/[a-f0-9]{32}$/.test(target.pathname) && init?.method==='DELETE'){
            this.#set('namespaceDeletes',this.#flag('namespaceDeletes')+1);this.#db.rows('DELETE FROM role_business_namespaces WHERE id=?',target.pathname.split('/').pop()!);return Response.json({success:true,result:{}});
        }
        if (target.pathname.endsWith('/storage/kv/namespaces')) {
            if (init?.method === 'POST') {
                const { title } = JSON.parse(init.body as string), id = 'c'.repeat(32);
                this.#set('namespaceWrites',this.#flag('namespaceWrites')+1);this.#db.rows('INSERT INTO role_business_namespaces VALUES (?,?)',id,title);
                return Response.json({success:true,result:{id,title}});
            }
            const namespaces=this.#db.rows('SELECT id,title FROM role_business_namespaces');
            return Response.json({success:true,result:namespaces,result_info:{page:1,per_page:100,count:namespaces.length,total_pages:1,total_count:namespaces.length}});
        }
        if (this.#flag('repairMode')) {
            const method=init?.method || 'GET', p=target.pathname;
            const value=(key:string,fallback:unknown)=>JSON.parse(this.#db.rows<{payload:string}>('SELECT payload FROM role_repair_state WHERE key=?',key)[0]?.payload || JSON.stringify(fallback));
            const save=(key:string,payload:unknown)=>this.#db.rows('INSERT INTO role_repair_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',key,JSON.stringify(payload));
            if (p.endsWith('/workers/domains')) {
                if (method==='PUT') { const d={...JSON.parse(init!.body as string),enabled:true,previews_enabled:false};this.#set('domainWrites',this.#flag('domainWrites')+1);this.#db.rows('INSERT INTO role_repair_domains VALUES (?,?) ON CONFLICT(hostname) DO UPDATE SET payload=excluded.payload',d.hostname,JSON.stringify(d));return Response.json({success:true,result:d}); }
                const result=this.#db.rows<{payload:string}>('SELECT payload FROM role_repair_domains ORDER BY hostname').map(r=>JSON.parse(r.payload));
                return Response.json({success:true,result,result_info:{page:1,per_page:100,count:result.length,total_count:result.length}});
            }
            if(p.endsWith('/workers/subdomain')) {
                if(method==='DELETE' || method==='PUT') {this.#set('subdomainWrites',this.#flag('subdomainWrites')+1);save('account',method==='DELETE'?'':JSON.parse(init!.body as string).subdomain);}
                return Response.json({success:true,result:{subdomain:value('account','old-local-subdomain')}});
            }
            if(name && p.endsWith('/subdomain')) {
                if(method==='POST'){this.#set('flagWrites',this.#flag('flagWrites')+1);save(name,JSON.parse(init!.body as string));}
                return Response.json({success:true,result:value(name,{enabled:false,previews_enabled:true})});
            }
            if(name && method==='DELETE') {
                this.#set('workerDeletes',this.#flag('workerDeletes')+1);
                this.#db.rows('DELETE FROM role_business_workers WHERE name=?',name);
                this.#db.rows("DELETE FROM role_repair_domains WHERE json_extract(payload,'$.service')=?",name);
                if(this.#flag('repairLoseDelete')) {this.#set('repairLoseDelete',0);throw new Error('local delete ACK lost');}
                return new Response(null,{status:204}); // Documented script DELETE, still requires absence readback.
            }
        }
        if (init?.method === 'POST') return Response.json({success:false},{status:403}); // Later domain step fails definitively.
        const row = this.#db.rows<{code:string;bindings:string}>('SELECT code,bindings FROM role_business_workers WHERE name=?',name)[0];
        if (!row) return Response.json({success:false,errors:[{code:10007}]},{status:404});
        return url.endsWith('/bindings') ? Response.json({success:true,result:JSON.parse(row.bindings).map((b:any)=>this.#flag('repairMode') && b.type==='secret_text' ? {name:b.name,type:b.type} : b)}) : new Response(this.env.LOCAL_HUGE_SOURCE_MODE&&row.code==='__local_verified_source__'?await this.#hugeProviderCode(name):row.code);
    }
    async #hugeProviderCode(name:string):Promise<string>{const row=this.#db.rows<{bytes:number;digest:string}>('SELECT bytes,digest FROM role_huge_sources WHERE name=?',name)[0];if(row?.bytes!==5142235||row.digest!==await hugeSourceDigest())throw new Error('LOCAL_PROVIDER_PERSISTENCE_CHANGED');return largeFixtureCode(5142235);}
    async alarm(): Promise<void> {
        this.#set('alarms',this.#flag('alarms')+1);
        if (this.#flag('hold')) { await this.ctx.storage.setAlarm(Date.now()+500); return; }
        await this.#endpoint.alarm();
    }
    async fetch(request: Request): Promise<Response> {
        if (new URL(request.url).origin === 'https://coordinator.internal') return this.#endpoint.fetch(request);
        if (this.env.LOCAL_HARNESS !== 'test-only' || !['127.0.0.1','localhost'].includes(new URL(request.url).hostname) || request.method !== 'POST') return new Response('Forbidden',{ status:403 });
        try {
            const body = await request.json() as any;
            const role: CoordinatorRole = body.target === 'global' ? { role:'global' } : { role:'account',account:body.target };
            if (role.role === 'account' && !accounts.includes(role.account) && !(this.env.LOCAL_HUGE_SOURCE_MODE && hugeAccounts.includes(role.account))) return new Response('Forbidden',{ status:403 });
            this.#endpoint.bindTrusted(role);
            let result: unknown;
            if (body.action === 'flags') { for (const name of ['revokeRead','hold','holdProjection','unknown','receiptBlocked','loseDelivery','progressBlocked','loseProgress','loseSubmitAck','sourceOffline','inventoryOffline','repairMode','repairLoseDelete','ledgerFault','alternateSource','loseScriptResponse','loseWebhook']) if (Object.hasOwn(body,name)) this.#set(name,body[name] ? 1 : 0); result = true; }
            else if (body.action === 'bootstrap' && this.#global) {
                const { config,authority } = this.#global;
                if (!config.status().generation) {
                    const imported = await migrateCredentialAccounts((this.env.LOCAL_BUSINESS_MODE ? [businessAccount] : accounts).map(accountId => ({ accountId, alias:accountId,email:'',globalKey:'',apiToken:'mock-only-token',authMode:'token' as const,workers_cmliu:['mock-worker'] })),ring,'plaintext');
                    const records = [{ domain:'accounts',revision:1,value:imported as unknown as Json },...(this.env.LOCAL_BUSINESS_MODE ? [{domain:'vars:cmliu',revision:1,value:[{key:'UUID',value:'local-global-uuid'}] as Json}] : [])];
                    config.beginImport('g1',await manifestDigest(records),records.length); records.forEach(r=>config.stage('g1',r)); await config.activateInitial('g1',0); await authority.initialize('g1',1); config.setMaintenance(false,1);
                }
                result = config.status();
            } else if(body.action==='largeFixtureSetup' && this.env.LOCAL_LARGE_SOURCE_MODE) {
                const names=Array.from({length:this.env.LOCAL_HUGE_SOURCE_MODE?2:6},(_,i)=>'large-worker-'+i);
                if(this.#global){const row=this.#global.config.read(['accounts']).records[0];const value=this.env.LOCAL_HUGE_SOURCE_MODE?await migrateCredentialAccounts(hugeAccounts.map((accountId,i)=>({accountId,alias:'huge-local-'+i,email:'',globalKey:'',apiToken:'huge-local-token',authMode:'token' as const,workers_cmliu:names})),ring,'plaintext'):row.value as any[];if(!this.env.LOCAL_HUGE_SOURCE_MODE)value[0].workers_cmliu=names;this.#global.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:row.revision,value}]);this.#set('largeSource',1);}
                else {this.#set('hold',1);for(const name of names)this.#db.rows('INSERT INTO role_business_workers VALUES (?,?,?)',name,'export default {};','[]');}
                result={workers:names.length,sourceBytes:this.env.LOCAL_HUGE_SOURCE_MODE?5142235:1726148};
            } else if(body.action==='largeSnapshot' && this.env.LOCAL_LARGE_SOURCE_MODE && this.#global) {
                const row=this.#db.rows<{snapshot:string}>('SELECT snapshot FROM dispatch_outbox WHERE task=? AND account=?',body.task,body.account??businessAccount)[0];
                const sealed=new SealedStore(this.#db,ring),context={id:row.snapshot,kind:'task_snapshot' as const,account:body.account??businessAccount,generation:'g1'},value=await sealed.get(context) as any,operation=value.operation.operation;
                result={schema:operation.schema,sources:operation.sources?.length??0,commands:operation.commands.length,bytes:sealed.info(context).bytes,sourceReads:this.#flag('sourceReads'),...(this.env.LOCAL_HUGE_SOURCE_MODE?{decodedBytes:new TextEncoder().encode(JSON.stringify(value)).length}:{})};
            } else if(body.action==='largeProviderStatus' && this.env.LOCAL_LARGE_SOURCE_MODE && this.#queue) {
                const targets=this.#db.rows(this.env.LOCAL_HUGE_SOURCE_MODE?"SELECT COUNT(*) AS targetWorkers,MIN(COALESCE((SELECT p.bytes FROM role_huge_sources p WHERE p.name=w.name),length(CAST(w.code AS BLOB)))) AS minBytes,MAX(COALESCE((SELECT p.bytes FROM role_huge_sources p WHERE p.name=w.name),length(CAST(w.code AS BLOB)))) AS maxBytes FROM role_business_workers w WHERE name!='mock-worker'":"SELECT COUNT(*) AS targetWorkers,MIN(length(CAST(code AS BLOB))) AS minBytes,MAX(length(CAST(code AS BLOB))) AS maxBytes FROM role_business_workers WHERE name!='mock-worker'")[0],retained=this.#db.rows<{code:string;bindings:string}>("SELECT code,bindings FROM role_business_workers WHERE name='mock-worker'")[0];
                result={...this.#db.rows('SELECT COUNT(*) AS workers FROM role_business_workers')[0],...targets,untargetedUnchanged:retained?.code==='export default {};'&&retained.bindings==='[]',writes:this.#flag('businessWrites')};
            } else if (body.action === 'submit' && this.#global) {
                result = await this.#global.runtime.submit({ scope:'local-role',key:body.key,generation:'g1',epoch:this.#global.config.status().epoch,expected:[{ domain:'accounts',revision:1 }],targets:body.accounts.map((account: string) => ({ account,steps:['upload'],operation:{ credentialRevision:1,input:{ now:1000,uuids:[],subdomains:[],sources:{} },operation:{ mocked:true } } })) });
            } else if ((body.action === 'businessSubmit' || body.action === 'businessCreate') && this.#global) {
                const planner = new BusinessPlanner(this.#global.config,{ring,protected:{workers:[],namespaces:[]},source:{transport:async url => String(url).startsWith('https://api.github.com/') ? Response.json({sha:'a'.repeat(40)}) : new Response('export default { fetch() { return new Response("local-only"); } };')}});
                result = await this.#global.runtime.submit(await new ApplicationPlanner(this.#global.config,planner).prepare('local-business',body.action==='businessCreate' ? legacyHttpIntent(new Request('https://local.test/api/batch_deploy',{method:'POST',headers:{'Idempotency-Key':body.key}}),{template:'cmliu',workerName:'created-worker',targetAccounts:[businessAccount],enableKV:true,kvName:'created-kv',config:{}}) : {key:body.key,targets:[{account:businessAccount,actions:body.action === 'businessCreate' ? [{kind:'create_worker',template:'cmliu',worker:'created-worker',ref:'latest',variables:[],namespaceTitle:'created-kv',echTokenEnabled:false},{kind:'configure_domain',template:'cmliu',worker:'created-worker',enabled:true,customPrefix:''}] : [{kind:'upload',template:'cmliu',worker:'mock-worker',ref:'latest',overrides:'apply',echTokenEnabled:false}]}]}));
            } else if(body.action==='ledgerSetup' && this.#global) {
                this.#global.config.compareAndSet('g1',[{domain:'deploy:cmliu',expectedRevision:0,value:{mode:'latest',currentSha:'c'.repeat(40),deployTime:'before-local-test'}}]);
                this.#db.rows("CREATE TRIGGER IF NOT EXISTS local_journal_failure BEFORE INSERT ON config_records WHEN NEW.domain='deployJournal' AND (SELECT value FROM role_fixture WHERE key='ledgerFault')=1 BEGIN SELECT RAISE(ABORT,'local journal transaction failure'); END");result=true;
            } else if(body.action==='ledgerSubmit' && this.#admission) {
                result=await this.#admission.submit('local-admission',{key:body.key,operation:{kind:'manual',accounts:body.partial?[businessAccount]:null,action:{kind:'manual_deploy',template:'cmliu',source:body.custom?{kind:'custom',code:'export default {fetch(){return new Response("retained-local-custom")}};'}:{kind:'upstream',ref:'latest'},variables:[],deletedVariables:[],echTokenEnabled:false,echDisableWorkersDev:false}}});
            } else if(body.action==='customFuse' && this.#admission) {
                result=await this.#admission.submit('local-admission',{key:body.key,targets:[{account:businessAccount,actions:[{kind:'fuse',template:'cmliu',echTokenEnabled:false}]}]});
             } else if(body.action==='automationSetup' && this.#global) {
                const row=this.#global.config.read(['autoConfig']).records[0];this.#global.config.compareAndSet('g1',[{domain:'autoConfig',expectedRevision:row.revision,value:{enabled:body.enabled!==false,interval:1,fuseThreshold:90,fuseWebhook:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=local-test-only'}}]);if(body.now)this.#set('automationClock',body.now);await this.ctx.storage.setAlarm(Date.now()+1000);result=true;
             } else if(body.action==='externalRead' && this.#global) {
                const response=await this.#endpoint.fetch(await this.#rpc.request('read_external','manager',{request:body.request}));result={status:response.status,body:await response.json(),calls:this.#flag('externalReadCalls')};
            } else if(body.action==='view' && this.#global) {
                result=await this.#send('read_view','manager',{selector:body.selector});
            } else if(body.action==='catalog' && this.#global) {
                result=await this.#send('list_tasks','manager',{limit:body.limit??20,cursor:body.cursor??null});
            } else if(body.action==='taskView' && this.#global) {
                result=await this.#send('inspect_task','manager',{id:body.id});
            } else if(body.action==='automationStart' && this.#flow) {
                result=await this.#send('cron_cycle','manager',{scheduledAt:body.scheduledAt});
            } else if(body.action==='automationState' && this.#flow && this.#global) {
                result={flow:this.#flow.inspect(body.cycle),runtime:this.#global.config.readRuntime(),sourceReads:this.#flag('sourceReads'),notices:this.#flag('webhookWrites'),tasks:this.#db.rows('SELECT id FROM dispatch_tasks'),autoRevision:this.#global.config.read(['autoConfig']).records[0].revision};
            } else if(body.action==='cycleOpen' && this.#global) {
                result=await new AutomationCycles(this.#db,this.#global.config,new SealedStore(this.#db,ring)).open(body.scheduledAt,body.now);
            } else if(body.action==='cycleEvidence' && this.#global) {
                const cycles=new AutomationCycles(this.#db,this.#global.config,new SealedStore(this.#db,ring));
                result={digest:await sha256(JSON.stringify(await cycles.read(body.id))),key:cycles.taskKey(body.id,'fuse')};
             } else if(body.action==='notice' && this.#global) {
                const notices=new WebhookOutbox(this.#db,new SealedStore(this.#db,ring),{transport:async()=>{
                    this.#set('webhookWrites',this.#flag('webhookWrites')+1);
                    if(body.loseResponse)throw new Error('local lost webhook response');
                    return Response.json({errcode:0});
                }});
                if(body.operation==='enqueue')result=await notices.enqueue(body.task,'g1','https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=local-test-only');
                else if(body.operation==='send')result=await notices.send(body.id);
                else if(body.operation==='recover'){notices.recover();result=true;}
                else result=notices.inspect(body.id);
            } else if(body.action==='noticeCount') {
                result=this.#flag('webhookWrites');
            } else if(body.action==='sourcePins') {
                result=this.#db.rows('SELECT generation,template,digest,snapshot,account,key_id,task FROM retained_source_references');
            } else if(body.action==='ledgerEvidence' && this.#global) {
                result={config:this.#global.config.read(['deploy:cmliu','deployJournal']),runs:body.task?new DeploymentLedger(this.#db).inspectTask(body.task):[],versions:this.#db.rows('SELECT template,account,worker,source,task FROM deployment_target_versions'),dispatch:body.task?this.#global.dispatch.inspect(body.task):[]};
            } else if(body.action==='resourceSetup' && this.env.LOCAL_BUSINESS_MODE) {
                if(this.#global){const row=this.#global.config.read(['accounts']).records[0], value=structuredClone(row.value) as any;value[0].workers_cmliu=['mock-worker','spare-worker'];this.#global.config.compareAndSet('g1',[{domain:'accounts',expectedRevision:row.revision,value}]);}
                else {this.#set('repairMode',1);for(const worker of ['mock-worker','spare-worker'])this.#db.rows('INSERT INTO role_business_workers VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET bindings=excluded.bindings',worker,'export default {};',JSON.stringify([{name:'KV',type:'kv_namespace',namespace_id:'c'.repeat(32)}]));this.#db.rows('INSERT OR IGNORE INTO role_business_namespaces VALUES (?,?)','c'.repeat(32),'resource-kv');}
                result=true;
            } else if(body.action==='resourceConfigEdit' && this.#global) {
                const row=this.#global.config.read(['vars:cmliu']).records[0];this.#global.config.compareAndSet('g1',[{domain:'vars:cmliu',expectedRevision:row.revision,value:[{key:'UUID',value:'newer-local-edit'}]}]);result=true;
            } else if(body.action==='resourceEvidence' && this.env.LOCAL_BUSINESS_MODE) {
                result={inventoryReads:this.#flag('inventoryReads'),nodeWrites:this.#flag('nodeWrites'),namespaceDeletes:this.#flag('namespaceDeletes'),workerDeletes:this.#flag('workerDeletes'),subdomainWrites:this.#flag('subdomainWrites'),workers:this.#db.rows('SELECT name FROM role_business_workers ORDER BY name'),namespaces:this.#db.rows('SELECT id FROM role_business_namespaces'),values:this.#db.rows('SELECT key,value FROM role_resource_values')};
            } else if(body.action==='inventoryRead' && this.#queue && this.env.LOCAL_BUSINESS_MODE) {
                if(!['mock-worker','spare-worker'].includes(body.worker))return new Response('Forbidden',{status:403});
                return this.#businessTransport('https://api.cloudflare.com/client/v4/accounts/'+businessAccount+'/workers/scripts/'+body.worker+'/bindings',{method:'GET'});
            } else if(body.action==='configSetup' && this.#global && this.env.LOCAL_BUSINESS_MODE) {
                this.#global.config.compareAndSet('g1',[{domain:'autoConfig',expectedRevision:0,value:{enabled:true,interval:30}},{domain:'vars:joey',expectedRevision:0,value:[{key:'other',value:'kept',secret:true}]}]);
                this.#global.config.recordRuntime('config-local-init',{lastCheck:100,lastGc:80});result=true;
            } else if(body.action==='transferAfterObservation' && this.#global && this.env.LOCAL_BUSINESS_MODE) {
                // Local-only clock advance, never a production policy override.
                this.#set('credentialTimeOffset',8*86400000);result=true;
            } else if(body.action==='configRpc' && this.#global && this.env.LOCAL_BUSINESS_MODE) {
                if(!['read_config','edit_config'].includes(body.method))return new Response('Forbidden',{status:403});
                const signed=await this.#rpc.request(body.method,'manager',body.body);
                const response=await this.env.LOCAL_ROLES.get(this.env.LOCAL_ROLES.idFromName(GLOBAL_OBJECT_NAME)).fetch(signed);
                result={status:response.status,body:await response.json() as Json};
                if(body.loseAck && response.ok)throw new Error('local lost config ACK');
            } else if(body.action==='admissionResource' && this.#admission) {
                result=await this.#send('submit_task','manager',{request:legacyHttpIntent(new Request('https://local.test'+body.path,{method:'POST',headers:{'Idempotency-Key':body.key}}),body.body) as unknown as Json});
            } else if(body.action === 'admissionFuse' && this.#admission) {
                result=await this.#admission.submit('local-admission',{key:body.key,targets:[{account:businessAccount,actions:[{kind:'fuse',template:'cmliu',echTokenEnabled:false}]}]});
            } else if(body.action === 'admissionManual' && this.#admission) {
                // Exercise real signed self-binding RPC with >128KiB source bytes.
                result=await this.#send('submit_task','manager',{request:legacyHttpIntent(new Request('https://local.test/api/deploy?type=cmliu',{method:'POST',headers:{'Idempotency-Key':body.key}}),{customCode:'export default {fetch(){return new Response("manual-local")}}; /*'+'x'.repeat(180000)+'*/',variables:[{key:'MANUAL_SECRET',value:'local-only-secret',secret:true}],deletedVariables:['UUID'],echTokenEnabled:false,echDisableWorkersDev:false}) as unknown as Json});
            } else if(body.action === 'repairSetup' && this.env.LOCAL_BUSINESS_MODE) {
                if(this.#global){const row=this.#global.config.read(['vars:cmliu']).records[0];this.#global.config.compareAndSet('g1',[{domain:'vars:cmliu',expectedRevision:row.revision,value:[{key:'UUID',value:'local-global-uuid'},{key:'MANUAL_SECRET',value:'local-only-secret',secret:true}]}]);}
                else {this.#set('repairMode',1);for(const worker of ['created-worker','mock-worker']) {const d={hostname:worker+'.local.test',service:worker,zone_id:'d'.repeat(32),environment:'production',enabled:true,previews_enabled:false};this.#db.rows('INSERT OR IGNORE INTO role_repair_domains VALUES (?,?)',d.hostname,JSON.stringify(d));}}
                result=true;
            } else if(body.action === 'admissionRepair' && this.#admission) {
                result=await this.#send('submit_task','manager',{request:legacyHttpIntent(new Request('https://local.test/api/fix_1101',{method:'POST',headers:{'Idempotency-Key':body.key}}),{type:'cmliu',expectedTargets:['created-worker','mock-worker'].map(workerName=>({accountId:businessAccount,workerName}))}) as unknown as Json});
            } else if(body.action === 'repairEvidence' && this.#queue && this.env.LOCAL_BUSINESS_MODE) {
                result={workerDeletes:this.#flag('workerDeletes'),domainWrites:this.#flag('domainWrites'),flagWrites:this.#flag('flagWrites'),subdomainWrites:this.#flag('subdomainWrites'),domains:this.#db.rows<{payload:string}>('SELECT payload FROM role_repair_domains ORDER BY hostname').map(r=>JSON.parse(r.payload)),flags:this.#db.rows('SELECT key,payload FROM role_repair_state ORDER BY key')};
            } else if(body.action === 'sourceEvidence' && this.#queue && this.env.LOCAL_BUSINESS_MODE) {
                result=await Promise.all(this.#db.rows<{name:string;code:string}>('SELECT name,code FROM role_business_workers ORDER BY name').map(async r=>({name:r.name,bytes:new TextEncoder().encode(r.code).length,digest:await sha256(r.code)})));
            } else if(body.action === 'admissionClear' && this.#admission) {
                result=await this.#admission.submit('local-admission',{key:body.key,targets:[{account:businessAccount,actions:['created-worker','mock-worker'].map(worker=>({kind:'upload',template:'cmliu',worker,ref:'latest',overrides:'clear',echTokenEnabled:false}))}]});
            } else if(body.action === 'configEvidence' && this.#global && this.env.LOCAL_BUSINESS_MODE) {
                result=this.#global.config.read(['vars:cmliu','override:cmliu:'+businessAccount]);
            } else if(body.action === 'bindingEvidence' && this.#queue && this.env.LOCAL_BUSINESS_MODE) {
                result=this.#db.rows<{name:string;bindings:string}>('SELECT name,bindings FROM role_business_workers ORDER BY name').map(r=>({name:r.name,bindings:JSON.parse(r.bindings)}));
            } else if(body.action === 'admissionReplace' && this.#admission) {
                result=await this.#admission.submit('local-admission',{key:body.key,targets:[{account:businessAccount,actions:[{kind:'deploy_worker',template:'cmliu',worker:'created-worker',ref:'latest',variables:[{key:'UUID',value:'replaced-value'}],namespaceTitle:'created-kv',echTokenEnabled:false}]}]});
            } else if(body.action === 'admissionSubmit' && this.#admission) {
                result=await this.#admission.submit('local-admission',{key:body.key,targets:[{account:businessAccount,actions:[{kind:'upload',template:'cmliu',worker:'mock-worker',ref:'latest',overrides:'ignore',echTokenEnabled:false}]}]});
            } else if(body.action === 'admissionIncomplete' && this.#admission) {
                result=await this.#admission.listIncomplete(body.scope || 'local-admission',{limit:body.limit ?? 20,cursor:body.cursor ?? null});
            } else if(body.action === 'admissionRecover' && this.#admission) {
                result=await this.#admission.recover(body.scope || 'local-admission',body.id);
            } else if(body.action === 'admissionInspect' && this.#admission) {
                result=await this.#admission.inspect('local-admission',body.task);
            } else if(body.action === 'admissionCancel' && this.#admission && this.#global) {
                await this.#admission.inspect('local-admission',body.task);
                await this.#global.runtime.requestCancel(body.task);result=true;
            } else if (body.action === 'admissionList' && this.#admission) {
                result=await this.#admission.list(body.scope || 'local-admission',{limit:body.limit,cursor:body.cursor ?? null});
            } else if (body.action === 'wake' && this.#global) {
                if(this.#admission) await this.#admission.inspect('local-admission',body.task);
                await this.#global.runtime.requestWake(body.task);result=true;
            } else if (body.action === 'lastRetry') {
                // Local fault injection only: exercise the final bounded retry using a native alarm.
                await this.ctx.blockConcurrencyWhile(async()=>{
                    await this.ctx.storage.setAlarm(Date.now()+100);
                    this.#db.rows('UPDATE coordinator_alarm SET failures=7 WHERE id=1');
                });result=true;
            } else if (body.action === 'revoke' && this.#global) { this.#global.authority.revoke('g1',body.account,1); result = true; }
            else if (body.action === 'status') result = { retryFailures:this.#db.rows<{failures:number}>('SELECT failures FROM coordinator_alarm WHERE id=1')[0].failures, sourceReads:this.#flag('sourceReads'),admissionTasks:this.#admission ? this.#db.rows('SELECT id FROM dispatch_tasks') : [], namespaceWrites:this.#flag('namespaceWrites'),workers:this.#global && this.env.LOCAL_BUSINESS_MODE ? (this.#global.config.read(['accounts']).records[0].value as any)[0].workers_cmliu : [],facts:this.#global && this.env.LOCAL_BUSINESS_MODE ? this.#db.rows('SELECT task,ordinal,state FROM business_facts ORDER BY seq') : [],calls:this.#flag('calls'),businessWrites:this.#flag('businessWrites'),alarms:this.#flag('alarms'),identity:this.#db.rows('SELECT role FROM coordinator_identity'),tables:this.#db.rows("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"), jobs:this.#queue ? this.#db.rows('SELECT id,state FROM account_jobs') : [],receipts:this.#queue ? this.#db.rows('SELECT task,acknowledged FROM coordinator_receipts') : [],dispatch:this.#global && body.task ? this.#global.dispatch.inspect(body.task) : [],inbox:this.#queue ? this.#db.rows('SELECT task,delivery FROM coordinator_inbox') : [] };
            else if (body.action === 'badAddress') {
                const signed = await this.#rpc.request('deliver','a1',{});
                result = { status:(await this.env.LOCAL_ROLES.get(this.env.LOCAL_ROLES.idFromName(accountObjectName('a2'))).fetch(signed)).status };
            } else return Response.json({ error:'INVALID' },{ status:400 });
            return Response.json({ result });
        } catch (error) { console.error('Local role fixture:',error); return Response.json({ error:'LOCAL_FAILURE' },{ status:500 }); }
    }
}

/** Separate local namespace so mixed protocol fixtures do not bypass business validation. */
export class LocalBusinessCoordinator extends LocalRoleCoordinator {
    constructor(ctx: DurableObjectState, env: Env) { super(ctx,{...env,LOCAL_ROLES:env.LOCAL_BUSINESS!,LOCAL_BUSINESS_MODE:true}); }
}

/** Separate local-only namespace for destructive resource tests, never deployed. */
export class LocalResourceCoordinator extends LocalBusinessCoordinator {
    constructor(ctx:DurableObjectState,env:Env){super(ctx,{...env,LOCAL_BUSINESS:env.LOCAL_RESOURCES!});}
}

/** Isolated local-only ledger faults; no real Cloudflare requests. */
export class LocalLedgerCoordinator extends LocalBusinessCoordinator {
    constructor(ctx:DurableObjectState,env:Env){super(ctx,{...env,LOCAL_BUSINESS:env.LOCAL_LEDGER!});}
}

/** Static script scenario uses business facts, never the legacy mock-kernel protocol. */
export class LocalScriptCoordinator extends LocalBusinessCoordinator {
    constructor(ctx:DurableObjectState,env:Env){super(ctx,{...env,LOCAL_BUSINESS:env.LOCAL_SCRIPT!});}
}

/** Isolated local-only automation crash/replay namespace, never deployed. */
export class LocalAutomationCoordinator extends LocalBusinessCoordinator {
    constructor(ctx:DurableObjectState,env:Env){super(ctx,{...env,LOCAL_BUSINESS:env.LOCAL_AUTOMATION!});}
}

/** Fresh local namespace for real shared-source RPC/restart tests, never deployed. */
export class LocalLargeSourceCoordinator extends LocalBusinessCoordinator {
    constructor(ctx:DurableObjectState,env:Env){super(ctx,{...env,LOCAL_BUSINESS:env.LOCAL_LARGE_SOURCE!,LOCAL_LARGE_SOURCE_MODE:true});}
}

/** Larger payloads use a fresh local-only namespace and the REAL bounded production RPC client. */
export class LocalHugeSourceCoordinator extends LocalBusinessCoordinator {
 constructor(ctx:DurableObjectState,env:Env){super(ctx,{...env,LOCAL_BUSINESS:env.LOCAL_HUGE_SOURCE!,LOCAL_LARGE_SOURCE_MODE:true,LOCAL_HUGE_SOURCE_MODE:true});}
}
