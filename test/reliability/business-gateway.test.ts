import { afterEach, describe, expect, it, vi } from 'vitest';
import { businessGateway } from '../../src/reliability/business-gateway';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME } from '../../src/reliability/coordinator-rpc';
import { productionEnv, businessAccount } from './production-fixture';
const intent=()=>({key:'fixed-request-key',targets:[{account:businessAccount,actions:[{kind:'delete_worker',template:'cmliu',worker:'demo'}]}]});
function fixture(){
    const env:any={...productionEnv(),ACCESS_CODE:'test-only-login',CONFIG_KV:{get:vi.fn(async(key:string)=>key==='SESSION_test-session'?'test-csrf':null)}};
    const rpc=new CoordinatorRpc(env.RELIABILITY_RPC_SECRET);
    const calls:any[]=[];
    const fetch=vi.fn(async(request:Request)=>{
        expect(request.url).toBe('https://coordinator.internal/v1');
        expect(request.headers.has('cookie')).toBe(false);expect(request.headers.has('x-csrf-token')).toBe(false);
        const parsed=await rpc.verify(await request.json(),name=>name===GLOBAL_OBJECT_NAME);calls.push(parsed.message);
        expect(parsed.message.account).toBe(env.RELIABILITY_MANAGER_ACCOUNT);expect(parsed.message.direction).toBe('gateway-global');
        return Response.json({value:{id:'task-1',duplicate:false}});
    });
    env.RELIABILITY_COORDINATOR={idFromName:(name:string)=>{expect(name).toBe(GLOBAL_OBJECT_NAME);return name;},get:()=>({fetch})};
    const request=(method='POST',pathname='/api/reliability/tasks',value:any=intent(),headers:Record<string,string>={})=>new Request('https://panel.test'+pathname,{method,headers:{cookie:'__Host-auth=test-session','x-csrf-token':'test-csrf','content-type':'application/json',origin:'https://panel.test',...headers},...(method==='GET'?{}:{body:typeof value==='string'?value:JSON.stringify(value)})});
    return {env,fetch,calls,request};
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('unregistered authenticated business gateway',()=>{
    it('submits only validated intent via a fresh signed binding request',async()=>{
        const f=fixture(),response=await businessGateway(f.request(),f.env);
        expect(response.status).toBe(202);expect(response.headers.get('cache-control')).toBe('no-store');expect(f.calls[0].body).toEqual({request:intent()});
    });
    it('queries a task without returning any stored credentials',async()=>{
        const f=fixture();expect((await businessGateway(f.request('GET','/api/reliability/tasks/task-1'),f.env)).status).toBe(200);expect(f.calls[0]).toMatchObject({method:'inspect_task',body:{id:'task-1'}});
    });
    it('requests cancellation without representing it as completed',async()=>{
        const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({value:{id:'task-1',cancellationRequested:true}}));
        const response=await businessGateway(f.request('POST','/api/reliability/tasks/task-1/cancel',{}),f.env);expect(response.status).toBe(202);expect(await response.json()).toEqual({id:'task-1',cancellationRequested:true});
    });
    it.each([['cookie',''],['cookie','__Host-auth=unknown'],['x-csrf-token','wrong'],['x-csrf-token',''],['origin','https://attacker.test'],['origin','http://panel.test'],['sec-fetch-site','cross-site']])('denies invalid %s authentication before reaching the DO',async(header,value)=>{
        const f=fixture();const response=await businessGateway(f.request('POST','/api/reliability/tasks',intent(),{[header]:value}),f.env);expect([401,403]).toContain(response.status);expect(f.fetch).not.toHaveBeenCalled();
    });
    it('does not admit requests when the login secret is absent',async()=>{
        const f=fixture();delete f.env.ACCESS_CODE;expect((await businessGateway(f.request(),f.env)).status).toBe(500);expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each([{scope:'attacker'}, {expected:[]}, {generation:'old'}, {targetsSnapshot:[]}, {operation:{handler:'arbitrary'}}])('does not accept prepared/scope fields %j',async extra=>{
        const f=fixture();expect((await businessGateway(f.request('POST','/api/reliability/tasks',{...intent(),...extra}),f.env)).status).toBe(400);expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each(['{','a'.repeat(120001),JSON.stringify({...intent(),key:'a'.repeat(101)})])('rejects malformed or oversized JSON before signing (%#)',async body=>{
        const f=fixture();expect((await businessGateway(f.request('POST','/api/reliability/tasks',body,{'content-length':'1'}),f.env)).status).toBe(400);expect(f.fetch).not.toHaveBeenCalled();
    });
    it('rejects unsupported content types and parameters',async()=>{
        const f=fixture();expect((await businessGateway(f.request('POST','/api/reliability/tasks',intent(),{'content-type':'text/plain'}),f.env)).status).toBe(400);expect((await businessGateway(f.request('POST','/api/reliability/tasks?scope=attacker'),f.env)).status).toBe(400);expect(f.fetch).not.toHaveBeenCalled();
    });
    it('does not accept arbitrary cancellation bodies or unknown routes',async()=>{
        const f=fixture();for(const body of [{force:true},{},[]]){
            const pathname=Array.isArray(body)||Object.keys(body).length?'/api/reliability/tasks/task-1/cancel':'/api/reliability/execute';
            expect([400,404]).toContain((await businessGateway(f.request('POST',pathname,body),f.env)).status);
        }expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each([[409,'CONFLICT'],[409,'MAINTENANCE'],[503,'MAINTENANCE'],[404,'NOT_READY']] as const)('preserves safe %s business refusal instead of retrying',async(status,error)=>{
        const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({error},{status}));const response=await businessGateway(f.request(),f.env);expect(response.status).toBe(status);expect(await response.json()).toEqual({error});expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('redacts malformed binding errors and does not fall back to legacy KV',async()=>{
        const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({error:'token=do-not-echo'},{status:500}));const response=await businessGateway(f.request(),f.env);expect(response.status).toBe(503);expect(await response.text()).toBe('{"error":"NOT_READY"}');
        expect(f.env.CONFIG_KV.get.mock.calls.every(([key]:[string])=>key.startsWith('SESSION_'))).toBe(true);expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('does not expose raw session-store failures',async()=>{
        const f=fixture();f.env.CONFIG_KV.get.mockRejectedValueOnce(new Error('private cache details'));const response=await businessGateway(f.request(),f.env);expect(response.status).toBe(503);expect(await response.text()).not.toContain('private');expect(f.fetch).not.toHaveBeenCalled();
    });
    it('fails closed with a missing reliability secret',async()=>{
        const f=fixture();delete f.env.RELIABILITY_RPC_SECRET;expect((await businessGateway(f.request(),f.env)).status).toBe(503);expect(f.fetch).not.toHaveBeenCalled();
    });
});


describe('task listing and explicit wake HTTP adapters',()=>{
    it('lists via a fresh signed global request with bounded defaults',async()=>{
        const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({value:{items:[],cursor:null}}));const response=await businessGateway(f.request('GET','/api/reliability/tasks'),f.env);
        expect(response.status).toBe(200);expect(await response.json()).toEqual({items:[],cursor:null});
        // The replacement mock above verifies response forwarding; the next call
        // goes through the signing verifier in the fixture.
        await businessGateway(f.request('GET','/api/reliability/tasks?limit=3&cursor=v2.4.'+'a'.repeat(64)),f.env);
        expect(f.calls[0]).toMatchObject({method:'list_tasks',body:{limit:3,cursor:'v2.4.'+'a'.repeat(64)}});
    });
    it.each(['?limit=0','?limit=51','?limit=01','?limit=1&limit=2','?cursor=','?cursor=x','?scope=other','?cursor=v2.1.'+'a'.repeat(64)+'&cursor=v2.2.'+'b'.repeat(64)])('rejects malformed list query %s before binding',async query=>{
        const f=fixture();expect((await businessGateway(f.request('GET','/api/reliability/tasks'+query),f.env)).status).toBe(400);expect(f.fetch).not.toHaveBeenCalled();
    });
    it('requests a wake without claiming success or unlocking unknown jobs',async()=>{
        const f=fixture();const response=await businessGateway(f.request('POST','/api/reliability/tasks/task-1/wake',{}),f.env);
        expect(response.status).toBe(202);expect(f.calls[0]).toMatchObject({method:'wake_task',body:{id:'task-1'}});
    });
    it.each([{force:true},{reset:true},{scope:'manager'}])('does not accept reset/force fields %j',async body=>{
        const f=fixture();expect((await businessGateway(f.request('POST','/api/reliability/tasks/task-1/wake',body),f.env)).status).toBe(400);expect(f.fetch).not.toHaveBeenCalled();
    });
});


describe('manual custom source through authenticated gateway',()=>{
    const manual=()=>({key:'manual-gateway',targets:[{account:businessAccount,actions:[{kind:'manual_deploy',template:'cmliu',source:{kind:'custom',code:'export default {}; /*'+'x'.repeat(180000)+'*/'},variables:[],deletedVariables:['REMOVE'],echTokenEnabled:false,echDisableWorkersDev:false}]}]});
    it('signs >128KiB custom bytes intact without forwarding browser auth or inventing a SHA',async()=>{
        const f=fixture(),input=manual();const response=await businessGateway(f.request('POST','/api/reliability/tasks',input),f.env);expect(response.status).toBe(202);expect(f.calls[0].body).toEqual({request:input});
    });
    it('rejects oversized aggregate JSON even with a false Content-Length and never calls a DO',async()=>{
        const f=fixture(),input=manual();input.targets[0].actions[0].source.code='x'.repeat(1024*1024);input.targets.push({...input.targets[0],account:'b'.repeat(32)});
        expect((await businessGateway(f.request('POST','/api/reliability/tasks',input,{'content-length':'1'}),f.env)).status).toBe(400);expect(f.fetch).not.toHaveBeenCalled();
    });
});


describe('explicit asynchronous legacy HTTP adapters',()=>{
    const paths=[['/api/deploy?type=cmliu',{variables:[]}],['/api/batch_deploy',{template:'cmliu',workerName:'demo',targetAccounts:['first'],config:{}}],['/api/fix_1101',{type:'cmliu',expectedTargets:[{accountId:businessAccount,workerName:'demo'}]}]] as const;
    it.each(paths)('requires the new protocol before changing response shape: %s',async(path,body)=>{
        const f=fixture(),response=await businessGateway(f.request('POST',path,body),f.env);expect(response.status).toBe(428);expect(await response.json()).toEqual({error:'UPGRADE_REQUIRED',protocol:1});expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each(paths)('submits normalized unresolved intent using a stable key: %s',async(path,body)=>{
        const f=fixture(),response=await businessGateway(f.request('POST',path,body,{'x-reliability-protocol':'1','idempotency-key':'legacy-key'}),f.env);
        expect(response.status).toBe(202);expect(await response.json()).toEqual({id:'task-1',duplicate:false,status:'accepted',statusUrl:'/api/reliability/tasks/task-1',protocol:1});
        expect(f.calls[0].body.request.key).toBe('legacy-key');expect(f.calls[0].body.request).toHaveProperty('operation');expect(f.calls[0].body.request).not.toHaveProperty('targets');
        expect(f.env.CONFIG_KV.get.mock.calls.every(([key]:[string])=>key.startsWith('SESSION_'))).toBe(true);
    });
    it.each(['','bad key','a'.repeat(101)])('never generates a replacement key for malformed identity %s',async key=>{
        const f=fixture();expect((await businessGateway(f.request('POST','/api/deploy?type=cmliu',{}, {'x-reliability-protocol':'1','idempotency-key':key}),f.env)).status).toBe(400);expect(f.fetch).not.toHaveBeenCalled();
    });
    it('authenticates old pages before returning upgrade information',async()=>{
        const f=fixture();expect((await businessGateway(f.request('POST','/api/deploy?type=cmliu',{}, {cookie:''}),f.env)).status).toBe(401);expect(f.fetch).not.toHaveBeenCalled();
    });
    it('does not expose malformed task receipts as successful admission',async()=>{
        const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({value:{id:'https://evil.test',duplicate:false}}));expect((await businessGateway(f.request('POST','/api/deploy?type=cmliu',{}, {'x-reliability-protocol':'1','idempotency-key':'same-key'}),f.env)).status).not.toBe(202);
    });
});


describe('resource endpoint admission without bypass',()=>{
    it.each([
        ['/api/delete_worker',{accountId:businessAccount,workerName:'demo',deleteKv:true},'remove_worker'],
        ['/api/change_subdomain',{accountId:businessAccount,newSubdomain:' New '},'rename_subdomain'],
        ['/api/save_yxip',{type:'cmliu',accountId:businessAccount,rawContent:'nodes'},'nodes']
    ])('requires protocol and uses the same signed admission for %s',async(path,body,kind)=>{
        const f=fixture();expect((await businessGateway(f.request('POST',path,body),f.env)).status).toBe(428);expect(f.fetch).not.toHaveBeenCalled();
        const response=await businessGateway(f.request('POST',path,body,{'x-reliability-protocol':'1','idempotency-key':'resource-key'}),f.env);
        expect(response.status).toBe(202);const intent=f.calls[0].body.request;expect(intent.key).toBe('resource-key');expect(intent.operation?.kind ?? intent.targets?.[0].actions[0].kind).toBe(kind);
        expect(f.env.CONFIG_KV.get.mock.calls.every(([key]:[string])=>key.startsWith('SESSION_'))).toBe(true);
    });
});

describe('unregistered authoritative configuration gateway', () => {
    const edit = () => ({ key: 'config-once', generation: 'g1', epoch: 2, revision: 0, selector: { kind: 'variables', template: 'joey' }, value: [{ key: 'yx', value: 'local-only' }] });
    it('reads a validated selector through manager-scoped signed RPC without KV data reads', async () => {
        const f = fixture();
        const response = await businessGateway(f.request('GET', '/api/reliability/config?kind=variables&template=joey'), f.env);
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
        expect(f.calls[0]).toMatchObject({ method: 'read_config', body: { selector: { kind: 'variables', template: 'joey' } } });
        expect(f.env.CONFIG_KV.get.mock.calls.every(([key]: [string]) => key.startsWith('SESSION_'))).toBe(true);
    });
    it('requires the revision protocol and preserves the exact stable config edit key', async () => {
        const f = fixture();
        expect((await businessGateway(f.request('POST', '/api/reliability/config', edit()), f.env)).status).toBe(428);
        expect(f.fetch).not.toHaveBeenCalled();
        expect((await businessGateway(f.request('POST', '/api/reliability/config', edit(), { 'x-reliability-protocol': '1' }), f.env)).status).toBe(200);
        expect(f.calls[0]).toMatchObject({ method: 'edit_config', body: { request: edit() } });
    });
    it.each(['?kind=auto&kind=accounts', '?kind=accounts&template=joey', '?kind=variables&template=joey&template=cmliu', '?kind=runtime', '?kind=auto&scope=admin', ''])('rejects unsafe config read selector %s', async query => {
        const f = fixture(); expect((await businessGateway(f.request('GET', '/api/reliability/config' + query), f.env)).status).toBe(400); expect(f.fetch).not.toHaveBeenCalled();
    });
    it.each([['cookie', ''], ['x-csrf-token', 'wrong'], ['origin', 'https://evil.test']])('denies configuration mutation without %s authentication', async (header, value) => {
        const f = fixture(); const response = await businessGateway(f.request('POST', '/api/reliability/config', edit(), { 'x-reliability-protocol': '1', [header]: value }), f.env);
        expect([401, 403]).toContain(response.status); expect(f.fetch).not.toHaveBeenCalled();
    });
    it('rejects direct ledger edits, missing revisions and large bodies before signing', async () => {
        const f = fixture(), { revision, ...unstamped } = edit(); expect(revision).toBe(0);
        for (const value of [unstamped, { ...edit(), selector: { kind: 'deploy', template: 'joey' } }, { ...edit(), value: 'x'.repeat(120001) }]) {
            expect((await businessGateway(f.request('POST', '/api/reliability/config', value, { 'x-reliability-protocol': '1' }), f.env)).status).toBe(400);
        } expect(f.fetch).not.toHaveBeenCalled();
    });
    it('preserves config conflicts and never retries a lost edit response or reads old KV', async () => {
        const f = fixture(); f.fetch.mockResolvedValueOnce(Response.json({ error: 'CONFLICT' }, { status: 409 }));
        const request = () => f.request('POST', '/api/reliability/config', edit(), { 'x-reliability-protocol': '1' });
        expect((await businessGateway(request(), f.env)).status).toBe(409);
        f.fetch.mockRejectedValueOnce(new Error('private token unavailable'));
        const response = await businessGateway(request(), f.env); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
        expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.env.CONFIG_KV.get.mock.calls.every(([key]: [string]) => key.startsWith('SESSION_'))).toBe(true);
    });
});

describe('legacy config URL split from durable remote tasks', () => {
    const headers = { 'x-reliability-protocol': '1', 'idempotency-key': 'old-url-new-protocol', 'x-config-generation': 'g1', 'x-config-epoch': '2', 'x-config-revision': '3' };
    it.each([
        ['/api/accounts', [], 'accounts'], ['/api/auto_config', {}, 'auto'], ['/api/settings?type=joey', [], 'variables'],
        ['/api/favorites?type=cmliu', { action: 'remove', item: { sha: 'a'.repeat(40) } }, 'favorites'],
        ['/api/upstream?type=joey', { path: '', branch: '' }, 'upstream'],
        ['/api/save_yxip', { type: 'joey_var', rawContent: 'mock-only' }, 'joey_nodes']
    ])('routes %s to the config CAS instead of creating an external write task', async (url, value, kind) => {
        const f = fixture(); const response = await businessGateway(f.request('POST', url as string, value, headers), f.env);
        expect(response.status).toBe(200); expect(f.calls[0]).toMatchObject({ method: 'edit_config', body: { request: { key: headers['idempotency-key'], revision: 3, generation: 'g1', selector: { kind } } } });
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it.each(['/api/accounts', '/api/auto_config', '/api/settings?type=joey', '/api/favorites?type=cmliu', '/api/upstream?type=joey'])('keeps old pages on %s from saving unversioned state', async url => {
        const f = fixture(); expect((await businessGateway(f.request('POST', url, {}), f.env)).status).toBe(428); expect(f.fetch).not.toHaveBeenCalled();
    });
    it('does not auto-read current config to invent revision headers for Joey nodes', async () => {
        const f = fixture(); const response = await businessGateway(f.request('POST', '/api/save_yxip', { type: 'joey_var', rawContent: 'mock-only' }, { 'x-reliability-protocol': '1', 'idempotency-key': 'once' }), f.env);
        expect(response.status).toBe(400); expect(f.fetch).not.toHaveBeenCalled();
    });
});

describe('authoritative legacy GET adapters',()=>{
 it.each(['/api/accounts','/api/settings?type=cmliu','/api/favorites?type=cmliu','/api/auto_config','/api/deploy_config?type=cmliu','/api/upstream?type=cmliu','/api/deploy_journal'])('serves %s from read_view and includes exact CAS headers without business KV',async path=>{const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({value:{data:[],generation:'g1',epoch:4,revisions:{accounts:7},maintenance:false}}));const response=await businessGateway(f.request('GET',path),f.env);expect(response.status).toBe(200);expect(await response.json()).toEqual([]);expect(response.headers.get('x-config-generation')).toBe('g1');expect(response.headers.get('x-config-revision')).toBe('7');const message:any=await f.fetch.mock.calls[0][0].clone().json();expect(message.method).toBe('read_view');expect(f.env.CONFIG_KV.get.mock.calls.every(([key]:[string])=>key.startsWith('SESSION_'))).toBe(true);});
 it('includes revision vector and separate runtime in init_data instead of asking the frontend to infer revisions',async()=>{const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({value:{data:{accounts:[],autoConfig:{},vars:{},deployConfigs:{},runtime:{revision:2,value:{lastCheck:1}}},generation:'g1',epoch:4,revisions:{accounts:7,autoConfig:3},maintenance:true}}));const r=await businessGateway(f.request('GET','/api/init_data'),f.env),d:any=await r.json();expect(d.reliability).toEqual({generation:'g1',epoch:4,revisions:{accounts:7,autoConfig:3},maintenance:true,protocol:1});expect(d.runtime.value.lastCheck).toBe(1);});
 it.each(['/api/accounts','/api/init_data','/api/upstream?type=cmliu'])('does not use stale KV when authoritative %s fails',async path=>{const f=fixture();f.fetch.mockRejectedValueOnce(new Error('private binding failure'));const r=await businessGateway(f.request('GET',path),f.env);expect(r.status).toBe(503);expect(await r.text()).toBe('{"error":"NOT_READY"}');expect(f.env.CONFIG_KV.get.mock.calls.every(([key]:[string])=>key.startsWith('SESSION_'))).toBe(true);});
 it('does not authorize a legacy POST just because its GET is supported',async()=>{const f=fixture();const r=await businessGateway(f.request('POST','/api/accounts',[]),f.env);expect(r.status).toBe(428);expect(f.fetch).not.toHaveBeenCalled();});
});

describe('authoritative external read gateway',()=>{
 it.each([['GET','/api/stats',undefined,'stats'],['GET','/api/diag',undefined,'diag'],['POST','/api/zones',{accountId:businessAccount},'zones'],['POST','/api/fetch_bindings',{accountId:businessAccount,workerName:'demo'},'bindings'],['GET','/api/check_update?type=cmliu',undefined,'version'],['GET','/api/deploy/preview?type=cmliu',undefined,'preview_targets']])('routes %s %s to signed read-only RPC',async(method,path,body,kind)=>{const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({value:{data:{success:true},generation:'g1',epoch:2,revisions:{accounts:1}}}));const response=await businessGateway(f.request(method as string,path as string,body),f.env);expect(response.status).toBe(200);const envelope:any=await f.fetch.mock.calls[0][0].clone().json();expect(envelope.method).toBe('read_external');expect(envelope.body.request.kind).toBe(kind);expect(response.headers.get('x-config-generation')).toBe('g1');expect(f.env.CONFIG_KV.get.mock.calls.every(([key]:[string])=>key.startsWith('SESSION_'))).toBe(true);});
 it('does not downgrade read conflict into stale KV or generic success',async()=>{const f=fixture();f.fetch.mockResolvedValueOnce(Response.json({error:'CONFLICT'},{status:409}));const r=await businessGateway(f.request('GET','/api/stats'),f.env);expect(r.status).toBe(409);expect(await r.json()).toEqual({error:'CONFLICT'});expect(f.env.CONFIG_KV.get.mock.calls.every(([key]:[string])=>key.startsWith('SESSION_'))).toBe(true);});
 it('rejects caller credentials and foreign origin before external read RPC',async()=>{const f=fixture();expect((await businessGateway(f.request('POST','/api/zones',{accountId:businessAccount,apiToken:'caller'}),f.env)).status).toBe(400);expect((await businessGateway(f.request('POST','/api/zones',{accountId:businessAccount},{origin:'https://evil.test'}),f.env)).status).toBe(403);expect(f.fetch).not.toHaveBeenCalled();});
});

 describe('account transfer gateway without legacy business KV',()=>{
 const headers={'x-reliability-protocol':'1','idempotency-key':'import-once','x-config-generation':'g1','x-config-epoch':'2','x-config-revision':'1'};
 it('routes imports only to authenticated edit_config with original CAS identity',async()=>{const f=fixture();f.fetch.mockImplementationOnce(async request=>{const parsed=await new CoordinatorRpc(f.env.RELIABILITY_RPC_SECRET).verify(await request.json(),name=>name===GLOBAL_OBJECT_NAME);expect(parsed.message.method).toBe('edit_config');expect(parsed.message.body).toMatchObject({request:{key:'import-once',selector:{kind:'accounts_import'},generation:'g1',epoch:2,revision:1,value:{file:[]}}});return Response.json({value:{domain:'accounts',generation:'g1',epoch:2,revision:2,success:true}});});expect((await businessGateway(f.request('POST','/api/accounts/import',{file:[]},headers),f.env)).status).toBe(200);expect(f.env.CONFIG_KV.get.mock.calls.every(([key]:[string])=>key.startsWith('SESSION_'))).toBe(true);});
 it.each([['cookie',''],['x-csrf-token',''],['origin','https://attacker.test']])('requires import authentication %s',async(header,value)=>{const f=fixture();const r=await businessGateway(f.request('POST','/api/accounts/import',{file:[]},{...headers,[header]:value}),f.env);expect([401,403]).toContain(r.status);expect(f.fetch).not.toHaveBeenCalled();});
 it('rejects legacy protocol and extra query without sending an RPC',async()=>{const f=fixture();expect((await businessGateway(f.request('POST','/api/accounts/import',[]),f.env)).status).toBe(428);expect((await businessGateway(f.request('POST','/api/accounts/import?merge=alias',[],headers),f.env)).status).toBe(400);expect(f.fetch).not.toHaveBeenCalled();});
 it('exports only signed read_view results with no-store and authority attachment metadata',async()=>{const f=fixture();f.fetch.mockImplementationOnce(async request=>{const parsed=await new CoordinatorRpc(f.env.RELIABILITY_RPC_SECRET).verify(await request.json(),name=>name===GLOBAL_OBJECT_NAME);expect(parsed.message).toMatchObject({method:'read_view',body:{selector:{kind:'accounts_export'}}});return Response.json({value:{data:{format:'cfauto.accounts',version:2,accounts:[],keyIds:[]},generation:'g1',epoch:2,revisions:{accounts:1},maintenance:false}});});const r=await businessGateway(f.request('GET','/api/accounts/export'),f.env);expect(r.status).toBe(200);expect(r.headers.get('content-disposition')).toContain('accounts-v2.json');expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('x-config-revision')).toBe('1');});
 });


it.each(['GET','POST'])('rejects malformed Origin on %s as a client refusal, without querying sessions or the DO', async method => {
 const f=fixture(),response=await businessGateway(f.request(method,'/api/reliability/tasks',intent(),{origin:'not a valid origin'}),f.env);
 expect(response.status).toBe(403);expect(f.fetch).not.toHaveBeenCalled();
});
