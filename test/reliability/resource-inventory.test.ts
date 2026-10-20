import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindingNamespaces, planRemovalNamespaces } from '../../src/reliability/resource-inventory';
const account='a'.repeat(32),namespace='b'.repeat(32),credential={email:'',globalKey:'',apiToken:'mock-secret',authMode:'token' as const};
afterEach(()=>vi.useRealTimers());
describe('bounded fixed-host deletion inventory',()=>{
    it('deduplicates references, not names, and ignores unrelated non-KV bindings',()=>{
        expect(bindingNamespaces([{name:'A',type:'kv_namespace',namespace_id:namespace},{name:'B',type:'kv_namespace',namespace_id:namespace},{name:'SECRET',type:'secret_text'}])).toEqual([namespace]);
    });
    it.each([null,{},[{name:'A',type:'kv_namespace'}],[{name:'A',type:'kv_namespace',namespace_id:'../x'}],[{name:'A',type:'plain_text',namespace_id:namespace}],[{name:'A',type:'secret_text'},{name:'A',type:'plain_text'}],new Array(257).fill({name:'x',type:'secret_text'})])('rejects incomplete or ambiguous bindings %#',value=>expect(()=>bindingNamespaces(value)).toThrow('INVALID'));
    it('uses only the fixed account-bound GET, chosen credential, deadline and no redirects',async()=>{
        const transport=vi.fn(async()=>Response.json({success:true,result:[{name:'KV',type:'kv_namespace',namespace_id:namespace}]}));
        expect(await planRemovalNamespaces(account,'demo',credential,transport)).toEqual([namespace]);
        expect(transport.mock.calls[0]).toMatchObject(['https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/demo/bindings',{method:'GET',headers:{Authorization:'Bearer mock-secret'},redirect:'error'},15000]);
    });
    it.each(['denied','redirect','invalid','huge','invalid-utf8'])('refuses %s without exposing credential or response content',async mode=>{
        const transport=vi.fn(async()=> mode==='denied'?Response.json({success:false,errors:[{message:'mock-secret'}]},{status:403}):mode==='redirect'?new Response(null,{status:302,headers:{location:'https://untrusted.test'}}):mode==='huge'?new Response('x'.repeat(262145)):mode==='invalid-utf8'?new Response(new Uint8Array([255])):new Response('mock-secret'));
        await expect(planRemovalNamespaces(account,'demo',credential,transport)).rejects.toThrow('NOT_READY');expect(transport).toHaveBeenCalledTimes(1);
    });
    it.each(['headers','body'])('bounds uncooperative %s, not just time to headers',async mode=>{
        vi.useFakeTimers();const transport=vi.fn(()=>mode==='headers'?new Promise<Response>(()=>{}):Promise.resolve(new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}))));
        const outcome=planRemovalNamespaces(account,'demo',credential,transport).then(()=>'',e=>e.message);
        await vi.advanceTimersByTimeAsync(15001);expect(await outcome).toBe('NOT_READY');
    });
});

describe('real Durable Object bindings are not KV references',()=>{
 it('accepts the actual DO namespace shape without counting its ID as KV',()=>{expect(bindingNamespaces([{name:'CONFIG_KV',type:'kv_namespace',namespace_id:namespace},{name:'RELIABILITY_COORDINATOR',type:'durable_object_namespace',namespace_id:'c'.repeat(32),class_name:'ProductionCoordinator'}])).toEqual([namespace]);});
 it('accepts unresolved or cross-script DO references only as non-KV bindings',()=>{expect(bindingNamespaces([{name:'DO',type:'durable_object_namespace',class_name:'Counter',script_name:'other-worker',environment:'production'}])).toEqual([]);});
 it.each([{name:'DO',type:'durable_object_namespace',namespace_id:'../bad',class_name:'Counter'},{name:'DO',type:'durable_object_namespace',namespace_id:'c'.repeat(32)},{name:'not-do',type:'future_namespace',namespace_id:'c'.repeat(32)}])('does not broaden malformed/unknown namespace-bearing bindings %#',b=>{expect(()=>bindingNamespaces([b])).toThrow('INVALID');});
});
