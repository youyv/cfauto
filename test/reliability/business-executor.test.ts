import { TEMPLATES } from '../../src/config/templates';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteFixture } from './sqlite-fixture';
import { AccountQueue } from '../../src/reliability/account-queue';
import { AccountRunner } from '../../src/reliability/account-runner';
import { SealedStore } from '../../src/reliability/sealed-store';
import { executeBusinessOperation } from '../../src/reliability/business-executor';
import { parseBusinessOperation } from '../../src/reliability/business-command';
import { sha256 } from '../../src/reliability/protocol';
const aid='a'.repeat(32),ns='b'.repeat(32),zone='c'.repeat(32),commit='d'.repeat(40);
const secret='test-only-independent-digest-at-least-32-bytes';
const open:ReturnType<typeof sqliteFixture>[]=[];
const ok=(result:any={})=>Response.json({success:true,result});
function textMultipart(entries:[string,string][]){const boundary='cf-text-source';return new Response(entries.map(([name,text])=>'--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"\r\n\r\n'+text+'\r\n').join('')+'--'+boundary+'--\r\n',{headers:{'Content-Type':'multipart/form-data; boundary='+boundary}});}
const policy=()=>({workers:[] as {account:string;worker:string}[],namespaces:[] as {account:string;namespace:string}[]});
async function upload(template='cmliu',code='export default {};') {return {kind:'upload',template,worker:'demo',artifact:{template,repository:template==='ech'?'hc990275/ech-wk':'cmliu/edgetunnel',path:'_worker.js',commit,code,digest:await sha256(code)},variables:[{key:'UUID',value:'private-uuid',secret:true}],echTokenEnabled:false};}
function fixture(commands:any[]) {
    const f=sqliteFixture();open.push(f);const queue=new AccountQueue(f.db),sealed=new SealedStore(f.db,{currentId:'test',keys:{test:secret}});
    const operation={schema:1,account:aid,credential:{email:'',apiToken:'private-token',globalKey:'',authMode:'token'},commands};
    const transport=vi.fn(),authorize=vi.fn(async()=>{}),resources=policy();
    const options={account:aid,generation:'g1',digestSecret:secret,transport,authorize,loadSnapshot:async()=>({input:{now:0,uuids:[],subdomains:[],sources:{}},operation:operation as any}),execute:(op:any,step:any)=>executeBusinessOperation(aid,op,step,resources)};
    queue.enqueue('job1','a'.repeat(64),'snapshot1',commands.map(c=>c.kind));
    const make=()=>new AccountRunner(f.db,queue,sealed,options);
    return {...f,operation,resources,queue,sealed,transport,authorize,options,make};
}
afterEach(()=>{for(const f of open.splice(0))f.sql.close();vi.restoreAllMocks();});
describe('static Cloudflare business executor through durable HTTP journal',()=>{
    it('cannot run outside the account journal',async()=>{
        await expect(executeBusinessOperation(aid,null,{ordinal:0,kind:'delete_worker'},policy())).rejects.toThrow('NOT_READY');
    });
    it('uploads frozen source, preserves KV/plain bindings, writes secrets only from snapshot, and verifies exact code',async()=>{
        const f=fixture([await upload()]);f.transport.mockResolvedValueOnce(ok([{type:'kv_namespace',name:'KV',namespace_id:ns},{type:'plain_text',name:'UNCHANGED',text:'value'},{type:'secret_text',name:'UUID'}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};'));
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.authorize).toHaveBeenCalledTimes(2);expect(f.transport).toHaveBeenCalledTimes(3);
        const call=f.transport.mock.calls[1];expect(call[0]).toBe('https://api.cloudflare.com/client/v4/accounts/'+aid+'/workers/scripts/demo');expect(call[1].method).toBe('PUT');
        expect(JSON.parse(call[1].body.get('metadata'))).toMatchObject({compatibility_date:'2024-04-05',bindings:[{name:'KV',namespace_id:ns},{name:'UNCHANGED',text:'value'},{name:'UUID',type:'secret_text',text:'private-uuid'}]});
        const saved=await f.sealed.get({id:'result_job1_0',kind:'task_snapshot',account:aid,generation:'g1'});expect(JSON.stringify(saved)).not.toMatch(/private-token|private-uuid/);
        expect(JSON.stringify(f.sql.prepare('SELECT * FROM execution_calls').all())).not.toMatch(/private-token|private-uuid/);
    });
    it.each([
        [{type:'secret_text',name:'UNAVAILABLE'}], [{type:'durable_object_namespace',name:'DO',class_name:'Example'}], [{type:'kv_namespace',name:'UUID',namespace_id:ns}], [{type:'plain_text',name:'x',text:'v'},{type:'plain_text',name:'x',text:'w'}], [{type:'kv_namespace',name:'KV',namespace_id:'../elsewhere'}], [{type:'plain_text',name:'x',text:'v',futureField:true}]
    ])('refuses unsafe binding round-trips before upload: %j',async bindings=>{
        const f=fixture([await upload()]);f.transport.mockResolvedValueOnce(ok(bindings));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(1);expect(f.authorize).toHaveBeenCalledTimes(1);
    });
    it.each(['different script','/* export default {}; */ unrelated code'])('does not call mismatched/substrings verified: %s',async readback=>{
        const f=fixture([await upload()]);f.transport.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response(readback));expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport).toHaveBeenCalledTimes(3);
    });
    it('parses multipart entry-module content, rejecting a matching non-entry module',async()=>{
        for(const name of ['index.js','other.js']) {
            const f=fixture([await upload()]);const form=new FormData();form.append('script',new Blob(['export default {};'],{type:'application/javascript'}),name);
            f.transport.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response(form));expect((await f.make().tick())?.state).toBe(name==='index.js'?'succeeded':'needs_review');
        }
    });

    it('verifies provider text-part source for the declared entry module without another PUT on replay',async()=>{const f=fixture([await upload()]);f.transport.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(textMultipart([['index.js','export default {};']]));expect((await f.make().tick())?.state).toBe('succeeded');expect(await f.make().tick()).toBeNull();expect(f.transport.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1);});
    it.each(['metadata','wrong-name','duplicate'])('rejects ambiguous or non-entry provider text source: %s',async mode=>{const f=fixture([await upload()]),entries:[string,string][]=mode==='duplicate'?[['index.js','export default {};'],['index.js','export default {};']]:[[mode==='metadata'?'metadata':'other.js','export default {};']];f.transport.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(textMultipart(entries));expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBeNull();});

    it.each(['file','text','raw'])('refuses matching %s code when provider declares a different entrypoint',async kind=>{const f=fixture([await upload()]);let response:Response;if(kind==='file'){const form=new FormData();form.append('script',new Blob(['export default {};']), 'index.js');response=new Response(form);}else response=kind==='text'?textMultipart([['index.js','export default {};']]):new Response('export default {};');response.headers.set('cf-entrypoint','other.js');f.transport.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(response);expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBeNull();});
    it('replays durable successful calls after crash before task result, not another upload',async()=>{
        const f=fixture([await upload()]);f.transport.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};'));await f.make().tick();
        f.sql.exec("DELETE FROM sealed_chunks WHERE id='result_job1_0'; DELETE FROM sealed_objects WHERE id='result_job1_0'; UPDATE account_jobs SET state='running'; UPDATE account_steps SET state='in_flight',evidence=NULL");
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport).toHaveBeenCalledTimes(3);
    });
    it.each(['lost','malformed','gateway'])('retains unknown after %s mutation response and blocks later commands',async failure=>{
        const f=fixture([await upload(),{kind:'change_subdomain',subdomain:'next-domain'}]);f.transport.mockResolvedValueOnce(ok([]));if(failure==='lost')f.transport.mockRejectedValueOnce(new Error('secret-response'));else f.transport.mockResolvedValueOnce(failure==='gateway'?new Response('gateway',{status:502}):Response.json({untrusted:'private-token'}));
        expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport).toHaveBeenCalledTimes(2);
    });
    it('records definite provider rejection without exposing response content',async()=>{
        const f=fixture([{kind:'change_subdomain',subdomain:'other-name'}]);f.transport.mockResolvedValueOnce(Response.json({success:false,errors:[{message:'private-token rejected'}]},{status:403})).mockResolvedValueOnce(Response.json({success:false,errors:[{code:10007}]},{status:404}));expect((await f.make().tick())?.state).toBe('failed');const saved=await f.sealed.get({id:'result_job1_0',kind:'task_snapshot',account:aid,generation:'g1'});expect(saved).toEqual({outcome:'failed',result:{kind:'change_subdomain',code:'PROVIDER_REJECTED'}});expect(f.transport.mock.calls.filter(c=>c[1]?.method==='DELETE')).toHaveLength(0);
    });
    it('checks current authorization before every actual mutation',async()=>{
        const f=fixture([{kind:'change_subdomain',subdomain:'other-name'}]);f.authorize.mockResolvedValueOnce().mockRejectedValueOnce(new Error('revoked'));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).not.toHaveBeenCalled();
    });
    it('deletes only the bound worker and requires provider-specific absence evidence',async()=>{
        for(const code of [10007,99999]) {const f=fixture([{kind:'delete_worker',template:'cmliu',worker:'demo'}]);f.transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(Response.json({success:false,errors:[{code}]},{status:404}));expect((await f.make().tick())?.state).toBe(code===10007?'succeeded':'needs_review');expect(f.transport.mock.calls[0][1].method).toBe('DELETE');}
    });
    it.each([200,204])('requires verified absence even after empty Worker DELETE %i',async status=>{
        for(const code of [10007,99999]) {
            const f=fixture([{kind:'delete_worker',template:'cmliu',worker:'demo'}]);f.transport.mockResolvedValueOnce(new Response(null,{status})).mockResolvedValueOnce(Response.json({success:false,errors:[{code}]},{status:404}));
            expect((await f.make().tick())?.state).toBe(code===10007?'succeeded':'needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport).toHaveBeenCalledTimes(2);
        }
    });
    it('an empty accepted/pending delete response cannot be treated as completed',async()=>{
        const f=fixture([{kind:'delete_worker',template:'cmliu',worker:'demo'}]);f.transport.mockResolvedValueOnce(new Response(null,{status:202}));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(1);
    });
    it('verifies namespace deletion against ALL pages and refuses missing pagination',async()=>{
        for(const mode of ['absent','present','missing']) {const f=fixture([{kind:'delete_kv',namespace:ns}]);f.transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(Response.json({success:true,result:[{id:zone,title:'other'}],...(mode==='missing'?{}:{result_info:{page:1,total_pages:2,total_count:2,per_page:1,count:1}})})).mockResolvedValueOnce(Response.json({success:true,result:[{id:mode==='present'?ns:'e'.repeat(32),title:'last'}],result_info:{page:2,total_pages:2,total_count:2,per_page:1,count:1}}));expect((await f.make().tick())?.state).toBe(mode==='absent'?'succeeded':'needs_review');expect(f.transport).toHaveBeenCalledTimes(mode==='missing'?2:3);}
    });
    it('changes subdomain with explicit frozen value and readback',async()=>{
        const f=fixture([{kind:'change_subdomain',subdomain:'fixed-name'}]);f.transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:'fixed-name'}));expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls[0][1]).toMatchObject({method:'PUT',body:'{"subdomain":"fixed-name"}'});
    });
    it('escalates a refused plain subdomain change to delete/recreate and verifies the new name',async()=>{
        const f=fixture([{kind:'change_subdomain',subdomain:'next-name'}]);
        f.transport.mockResolvedValueOnce(Response.json({success:false,errors:[{code:10000,message:'account already has a subdomain'}]},{status:400}))
            .mockResolvedValueOnce(ok({subdomain:'old-name'})).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:null}))
            .mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:'next-name'}));
        expect((await f.make().tick())?.state).toBe('succeeded');
        expect(f.transport.mock.calls.map(c=>c[1].method || 'GET')).toEqual(['PUT','GET','DELETE','GET','PUT','GET']);
    });
    it('restores the previous subdomain name instead of stranding an account whose replacement does not hold',async()=>{
        const f=fixture([{kind:'change_subdomain',subdomain:'next-name'}]);
        f.transport.mockResolvedValueOnce(Response.json({success:false,errors:[{code:10000}]},{status:400}))
            .mockResolvedValueOnce(ok({subdomain:'old-name'})).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:null}))
            .mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:null}))
            .mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:'old-name'}));
        expect((await f.make().tick())?.state).toBe('failed');
        expect(await f.sealed.get({id:'result_job1_0',kind:'task_snapshot',account:aid,generation:'g1'})).toEqual({outcome:'failed',result:{kind:'change_subdomain',code:'ROTATION_NOT_APPLIED'}});
        expect(f.transport.mock.calls.map(c=>c[1].method || 'GET')).toEqual(['PUT','GET','DELETE','GET','PUT','GET','PUT','GET']);
    });
    it('keeps domain binding and workers.dev toggle as separate durable steps',async()=>{
        const f=fixture([{kind:'configure_domain',template:'cmliu',worker:'demo',hostname:'demo.example.test',zone,enabled:false},{kind:'configure_domain',template:'cmliu',worker:'demo',hostname:'',zone:'',enabled:false}]);f.transport.mockResolvedValueOnce(ok({hostname:'demo.example.test',zone_id:zone,service:'demo'})).mockResolvedValueOnce(Response.json({success:false},{status:403}));expect((await f.make().tick())?.state).toBe('running');expect((await f.make().tick())?.state).toBe('partial_failed');expect(f.transport).toHaveBeenCalledTimes(2);
    });
    it('uses template-bound namespace/key and exact frozen node bytes',async()=>{
        const f=fixture([{kind:'write_nodes',template:'cmliu',worker:'demo',content:'1.2.3.4:443'}]);f.transport.mockResolvedValueOnce(ok([{type:'kv_namespace',name:'KV',namespace_id:ns}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('1.2.3.4:443'));expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls[1][0]).toBe('https://api.cloudflare.com/client/v4/accounts/'+aid+'/storage/kv/namespaces/'+ns+'/values/ADD.txt');
    });
    it('protects configuration namespace even if a remote Worker binding is repointed there',async()=>{
        const f=fixture([{kind:'write_nodes',template:'cmliu',worker:'demo',content:'nodes'}]);f.resources.namespaces.push({account:aid,namespace:ns});f.transport.mockResolvedValueOnce(ok([{type:'kv_namespace',name:'KV',namespace_id:ns}]));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(1);
    });
    it('rejects corrupt artifact digest before any network',async()=>{
        const command=await upload();command.artifact.code='changed';const f=fixture([command]);expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).not.toHaveBeenCalled();
    });
    it('does not inject line-breaking ECH variables or silently ignore missing transform markers',async()=>{
        for(const marker of [false,true]) {const command=await upload('ech',marker?"const CF_FALLBACK_IPS = ['old']; const token = '';":'export default {};');command.variables=[{key:'PROXYIP',value:'unsafe'+String.fromCharCode(10)+'code',secret:false}];const f=fixture([command]);f.transport.mockResolvedValueOnce(ok([]));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(1);}
    });
    it('rejects cross-account, arbitrary URL/method, mismatched step and missing protection policy',async()=>{
        const f=fixture([{kind:'change_subdomain',subdomain:'fixed-name'}]);expect(()=>parseBusinessOperation({...f.operation,account:'b'.repeat(32)},aid)).toThrow('INVALID');expect(()=>parseBusinessOperation({...f.operation,commands:[{kind:'fetch',url:'https://evil.test'}]},aid)).toThrow('INVALID');
        f.options.execute=(op,step)=>executeBusinessOperation(aid,op,{...step,kind:'delete_worker'},f.resources);expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).not.toHaveBeenCalled();
    });
});

describe('batch create with journaled KV acquisition',()=>{
    const absent=()=>Response.json({success:false,errors:[{code:10007}]},{status:404});
    const page=(rows:any[],n=1,total=1,count=rows.length)=>Response.json({success:true,result:rows,result_info:{page:n,total_pages:total,total_count:count}});
    const create=async(namespaceTitle='batch-kv')=>({...await upload(),kind:'create_worker',namespaceTitle});
    const readback=()=>ok([{type:'kv_namespace',name:'KV',namespace_id:ns},{type:'secret_text',name:'UUID'}]);
    it('creates, confirms and binds a namespace, then verifies both Worker source and bindings',async()=>{
        const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([])).mockResolvedValueOnce(ok({id:ns,title:'batch-kv'})).mockResolvedValueOnce(page([{id:ns,title:'batch-kv'}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(readback());
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.authorize).toHaveBeenCalledTimes(3);
        expect(f.transport.mock.calls.filter(c=>c[1]?.method && c[1].method!=='GET').map(c=>c[1].method)).toEqual(['POST','PUT']);
        expect(JSON.parse(f.transport.mock.calls[4][1].body.get('metadata')).bindings).toEqual([{type:'kv_namespace',name:'KV',namespace_id:ns},{type:'secret_text',name:'UUID',text:'private-uuid'}]);
        expect(await f.sealed.get({id:'result_job1_0',kind:'task_snapshot',account:aid,generation:'g1'})).toMatchObject({outcome:'verified',result:{kind:'create_worker',namespace:ns,bindingsVerified:true}});
    });
    it('finds an existing namespace on a later page instead of duplicating it',async()=>{
        const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([{id:zone,title:'other'}],1,2,2)).mockResolvedValueOnce(page([{id:ns,title:'batch-kv'}],2,2,2)).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(readback());
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls.map(c=>c[1]?.method)).not.toContain('POST');
    });
    it('supports creation without KV and omits blank variables',async()=>{
        const command=await create('');command.variables.push({key:'EMPTY',value:' ',secret:false});const f=fixture([command]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(ok([{type:'secret_text',name:'UUID'}]));
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport).toHaveBeenCalledTimes(4);expect(JSON.parse(f.transport.mock.calls[1][1].body.get('metadata')).bindings).toHaveLength(1);
    });
    it.each(['existing','wrong404','unreadable'])('does not overwrite an unconfirmed absent worker: %s',async mode=>{
        const f=fixture([await create()]);f.transport.mockResolvedValueOnce(mode==='existing'?new Response('old code'):mode==='wrong404'?Response.json({success:false,errors:[{code:999}]},{status:404}):new Response('gateway',{status:502}));
        expect((await f.make().tick())?.state).toBe(mode==='existing'?'failed':'needs_review');expect(f.transport).toHaveBeenCalledTimes(1);
    });
    it.each(['duplicate','no-pagination','changing-pages','duplicate-id','excess-pages'])('rejects unsafe KV enumeration before any write: %s',async mode=>{
        const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent());
        if(mode==='duplicate') f.transport.mockResolvedValueOnce(page([{id:ns,title:'batch-kv'},{id:zone,title:'batch-kv'}]));
        if(mode==='no-pagination') f.transport.mockResolvedValueOnce(ok([]));
        if(mode==='changing-pages') f.transport.mockResolvedValueOnce(page([{id:zone,title:'other'}],1,2,2)).mockResolvedValueOnce(page([],2,3,3));
        if(mode==='duplicate-id') f.transport.mockResolvedValueOnce(page([{id:ns,title:'first'}],1,2,2)).mockResolvedValueOnce(page([{id:ns,title:'batch-kv'}],2,2,2));
        if(mode==='excess-pages') f.transport.mockResolvedValueOnce(page([],1,101));
        expect((await f.make().tick())?.state).toBe(mode==='duplicate'?'failed':'needs_review');expect(f.transport.mock.calls.some(c=>c[1]?.method && c[1].method!=='GET')).toBe(false);
    });
    it('does not bind protected CONFIG_KV even when it matches the requested title',async()=>{
        const f=fixture([await create()]);f.resources.namespaces.push({account:aid,namespace:ns});f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([{id:ns,title:'batch-kv'}]));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(2);
    });
    it('freezes at a lost namespace creation response, without retry, cleanup or Worker upload',async()=>{
        const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([])).mockRejectedValueOnce(new Error('lost POST response'));expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport).toHaveBeenCalledTimes(3);expect(f.transport.mock.calls.map(c=>c[1]?.method)).not.toContain('DELETE');
    });
    it('requires namespace identity/title confirmation and preserves it on later failure',async()=>{
        const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([])).mockResolvedValueOnce(ok({id:ns,title:'batch-kv'})).mockResolvedValueOnce(page([{id:zone,title:'batch-kv'}]));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(4);expect(f.transport.mock.calls.map(c=>c[1]?.method)).not.toContain('DELETE');
    });
    it('rechecks authorization after creating KV and never uploads on revocation',async()=>{
        const f=fixture([await create()]);f.authorize.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error('revoked'));f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([])).mockResolvedValueOnce(ok({id:ns,title:'batch-kv'})).mockResolvedValueOnce(page([{id:ns,title:'batch-kv'}]));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(4);
    });
    it('does not repeat POST or PUT after crash before outer result persistence',async()=>{
        const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([])).mockResolvedValueOnce(ok({id:ns,title:'batch-kv'})).mockResolvedValueOnce(page([{id:ns,title:'batch-kv'}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(readback());await f.make().tick();
        // Test-only crash point: all inner receipts exist but the outer step was not committed.
        f.sql.exec("DELETE FROM sealed_chunks WHERE id='result_job1_0'; DELETE FROM sealed_objects WHERE id='result_job1_0'; UPDATE account_jobs SET state='running' WHERE id='job1'; UPDATE account_steps SET state='in_flight',evidence=NULL WHERE job='job1'");
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport).toHaveBeenCalledTimes(7);
    });
    it('keeps a source-success/binding-mismatch upload unknown instead of claiming full verification',async()=>{
        const f=fixture([await create('')]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(ok([]));expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);
    });
});


describe('batch replacement of an existing managed Worker',()=>{
    const replace=async(title='')=>({...await upload(),kind:'replace_worker',namespaceTitle:title});
    const existing=()=>new Response('export default {old:true};');
    const oldBindings=()=>ok([{type:'kv_namespace',name:'KV',namespace_id:ns},{type:'secret_text',name:'OLD_SECRET'},{type:'plain_text',name:'OLD',text:'old'}]);
    const page=(rows:any[])=>Response.json({success:true,result:rows,result_info:{page:1,total_pages:1,total_count:rows.length}});
    it('replaces only after confirming existence and supported old bindings, with exact readback',async()=>{
        const f=fixture([await replace()]);f.transport.mockResolvedValueOnce(existing()).mockResolvedValueOnce(oldBindings()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(ok([{type:'secret_text',name:'UUID'}]));
        expect((await f.make().tick())?.state).toBe('succeeded');
        const writes=f.transport.mock.calls.filter(c=>c[1]?.method && c[1].method!=='GET');expect(writes).toHaveLength(1);expect(writes[0][1].method).toBe('PUT');
        expect(JSON.parse(writes[0][1].body.get('metadata')).bindings).toEqual([{name:'UUID',type:'secret_text',text:'private-uuid'}]);
        expect(await f.sealed.get({id:'result_job1_0',kind:'task_snapshot',account:aid,generation:'g1'})).toMatchObject({outcome:'verified',result:{kind:'replace_worker',commit,namespace:'',bindingsVerified:true}});
        expect(JSON.stringify(f.sql.prepare('SELECT * FROM execution_calls').all())).not.toMatch(/private-token|private-uuid/);
    });
    it('reuses the requested namespace but never deletes an old namespace',async()=>{
        const other='e'.repeat(32),f=fixture([await replace('replacement-kv')]);
        f.transport.mockResolvedValueOnce(existing()).mockResolvedValueOnce(oldBindings()).mockResolvedValueOnce(page([{id:other,title:'replacement-kv'}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(ok([{type:'kv_namespace',name:'KV',namespace_id:other},{type:'secret_text',name:'UUID'}]));
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls.map(c=>c[1]?.method)).not.toContain('DELETE');expect(f.transport.mock.calls.map(c=>c[1]?.method)).not.toContain('POST');
    });
    it.each(['missing','wrong404','gateway'])('never falls back to creating a replacement target on %s',async mode=>{
        const f=fixture([await replace('new-kv')]);f.transport.mockResolvedValueOnce(mode==='gateway'?new Response('gateway',{status:502}):Response.json({success:false,errors:[{code:mode==='missing'?10007:99}]},{status:404}));
        expect((await f.make().tick())?.state).toBe(mode==='missing'?'failed':'needs_review');expect(f.transport).toHaveBeenCalledTimes(1);expect(await f.make().tick()).toBe(null);
    });
    it.each([
        [{type:'durable_object_namespace',name:'DO',class_name:'DoNotDrop'}],
        [{type:'r2_bucket',name:'R2',bucket_name:'keep'}],
        [{type:'kv_namespace',name:'KV',namespace_id:ns,future:'field'}],
        [{type:'plain_text',name:'X',text:'1'},{type:'secret_text',name:'X'}],
        [{type:'plain_text',name:'X'}]
    ])('refuses unsupported/ambiguous binding replacement before any write (%#)',async bindings=>{
        const f=fixture([await replace('new-kv')]);f.transport.mockResolvedValueOnce(existing()).mockResolvedValueOnce(ok(bindings));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).toHaveBeenCalledTimes(2);
    });
    it('does not re-upload a lost response even after runner reconstruction',async()=>{
        const f=fixture([await replace()]);f.transport.mockResolvedValueOnce(existing()).mockResolvedValueOnce(oldBindings()).mockRejectedValueOnce(new Error('lost PUT response'));expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport).toHaveBeenCalledTimes(3);
    });
    it('rechecks authority between namespace creation and replacement, retaining the new namespace',async()=>{
        const f=fixture([await replace('new-kv')]);f.authorize.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error('revoked'));
        f.transport.mockResolvedValueOnce(existing()).mockResolvedValueOnce(oldBindings()).mockResolvedValueOnce(page([])).mockResolvedValueOnce(ok({id:ns,title:'new-kv'})).mockResolvedValueOnce(page([{id:ns,title:'new-kv'}]));
        expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport.mock.calls.filter(c=>c[1]?.method && c[1].method!=='GET').map(c=>c[1].method)).toEqual(['POST']);
    });
    it('requires bindings as well as source readback after replacing',async()=>{
        const f=fixture([await replace()]);f.transport.mockResolvedValueOnce(existing()).mockResolvedValueOnce(oldBindings()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(ok([{type:'plain_text',name:'UUID',text:'wrong'}]));expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);
    });
    it('does not allow unresolved deploy intents into the executor',async()=>{
        const f=fixture([await replace()]);expect(()=>parseBusinessOperation({...f.operation,commands:[{kind:'deploy_worker',template:'cmliu',worker:'demo',ref:'latest',variables:[],namespaceTitle:'',echTokenEnabled:false}]},aid)).toThrow('INVALID');
    });
});


it('rejects unplanned fuse intent instead of reporting a no-op success',async()=>{
    const f=fixture([{kind:'change_subdomain',subdomain:'fixed-name'}]);
    expect(()=>parseBusinessOperation({...f.operation,commands:[{kind:'fuse',template:'cmliu',echTokenEnabled:false}]},aid)).toThrow('INVALID');
    expect(f.transport).not.toHaveBeenCalled();
});


describe('manual source and explicit variable deletion execution',()=>{
    const code='export default {fetch(){return new Response("user-source")}};';
    const manual=async()=>({kind:'manual_upload',template:'cmliu',worker:'demo',artifact:{kind:'custom',template:'cmliu',code,digest:await sha256(code)},variables:[{key:'UUID',value:'private-manual-uuid',secret:true}],deletedVariables:['REMOVE'],echTokenEnabled:false});
    const before=[{type:'kv_namespace',name:'KV',namespace_id:ns},{type:'plain_text',name:'UNCHANGED',text:'keep'},{type:'secret_text',name:'REMOVE'},{type:'secret_text',name:'UUID'}];
    const after=[{type:'kv_namespace',name:'KV',namespace_id:ns},{type:'plain_text',name:'UNCHANGED',text:'keep'},{type:'secret_text',name:'UUID'}];
    const responses=(f:ReturnType<typeof fixture>,readback=after)=>f.transport.mockResolvedValueOnce(new Response('old source')).mockResolvedValueOnce(ok(before)).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response(code)).mockResolvedValueOnce(ok(readback));
    it('merges plain/KV bindings, deletes explicit hidden secret and independently verifies source and bindings',async()=>{
        const f=fixture([await manual()]);responses(f);expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport).toHaveBeenCalledTimes(5);expect(f.authorize).toHaveBeenCalledTimes(2);
        const form=f.transport.mock.calls[2][1].body;expect(await form.get('script').text()).toBe(code);
        expect(JSON.parse(form.get('metadata')).bindings).toEqual([{type:'kv_namespace',name:'KV',namespace_id:ns},{type:'plain_text',name:'UNCHANGED',text:'keep'},{type:'secret_text',name:'UUID',text:'private-manual-uuid'}]);
        const result=await f.sealed.get({id:'result_job1_0',kind:'task_snapshot',account:aid,generation:'g1'});
        expect(result).toEqual({outcome:'verified',result:{kind:'manual_upload',worker:'demo',source:{kind:'custom',digest:await sha256(code)},scriptVerified:true,bindingsVerified:true}});
        expect(JSON.stringify(result)).not.toMatch(/private|commit|user-source/);
    });
    it.each(['missing-worker','unavailable-secret','resource-delete','unsupported-resource','readback-kept-deleted','readback-changed','digest'])('fails closed: %s',async mode=>{
        const command=await manual(),f=fixture([command]);
        if(mode==='missing-worker')f.transport.mockResolvedValueOnce(Response.json({success:false,errors:[{code:10007}]},{status:404}));
        else if(mode==='digest'){command.artifact.digest='0'.repeat(64);}
        else if(mode==='unavailable-secret')f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok([...before,{type:'secret_text',name:'NO_VALUE'}]));
        else if(mode==='resource-delete')f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok([{type:'kv_namespace',name:'REMOVE',namespace_id:ns}]));
        else if(mode==='unsupported-resource')f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok([{type:'r2_bucket',name:'REMOVE',bucket_name:'bucket'}]));
        else responses(f,mode==='readback-kept-deleted'?[...after,{type:'secret_text',name:'REMOVE'}]:after.map(b=>b.name==='UNCHANGED'?{...b,text:'wrong'}:b));
        expect((await f.make().tick())?.state).toBe(mode==='missing-worker'?'failed':'needs_review');
        if(!mode.startsWith('readback'))expect(f.transport.mock.calls.every(c=>!c[1]?.method || c[1].method==='GET')).toBe(true);
    });
    it('accepts upstream manual artifact with honest immutable commit/digest identity',async()=>{
        const command:any=await manual();command.artifact=(await upload('cmliu',code)).artifact;const f=fixture([command]);responses(f);expect((await f.make().tick())?.state).toBe('succeeded');
        expect(await f.sealed.get({id:'result_job1_0',kind:'task_snapshot',account:aid,generation:'g1'})).toMatchObject({result:{source:{kind:'upstream',commit,digest:await sha256(code)}}});
    });
    it('replays sealed call evidence after losing only the result, never another PUT',async()=>{
        const f=fixture([await manual()]);responses(f);await f.make().tick();
        f.sql.exec("DELETE FROM sealed_chunks WHERE id='result_job1_0'; DELETE FROM sealed_objects WHERE id='result_job1_0'; UPDATE account_jobs SET state='running'; UPDATE account_steps SET state='in_flight',evidence=NULL");
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport).toHaveBeenCalledTimes(5);
    });
    it('does not retry a lost manual upload response or run its successor',async()=>{
        const f=fixture([await manual(),{kind:'change_subdomain',subdomain:'later-domain'}]);f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok(before)).mockRejectedValueOnce(new Error('private lost response'));
        expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport).toHaveBeenCalledTimes(3);
    });
    it('will not execute a planner-only manual intent or custom artifact masquerading as official upload',async()=>{
        const a=await manual();for(const command of [{kind:'manual_deploy'}, {...a,kind:'upload'}])expect(()=>parseBusinessOperation({schema:1,account:aid,credential:{email:'',globalKey:'',apiToken:'x',authMode:'token'},commands:[command]},aid)).toThrow('INVALID');
    });
});


describe('journaled 1101 repair and account subdomain rotation',()=>{
    const domain={hostname:'demo.example.test',service:'demo',zone_id:zone,environment:'production'};
    const flags={enabled:false,previews_enabled:true};
    async function repairFixture(extra:any[]=[]){
        const command={...await upload(),kind:'repair_worker',echTokenEnabled:true};
        const f=fixture([command,...extra]);
        const state={code:'old source with private-backup',bindings:[{name:'KV',type:'kv_namespace',namespace_id:ns},{name:'UUID',type:'secret_text'},{name:'KEEP',type:'plain_text',text:'kept'}] as any[],domains:[domain] as any[],flags:{...flags},subdomain:'old-subdomain',writes:[] as string[]};
        const handler=async(url:string,init:any={})=>{
            const method=init.method || 'GET',p=new URL(url).pathname;
            if(method!=='GET')state.writes.push(method+' '+p);
            if(p.endsWith('/scripts/demo')){
                if(method==='DELETE'){state.code='';state.domains=state.domains.filter(d=>d.service!=='demo');return ok();}
                if(method==='PUT'){state.code=await init.body.get('script').text();state.bindings=JSON.parse(init.body.get('metadata')).bindings;return ok();}
                return state.code?new Response(state.code):Response.json({success:false,errors:[{code:10007}]},{status:404});
            }
            if(p.endsWith('/scripts/demo/bindings'))return ok(state.bindings.map(b=>b.type==='secret_text'?{type:b.type,name:b.name}:b));
            if(p.endsWith('/workers/domains')){
                if(method==='PUT'){state.domains.push(JSON.parse(init.body));return ok(state.domains.at(-1));}
                return Response.json({success:true,result:state.domains,result_info:{page:1,total_pages:1,total_count:state.domains.length}});
            }
            if(p.endsWith('/scripts/demo/subdomain')){if(method==='POST')state.flags=JSON.parse(init.body);return ok(state.flags);}
            if(p.endsWith('/workers/subdomain')){if(method==='DELETE')state.subdomain='';if(method==='PUT')state.subdomain=JSON.parse(init.body).subdomain;return ok({subdomain:state.subdomain});}
            throw Error('unexpected fake endpoint');
        };
        f.transport.mockImplementation(handler);return {...f,state,handler};
    }
    it('backs up before delete, recreates without KV mutation and verifies all bindings/domains/flags',async()=>{
        const f=await repairFixture([{kind:'rotate_subdomain',subdomain:'new-subdomain'}]);
        expect((await f.make().tick())?.state).toBe('running');
        expect((await f.make().tick())?.state).toBe('succeeded');
        expect(f.state.writes.map(w=>w.split(' ')[0])).toEqual(['DELETE','PUT','PUT','POST','DELETE','PUT']);
        expect(f.state.bindings).toEqual([{name:'KV',type:'kv_namespace',namespace_id:ns},{name:'UUID',type:'secret_text',text:'private-uuid'},{name:'KEEP',type:'plain_text',text:'kept'}]);
        expect(f.state.flags).toEqual(flags);expect(f.state.domains).toEqual([domain]);expect(f.state.subdomain).toBe('new-subdomain');
        expect(f.transport.mock.calls.slice(0,4).every(c=>!(c[1] as any)?.method)).toBe(true);
        expect(JSON.stringify(f.queue.inspect('job1'))).not.toMatch(/private-backup|private-uuid|private-token/);
        expect(f.authorize).toHaveBeenCalledTimes(8); // Two step starts + every one of six writes.
        const backup:any=await f.sealed.get({id:'response_job1_0_0',kind:'task_snapshot',account:aid,generation:'g1'});
        expect(atob(backup.body)).toBe('old source with private-backup');
        expect(JSON.stringify(f.db.rows('SELECT * FROM sealed_chunks'))).not.toContain('private-backup');
    });

    it('retains and validates provider text-part backup before repair, and verifies text-part upload readback',async()=>{const f=await repairFixture();f.transport.mockImplementation(async(url,init:any={})=>{const r=await f.handler(url,init);if((init.method??'GET')==='GET'&&url.endsWith('/scripts/demo')&&r.ok){const name=f.state.writes.some(w=>w.startsWith('PUT ')&&w.endsWith('/scripts/demo'))?'index.js':'worker.js';return textMultipart([[name,await r.text()]]);}return r;});expect((await f.make().tick())?.state).toBe('succeeded');expect(f.state.writes.map(w=>w.split(' ')[0])).toEqual(['DELETE','PUT','PUT','POST']);const saved:any=await f.sealed.get({id:'response_job1_0_0',kind:'task_snapshot',account:aid,generation:'g1'});expect(atob(saved.body)).toContain('name="worker.js"');expect(atob(saved.body)).toContain('old source with private-backup');const calls=f.transport.mock.calls.length;expect(await f.make().tick()).toBeNull();expect(f.transport).toHaveBeenCalledTimes(calls);});
    it.each(['metadata-only','html'])('rejects non-code provider text backup before repair: %s',async mode=>{const f=await repairFixture();f.transport.mockResolvedValueOnce(textMultipart([[mode==='metadata-only'?'metadata':'worker.js',mode==='html'?'<html>gateway error</html>':'{"success":true}']]));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.state.writes).toEqual([]);});
    it.each(['secret','resource','duplicate','binding-read','domain-read','domain-page','preview','source','digest','protected-kv'])('refuses unsafe %s before any deletion',async mode=>{
        const f=await repairFixture();
        if(mode==='secret')f.operation.commands[0].variables=[];
        if(mode==='resource')f.state.bindings.push({name:'BUCKET',type:'r2_bucket',bucket_name:'keep'});
        if(mode==='duplicate')f.state.bindings.push({...f.state.bindings[0]});
        if(mode==='preview')delete (f.state.flags as any).previews_enabled;
        if(mode==='source')f.state.code='<html>error</html>';
        if(mode==='digest')f.operation.commands[0].artifact.digest='0'.repeat(64);
        if(mode==='protected-kv')f.resources.namespaces.push({account:aid,namespace:ns});
        if(mode==='binding-read'||mode==='domain-read'||mode==='domain-page')f.transport.mockImplementation(async(url,init)=>{
            if((mode==='binding-read'&&url.endsWith('/bindings'))||(mode.startsWith('domain')&&url.includes('/workers/domains')))return mode==='domain-page'?Response.json({success:true,result:[domain],result_info:{page:1,total_pages:2,total_count:2}}):ok(null);
            return f.handler(url,init);
        });
        expect((await f.make().tick())?.state).toBe('needs_review');expect(f.state.writes).toEqual([]);
    });
    it.each(['DELETE','PUT','DOMAIN','FLAGS','VERIFY'])('stops after uncertain %s and never repeats destructive requests or rotates the account',async mode=>{
        const f=await repairFixture([{kind:'rotate_subdomain',subdomain:'new-subdomain'}]);let injected=false;
        f.transport.mockImplementation(async(url,init:any={})=>{
            const method=init.method||'GET';const response=await f.handler(url,init);
            if(!injected&&((mode===method&&url.endsWith('/scripts/demo'))||(mode==='DOMAIN'&&method==='PUT'&&url.endsWith('/domains'))||(mode==='FLAGS'&&method==='POST')||(mode==='VERIFY'&&method==='GET'&&url.endsWith('/scripts/demo')&&f.state.writes.length===2))){injected=true;if(mode==='VERIFY')return new Response('mismatch');throw Error('lost private response');}
            return response;
        });
        expect((await f.make().tick())?.state).toBe('needs_review');const writes=[...f.state.writes];
        expect(await f.make().tick()).toBeNull();expect(f.state.writes).toEqual(writes);expect(f.state.subdomain).toBe('old-subdomain');
    });
    it('retains unknown when definite upload rejection follows a confirmed deletion',async()=>{
        const f=await repairFixture();f.transport.mockImplementation(async(url,init:any={})=>init.method==='PUT'&&url.endsWith('/scripts/demo')?Response.json({success:false,errors:[{code:10021}]},{status:400}):f.handler(url,init));
        expect((await f.make().tick())?.state).toBe('needs_review');expect(f.state.code).toBe('');expect(f.state.writes).toHaveLength(1);
    });
    it('records a missing account subdomain as a definite write-free failure, not an unknown',async()=>{
        const f=await repairFixture([{kind:'rotate_subdomain',subdomain:'new-subdomain'}]);
        f.state.subdomain='';
        f.transport.mockImplementation(async(url:string,init:any={})=>url.endsWith('/workers/subdomain')&&(init.method??'GET')==='GET'?Response.json({success:false,errors:[{code:10007,message:'workers.dev subdomain not found'}]},{status:404}):f.handler(url,init));
        expect((await f.make().tick())?.state).toBe('running');
        expect((await f.make().tick())?.state).toBe('partial_failed');
        expect(f.queue.inspect('job1').steps.map(s=>s.state)).toEqual(['verified','failed']);
        expect(await f.sealed.get({id:'result_job1_1',kind:'task_snapshot',account:aid,generation:'g1'})).toEqual({outcome:'failed',result:{kind:'rotate_subdomain',code:'PROVIDER_STATE_ABSENT'}});
        expect(f.state.writes.filter(w=>w.includes('/workers/subdomain'))).toEqual([]);
    });
    it('settles a transport failure on the pre-mutation subdomain read as a write-free failure on the next pass',async()=>{
        const f=await repairFixture([{kind:'rotate_subdomain',subdomain:'new-subdomain'}]);
        let injected=false;
        f.transport.mockImplementation(async(url:string,init:any={})=>{if(!injected&&url.endsWith('/workers/subdomain')&&(init.method??'GET')==='GET'){injected=true;throw Error('lost private read response');}return f.handler(url,init);});
        expect((await f.make().tick())?.state).toBe('running');
        expect((await f.make().tick())?.state).toBe('needs_review');
        const writes=[...f.state.writes];
        expect(await f.make().tick()).toBeNull();
        expect(f.queue.inspect('job1').steps.map(s=>s.state)).toEqual(['verified','failed']);
        expect(f.state.writes).toEqual(writes);
        expect(await f.sealed.get({id:'result_job1_1',kind:'task_snapshot',account:aid,generation:'g1'})).toEqual({outcome:'failed',result:{kind:'rotate_subdomain',code:'NO_MUTATION_RECORDED'}});
    });
    it('replays saved preflight, delete/upload and restoration responses after result loss, without new writes',async()=>{
        const f=await repairFixture();expect((await f.make().tick())?.state).toBe('succeeded');const calls=f.transport.mock.calls.length;
        f.sql.exec("DELETE FROM sealed_chunks WHERE id='result_job1_0'; DELETE FROM sealed_objects WHERE id='result_job1_0'; UPDATE account_jobs SET state='running'; UPDATE account_steps SET state='in_flight',evidence=NULL");
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport).toHaveBeenCalledTimes(calls);expect(f.state.writes).toHaveLength(4);
    });
    it('enumerates all domain pages before deletion and verifies the complete restored set',async()=>{
        const f=await repairFixture(),other={...domain,hostname:'other.example.test',service:'other'};f.state.domains=[other,domain];
        f.transport.mockImplementation(async(url,init:any={})=>{
            if(url.includes('/workers/domains?')){const page=Number(new URL(url).searchParams.get('page'));return Response.json({success:true,result:f.state.domains.slice(page-1,page),result_info:{page,total_pages:2,total_count:2}});}
            return f.handler(url,init);
        });
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.state.domains).toEqual([other,domain]);
        const firstDelete=f.transport.mock.calls.findIndex(c=>(c[1] as any)?.method==='DELETE');
        expect(f.transport.mock.calls.slice(0,firstDelete).some(c=>c[0].endsWith('page=2'))).toBe(true);
    });
    it.each(['bindings','domains','flags'])('does not accept a mismatched post-rebuild %s readback',async which=>{
        const f=await repairFixture();f.transport.mockImplementation(async(url,init:any={})=>{
            if(f.state.writes.length>=2 && !init.method){
                if(which==='bindings'&&url.endsWith('/bindings'))return ok([]);
                if(which==='domains'&&url.includes('/workers/domains?'))return Response.json({success:true,result:[],result_info:{page:1,total_pages:1,total_count:0}});
                if(which==='flags'&&url.endsWith('/scripts/demo/subdomain'))return ok({enabled:true,previews_enabled:false});
            }
            return f.handler(url,init);
        });expect((await f.make().tick())?.state).toBe('needs_review');
    });
    it('never auto-rolls back or repeats an account rotation with a lost PUT response',async()=>{
        const f=await repairFixture([{kind:'rotate_subdomain',subdomain:'new-subdomain'}]);f.transport.mockImplementation(async(url,init:any={})=>{const response=await f.handler(url,init);if(init.method==='PUT'&&url.endsWith('/workers/subdomain'))throw Error('lost');return response;});
        expect((await f.make().tick())?.state).toBe('running');expect((await f.make().tick())?.state).toBe('needs_review');expect(f.state.subdomain).toBe('new-subdomain');const writes=[...f.state.writes];expect(await f.make().tick()).toBeNull();expect(f.state.writes).toEqual(writes);
    });
    it('accepts the observed Cloudflare domain schema without total_pages and verifies default flags',async()=>{
        const f=await repairFixture();f.state.domains=[{...domain,enabled:true,previews_enabled:false}];
        f.transport.mockImplementation(async(url,init:any={})=>{
            if(url.includes('/workers/domains?'))return Response.json({success:true,result:f.state.domains,result_info:{page:1,per_page:100,count:f.state.domains.length,total_count:f.state.domains.length}});
            const r=await f.handler(url,init);if(url.endsWith('/workers/domains')&&init.method==='PUT')Object.assign(f.state.domains.at(-1),{enabled:true,previews_enabled:false});return r;
        });
        expect((await f.make().tick())?.state).toBe('succeeded');
        const write=f.transport.mock.calls.find(([url,init])=>url.endsWith('/workers/domains')&&(init as any)?.method==='PUT')!;
        expect(JSON.parse((write[1] as any).body)).toEqual(domain); // No undocumented flags in PUT.
    });
    it.each(['missing-per-page','bad-count','short-page','disabled-domain','preview-domain','bad-flag'])('refuses unsafe real-schema variation %s before delete',async mode=>{
        const f=await repairFixture();
        if(mode==='disabled-domain')f.state.domains[0]={...domain,enabled:false};
        if(mode==='preview-domain')f.state.domains[0]={...domain,previews_enabled:true};
        if(mode==='bad-flag')f.state.domains[0]={...domain,enabled:'true'};
        if(!mode.endsWith('domain')&&mode!=='bad-flag')f.transport.mockImplementation(async(url,init:any={})=>url.includes('/workers/domains?')?Response.json({success:true,result:[domain],result_info:{page:1,...(mode==='missing-per-page'?{}:{per_page:100}),count:mode==='bad-count'?2:1,total_count:mode==='short-page'?101:1}}):f.handler(url,init));
        expect((await f.make().tick())?.state).toBe('needs_review');expect(f.state.writes).toEqual([]);
    });
    it('does not claim verified when Cloudflare loses default-domain flags on restoration',async()=>{
        const f=await repairFixture();f.state.domains=[{...domain,enabled:true,previews_enabled:false}];
        expect((await f.make().tick())?.state).toBe('needs_review');expect(f.state.writes.map(w=>w.split(' ')[0])).toEqual(['DELETE','PUT','PUT']);
    });

});


describe('legacy ECH batch source/binding separation through journal',()=>{
    it('transforms from config while preserving savedVars bindings and readback verification',async()=>{
        const command={...await upload('ech',"const CF_FALLBACK_IPS = ['old']; const token = ''; export default {};"),kind:'create_worker',namespaceTitle:'',variables:[{key:'PROXYIP',value:'binding.example',secret:false}],sourceVariables:[{key:'PROXYIP',value:'source.example',secret:false}]};
        const f=fixture([command]);let code='';let bindings:any[]=[];
        f.transport.mockImplementation(async(url,init:any={})=>{
            if(init.method==='PUT'){code=await init.body.get('script').text();bindings=JSON.parse(init.body.get('metadata')).bindings;return ok();}
            if(url.endsWith('/bindings'))return ok(bindings);
            return code?new Response(code):Response.json({success:false,errors:[{code:10007}]},{status:404});
        });
        expect((await f.make().tick())?.state).toBe('succeeded');expect(code).toContain('source.example');expect(code).not.toContain('binding.example');expect(bindings).toEqual([{name:'PROXYIP',type:'plain_text',text:'binding.example'}]);
    });
    it('validates separate source variables before any namespace or Worker mutation',async()=>{
        const command={...await upload('ech',"const CF_FALLBACK_IPS = ['old']; const token = ''; export default {};"),kind:'create_worker',namespaceTitle:'',variables:[],sourceVariables:[{key:'PROXYIP',value:'unsafe'+String.fromCharCode(10)+'code'}]};
        const f=fixture([command]);expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).not.toHaveBeenCalled();
    });
});


describe('journaled resource removal and account rename',()=>{
    const absent=()=>Response.json({success:false,errors:[{code:10007}]},{status:404});
    const bindings=(namespace=ns)=>ok([{type:'kv_namespace',name:'KV',namespace_id:namespace}]);
    const removal=(ids:string[]|null=null)=>[{kind:'remove_worker',worker:'demo',namespaces:ids,cleanup:Object.keys(TEMPLATES).flatMap(t=>['deploy:'+t,'vars:'+t,'favorites:'+t,'override:'+t+':'+aid]).sort().map(domain=>({domain,revision:0}))},...(ids ?? []).map(namespace=>({kind:'cleanup_kv',worker:'demo',namespace}))];
    const emptyNamespaces=()=>Response.json({success:true,result:[],result_info:{page:1,total_pages:0,total_count:0}});
    it('deletes a discovered Worker without reading bindings when KV cleanup is not requested',async()=>{
        const f=fixture(removal());f.transport.mockResolvedValueOnce(new Response('old source')).mockResolvedValueOnce(ok()).mockResolvedValueOnce(absent());
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls.map(c=>c[1].method || 'GET')).toEqual(['GET','DELETE','GET']);
    });
    it('refuses changed bindings before DELETE, and never runs frozen namespace cleanup',async()=>{
        const f=fixture(removal([ns]));f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(bindings('c'.repeat(32)));
        expect((await f.make().tick())?.state).toBe('failed');expect(f.transport.mock.calls.every(c=>!c[1].method || c[1].method==='GET')).toBe(true);expect(await f.make().tick()).toBe(null);
    });
    it('retains shared namespaces as an explicit durable disposition, without namespace DELETE',async()=>{
        const f=fixture(removal([ns]));f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(bindings()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(absent());
        expect((await f.make().tick())?.state).toBe('running');
        f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(ok([{id:'another-worker'}])).mockResolvedValueOnce(bindings());
        expect((await f.make().tick())?.state).toBe('succeeded');
        expect(f.transport.mock.calls.filter(c=>c[1].method==='DELETE')).toHaveLength(1);
        expect(await f.sealed.get({id:'result_job1_1',kind:'task_snapshot',account:aid,generation:'g1'})).toMatchObject({result:{disposition:'retained_shared',namespace:ns}});
    });
    it('deletes only a frozen unshared namespace and verifies complete absence',async()=>{
        const f=fixture(removal([ns]));f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(bindings()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(absent());await f.make().tick();
        f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(ok([{id:'other'}])).mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(emptyNamespaces());
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls.filter(c=>c[1].method==='DELETE')).toHaveLength(2);
        expect(await f.sealed.get({id:'result_job1_1',kind:'task_snapshot',account:aid,generation:'g1'})).toMatchObject({result:{disposition:'deleted'}});
    });
    it.each(['partial','duplicate','invalid','read-failure','recreated'])('never deletes KV on incomplete ownership evidence: %s',async mode=>{
        const f=fixture(removal([ns]));f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(bindings()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(absent());await f.make().tick();
        if(mode==='recreated') f.transport.mockResolvedValueOnce(new Response('new source'));
        else {f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(mode==='partial'?Response.json({success:true,result:[],result_info:{page:1,total_pages:2,total_count:4}}):ok(mode==='duplicate'?[{id:'x'},{id:'x'}]:[{id:mode==='invalid'?'../bad':'other'}]));f.transport.mockResolvedValueOnce(mode==='read-failure'?Response.json({success:false},{status:403}):ok([]));}
        expect((await f.make().tick())?.state).toBe(mode==='recreated'?'partial_failed':'needs_review');expect(f.transport.mock.calls.filter(c=>c[1].method==='DELETE')).toHaveLength(1);
    });
    it('does not replay a DELETE after losing its response, including after runner reconstruction',async()=>{
        const f=fixture(removal([ns]));f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(bindings()).mockRejectedValueOnce(new Error('lost delete ack'));
        expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport.mock.calls.filter(c=>c[1].method==='DELETE')).toHaveLength(1);
    });
    it('replays journal evidence after result loss without another Worker or namespace deletion',async()=>{
        const f=fixture(removal());f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok()).mockResolvedValueOnce(absent());await f.make().tick();
        f.sql.exec("DELETE FROM sealed_chunks WHERE id='result_job1_0'; DELETE FROM sealed_objects WHERE id='result_job1_0'; UPDATE account_jobs SET state='running'; UPDATE account_steps SET state='in_flight',evidence=NULL");
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport).toHaveBeenCalledTimes(3);
    });
    it.each(['extra','missing','reordered','unchecked'])('rejects forged cleanup commands %s before network',async mode=>{
        const commands:any[]=removal([ns]);
        if(mode==='extra')commands.push({kind:'cleanup_kv',worker:'demo',namespace:'d'.repeat(32)});
        if(mode==='missing')commands.pop();if(mode==='reordered')commands.reverse();if(mode==='unchecked')commands[0].cleanup=[];
        const f=fixture(commands);expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport).not.toHaveBeenCalled();
    });
    it('renames with exactly one DELETE and PUT, and reads the old name before either',async()=>{
        const f=fixture([{kind:'rename_subdomain',subdomain:'n'}]);f.transport.mockResolvedValueOnce(ok({subdomain:'o'})).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:'n'}));
        expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls.map(c=>c[1].method || 'GET')).toEqual(['GET','DELETE','PUT','GET']);
    });
    it('does no write when the requested name is already current',async()=>{
        const f=fixture([{kind:'rename_subdomain',subdomain:'already-set'}]);f.transport.mockResolvedValueOnce(ok({subdomain:'already-set'}));expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport).toHaveBeenCalledTimes(1);
    });
    it('creates an explicitly empty subdomain without DELETE',async()=>{
        const f=fixture([{kind:'rename_subdomain',subdomain:'new'}]);f.transport.mockResolvedValueOnce(ok({subdomain:''})).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:'new'}));expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls.map(c=>c[1].method || 'GET')).toEqual(['GET','PUT','GET']);
    });
    it.each(['lost-delete','lost-put','rejected-put','wrong-readback'])('keeps unknown and never auto-rolls back after %s',async mode=>{
        const f=fixture([{kind:'rename_subdomain',subdomain:'new'}]);f.transport.mockResolvedValueOnce(ok({subdomain:'old'}));
        if(mode==='lost-delete')f.transport.mockRejectedValueOnce(new Error('lost'));
        else {f.transport.mockResolvedValueOnce(ok());if(mode==='lost-put')f.transport.mockRejectedValueOnce(new Error('lost'));else if(mode==='rejected-put')f.transport.mockResolvedValueOnce(Response.json({success:false},{status:400}));else f.transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({subdomain:'elsewhere'}));}
        expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport.mock.calls.filter(c=>c[1].method==='PUT').length).toBeLessThanOrEqual(1);
    });
});

describe('trusted fixed-custom blank text preservation',()=>{
 const command=async()=>({kind:'manual_upload',template:'cmliu',worker:'demo',artifact:{kind:'custom',template:'cmliu',code:'export default {};',digest:await sha256('export default {};')},variables:[{key:'EMPTY',value:'',secret:false}],deletedVariables:[],echTokenEnabled:false,preserveBlankPlainText:true});
 it('round-trips a blank plain text binding only under the server-generated preservation contract',async()=>{const f=fixture([await command()]);f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok([{name:'EMPTY',type:'plain_text',text:'previous'}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};')).mockResolvedValueOnce(ok([{name:'EMPTY',type:'plain_text',text:''}]));expect((await f.make().tick())?.state).toBe('succeeded');const put=f.transport.mock.calls.find(c=>c[1]?.method==='PUT')!;expect(JSON.parse(put[1].body.get('metadata')).bindings).toEqual([{name:'EMPTY',type:'plain_text',text:''}]);});
 it('does not use blank plain text as recovery of a hidden Secret',async()=>{const f=fixture([await command()]);f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok([{name:'EMPTY',type:'secret_text'}]));expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport.mock.calls.some(c=>c[1]?.method==='PUT')).toBe(false);});
 it.each(['absent','false','delete','secret'])('rejects blank executable values for %s',async(mode)=>{const c:any=await command();if(mode==='absent')delete c.preserveBlankPlainText;if(mode==='false')c.preserveBlankPlainText=false;if(mode==='delete')c.deletedVariables=['OTHER'];if(mode==='secret')c.variables[0].secret=true;const f=fixture([c]);expect(()=>parseBusinessOperation(f.operation,aid)).toThrow();});
});

describe('legacy-compatible blank merge and cross-resource KV inventory',()=>{
 const removed=async()=>{const commands=[{kind:'remove_worker',worker:'demo',namespaces:[ns],cleanup:Object.keys(TEMPLATES).flatMap(t=>['deploy:'+t,'vars:'+t,'favorites:'+t,'override:'+t+':'+aid]).sort().map(domain=>({domain,revision:0}))},{kind:'cleanup_kv',worker:'demo',namespace:ns}];const f=fixture(commands);f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok([{name:'KV',type:'kv_namespace',namespace_id:ns}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(Response.json({success:false,errors:[{code:10007}]},{status:404}));expect((await f.make().tick())?.state).toBe('running');return f;};
 it('ordinary upload skips blank variables, preserving prior plain text and upstream defaults',async()=>{const command=await upload();command.variables.push({key:'KEEP',value:' ',secret:false},{key:'NEW_EMPTY',value:'',secret:false});const f=fixture([command]);f.transport.mockResolvedValueOnce(ok([{name:'KEEP',type:'plain_text',text:'retained'}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};'));expect((await f.make().tick())?.state).toBe('succeeded');const b=JSON.parse(f.transport.mock.calls[1][1].body.get('metadata')).bindings;expect(b.find(x=>x.name==='KEEP')).toEqual({name:'KEEP',type:'plain_text',text:'retained'});expect(b.some(x=>x.name==='NEW_EMPTY')).toBe(false);});
 it('can clean unshared KV when unrelated manager/other workers have DO bindings',async()=>{const f=await removed();f.transport.mockResolvedValueOnce(Response.json({success:false,errors:[{code:10007}]},{status:404})).mockResolvedValueOnce(ok([{id:'manager'}])).mockResolvedValueOnce(ok([{name:'CONFIG_KV',type:'kv_namespace',namespace_id:'c'.repeat(32)},{name:'RELIABILITY_COORDINATOR',type:'durable_object_namespace',namespace_id:'d'.repeat(32),class_name:'ProductionCoordinator'}])).mockResolvedValueOnce(ok(null)).mockResolvedValueOnce(Response.json({success:true,result:[],result_info:{page:1,total_pages:0,total_count:0}}));expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls.filter(([,i])=>i.method==='DELETE').map(([u])=>u)).toEqual(['https://api.cloudflare.com/client/v4/accounts/'+aid+'/workers/scripts/demo','https://api.cloudflare.com/client/v4/accounts/'+aid+'/storage/kv/namespaces/'+ns]);});
 it('retains a shared KV reference even alongside DO namespace bindings',async()=>{const f=await removed();f.transport.mockResolvedValueOnce(Response.json({success:false,errors:[{code:10007}]},{status:404})).mockResolvedValueOnce(ok([{id:'other'}])).mockResolvedValueOnce(ok([{name:'KV',type:'kv_namespace',namespace_id:ns},{name:'DO',type:'durable_object_namespace',namespace_id:'d'.repeat(32),class_name:'Counter'}]));expect((await f.make().tick())?.state).toBe('succeeded');expect(f.transport.mock.calls.filter(([,i])=>i.method==='DELETE')).toHaveLength(1);expect(await f.sealed.get({id:'result_job1_1',kind:'task_snapshot',account:aid,generation:'g1'})).toMatchObject({result:{disposition:'retained_shared'}});});
});


describe('inventory completeness before creation and deletion proof',()=>{
 const absent=()=>Response.json({success:false,errors:[{code:10007}]},{status:404});
 const page=(rows:any[],info:any,errors:any[]=[])=>Response.json({success:true,errors,result:rows,result_info:info});
 const create=async()=>({...await upload(),kind:'create_worker',namespaceTitle:'batch-kv'});
 it.each([
  {page:1,total_pages:1,total_count:1,count:0,per_page:100},
  {page:1,total_pages:1},
  {page:1,total_pages:1,total_count:0,count:1,per_page:100},
  {page:1,total_pages:1,total_count:0,count:0,per_page:0},
  {page:1,total_pages:2,total_count:1,count:0,per_page:100}
 ])('never creates a namespace from an incomplete/contradictory empty page %j',async info=>{
  const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([],info)).mockResolvedValueOnce(ok({id:ns,title:'batch-kv'}));
  expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport.mock.calls.some(([,i])=>i.method==='POST'||i.method==='PUT')).toBe(false);
 });
 it('refuses contradictory success/errors before any namespace write',async()=>{
  const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([],{page:1,total_pages:1,total_count:0},[{code:10000}])).mockResolvedValueOnce(ok({id:ns,title:'batch-kv'}));
  expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport.mock.calls.some(([,i])=>i.method==='POST'||i.method==='PUT')).toBe(false);
 });
 it('detects total-count drift across pages rather than creating a duplicate resource',async()=>{
  const f=fixture([await create()]);f.transport.mockResolvedValueOnce(absent()).mockResolvedValueOnce(page([{id:'c'.repeat(32),title:'other'}],{page:1,total_pages:2,total_count:2,per_page:1,count:1})).mockResolvedValueOnce(page([{id:'d'.repeat(32),title:'another'}],{page:2,total_pages:2,total_count:3,per_page:1,count:1})).mockResolvedValueOnce(ok({id:ns,title:'batch-kv'}));
  expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport.mock.calls.some(([,i])=>i.method==='POST'||i.method==='PUT')).toBe(false);
 });
 it.each([
  {rows:[],info:{page:1,total_pages:1,total_count:1}},
  {rows:[],info:{page:1,total_pages:1}},
  {rows:[{id:'c'.repeat(32),title:'other'},{id:'c'.repeat(32),title:'other'}],info:{page:1,total_pages:1,total_count:2}},
  {rows:[{id:'../invalid',title:'other'}],info:{page:1,total_pages:1,total_count:1}},
  {rows:[],info:{page:1,total_pages:1,total_count:0,count:1}}
 ])('never marks KV deletion verified from inconsistent inventory %j',async ({rows,info})=>{
  const f=fixture([{kind:'delete_kv',namespace:ns}]);f.transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(page(rows,info));
  expect((await f.make().tick())?.state).toBe('needs_review');expect(await f.make().tick()).toBe(null);expect(f.transport.mock.calls.filter(([,i])=>i.method==='DELETE')).toHaveLength(1);
 });
 it.each([0,1])('accepts explicit zero-count inventory with total_pages=%i after deletion',async total_pages=>{
  const f=fixture([{kind:'delete_kv',namespace:ns}]);f.transport.mockResolvedValueOnce(ok()).mockResolvedValueOnce(page([],{page:1,total_pages,total_count:0,per_page:100,count:0}));
  expect((await f.make().tick())?.state).toBe('succeeded');
 });
 it('does not delete KV from a page-sized Worker list without completion metadata',async()=>{
  const commands=[{kind:'remove_worker',worker:'demo',namespaces:[ns],cleanup:Object.keys(TEMPLATES).flatMap(t=>['deploy:'+t,'vars:'+t,'favorites:'+t,'override:'+t+':'+aid]).sort().map(domain=>({domain,revision:0}))},{kind:'cleanup_kv',worker:'demo',namespace:ns}],f=fixture(commands);
  f.transport.mockResolvedValueOnce(new Response('old')).mockResolvedValueOnce(ok([{type:'kv_namespace',name:'KV',namespace_id:ns}])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(absent());expect((await f.make().tick())?.state).toBe('running');
  f.transport.mockImplementation(async(url,init)=>{if(init.method==='DELETE')return ok();if(url.endsWith('/scripts/demo'))return absent();if(url.endsWith('/scripts'))return ok(Array.from({length:100},(_,i)=>({id:'other-'+i})));if(url.endsWith('/bindings'))return ok([]);return page([],{page:1,total_pages:0,total_count:0});});
  expect((await f.make().tick())?.state).toBe('needs_review');expect(f.transport.mock.calls.filter(([,i])=>i.method==='DELETE')).toHaveLength(1);
 });
});


describe('frozen compatibility date in executable commands', () => {
    it('uses the command-level date and rejects invalid values at operation parsing', async () => {
        const command = { ...(await upload()), compatibilityDate: '2025-06-01' };
        const f = fixture([command]);
        f.transport.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response('export default {};'));
        expect((await f.make().tick())?.state).toBe('succeeded');
        const put = f.transport.mock.calls.find(([, init]: any) => init?.method === 'PUT')!;
        expect(JSON.parse(((put[1].body as FormData).get('metadata') as string)).compatibility_date).toBe('2025-06-01');
        const operation: any = { schema: 1, account: aid, credential: { email: '', apiToken: 't', globalKey: '', authMode: 'token' }, commands: [{ ...(await upload()), compatibilityDate: '2999-01-01' }] };
        expect(() => parseBusinessOperation(operation, aid)).toThrow(/^INVALID$/);
    });
});
