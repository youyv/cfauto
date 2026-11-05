import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {TARGET,PROTECTED_WORKER,routes,readProductionControlPlane,assertLegacyProduction}=require('../scripts/production-control-plane.cjs');
const version='11111111-1111-4111-8111-111111111111',deployment='22222222-2222-4222-8222-222222222222';
const source='export default {fetch(){return new Response("unchanged legacy");}};',hash=(x:any)=>createHash('sha256').update(x).digest('hex');
async function fixture(mode='normal'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cfauto-production-read-'));await fs.mkdir(path.join(root,'.wrangler'));const out=path.join(root,'.wrangler','capture'),calls:any[]=[],seen=new Map<string,number>();
 const settings={compatibility_date:'2026-07-16',compatibility_flags:[],bindings:[{name:'CONFIG_KV',type:'kv_namespace',namespace_id:TARGET.namespace},{name:'ACCESS_CODE',type:'secret_text'},{name:'GITHUB_TOKEN',type:'secret_text'}]};
 const transport=async(url:string,init:any)=>{expect(init.method).toBe('GET');expect(init.redirect).toBe('manual');expect(init.headers.Authorization).toBe('Bearer fake-api-token');const u=new URL(url);expect(u.hostname).toBe('api.cloudflare.com');calls.push(u.pathname);const n=(seen.get(u.pathname)||0)+1;seen.set(u.pathname,n);if(mode==='http')return Response.json({success:false,errors:[{code:10000}]},{status:403});if(mode==='contradiction')return Response.json({success:true,result:{},errors:[{code:10000}]});let result:any,info:any;
 if(u.pathname.endsWith('/workers/domains')){result=[{id:'domain',service:'manager',hostname:TARGET.hostname,zone_id:TARGET.zone,previews_enabled:false}];info={total_count:1};}
 else if(u.pathname.endsWith('/workers/routes'))result=mode==='routes'&&n===2?[{id:'new-route',pattern:'example.invalid/*',script:'manager'}]:[];
 else if(u.pathname.includes('/storage/kv/namespaces/'))result={id:mode==='namespace'?'f'.repeat(32):TARGET.namespace,title:'retained'};
 else if(u.pathname.endsWith('/content/v2'))return new Response(source);
 else if(u.pathname.includes('/versions/'))result={id:version,resources:{bindings:settings.bindings}};
 else if(u.pathname.endsWith('/settings'))result=u.pathname.includes(PROTECTED_WORKER)?{untouched:mode==='protected'&&n===2?'changed':'original'}:settings;
 else if(u.pathname.endsWith('/deployments'))result={deployments:[{id:deployment,versions:[{version_id:version,percentage:mode==='split'?50:100}]}]};
 else if(u.pathname.endsWith('/schedules'))result={schedules:mode==='cron'&&n===2?[]:[{cron:'*/5 * * * *'}]};
 else if(u.pathname.endsWith('/subdomain'))result={enabled:false,previews_enabled:false};
 else throw Error('UNEXPECTED_READ');return Response.json({success:true,errors:mode==='nullable-errors'&&u.pathname.endsWith('/workers/domains')?null:[],result,...(info?{result_info:info}:{})});};
 return {root,out,transport,calls,settings};
}
describe('fixed production control-plane preflight',()=>{
 it('captures complete raw evidence across two stable controls with no write or release approval',async()=>{const f=await fixture(),s=await readProductionControlPlane({...f,token:'fake-api-token'});expect(f.calls).toHaveLength(23);expect(s).toMatchObject({stableAcrossRead:true,readOnly:true,freezeProven:false,drainProven:false,migrationReady:false,releaseAllowed:false,routingScope:{accountWideRoutesVerified:false},source:{sha256:hash(source)}});expect(await fs.readFile(path.join(f.out,'worker.js'),'utf8')).toBe(source);expect(JSON.stringify(s)).not.toContain('fake-api-token');expect(assertLegacyProduction(s,{sourceSha256:hash(source),version,deployment})).toMatchObject({legacyShapeVerified:true,releaseAllowed:false});},30000);
 it.each(['cron','routes','protected'])('refuses %s drift without promoting a partial snapshot to stable',async mode=>{const f=await fixture(mode);await expect(readProductionControlPlane({...f,token:'fake-api-token'})).rejects.toThrow('PRODUCTION_CONTROL_CHANGED');const failure=JSON.parse(await fs.readFile(path.join(f.out,'failure.json'),'utf8'));expect(failure.releaseAllowed).toBe(false);},30000);
 it.each(['http','contradiction','namespace','split'])('fails closed on %s evidence',async mode=>{const f=await fixture(mode);await expect(readProductionControlPlane({...f,token:'fake-api-token'})).rejects.toThrow();expect(f.calls.length).toBeGreaterThan(0);},30000);
 it('does not permit an output outside the explicitly selected evidence root',async()=>{const f=await fixture();await expect(readProductionControlPlane({...f,out:path.join(f.root,'outside'),token:'fake-api-token'})).rejects.toThrow('INPUT_INVALID');expect(f.calls).toHaveLength(0);});
 it('rejects partial or duplicate route inventories while retaining the real nonpaginated empty-list contract',()=>{expect(routes({result:[]})).toEqual([]);expect(()=>routes({result:[],result_info:{total_count:1}})).toThrow();expect(()=>routes({result:[{id:'a',pattern:'x',script:null},{id:'a',pattern:'y',script:'manager'}]})).toThrow();expect(()=>routes({result:[{id:'a',pattern:'x',script:3}]})).toThrow();});
 it('rejects unreviewed secrets, schedules, domains and source rather than generating a freeze approval',async()=>{const f=await fixture(),s=await readProductionControlPlane({...f,token:'fake-api-token'}),expected={sourceSha256:hash(source),version,deployment};const changed=structuredClone(s);changed.settings.bindings.push({name:'ENCRYPTION_SECRET',type:'secret_text'});expect(()=>assertLegacyProduction(changed,expected)).toThrow('BINDINGS_UNREVIEWED');expect(()=>assertLegacyProduction(s,{...expected,sourceSha256:'f'.repeat(64)})).toThrow('IDENTITY_MISMATCH');const schedule=structuredClone(s);schedule.schedules.schedules=[];expect(()=>assertLegacyProduction(schedule,expected)).toThrow('TRIGGERS_UNREVIEWED');},30000);
});

it('accepts the observed domains success envelope with errors:null without treating it as a release approval',async()=>{const f=await fixture('nullable-errors'),s=await readProductionControlPlane({...f,token:'fake-api-token'});expect(s.stableAcrossRead).toBe(true);expect(s.releaseAllowed).toBe(false);expect(s.domains).toHaveLength(1);},30000);
