import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {applicationSpec,createIsolatedApplicationTransport,GENERATION,GETS}=require('../scripts/isolated-application-transport.cjs');
const {parseReply}=require('../scripts/isolated-read-transport.cjs');
const {assertPrivate}=require('../scripts/maintenance-client.cjs');
async function assertPrivateCurlOutputs(args:string[]) {
 for(const flag of ['--dump-header','--output']) {
  const file=args[args.indexOf(flag)+1],stat=await fs.lstat(file);
  expect(stat.isFile()).toBe(true);expect(stat.size).toBe(0);
  await assertPrivate(file);
 }
}
const origin='https://cfauto-accept-47142c9e5f538c32.mak.kdns.fr';
const refusal={key:'refusal2_chain_up_'+'a'.repeat(32),generation:GENERATION,epoch:1,revision:1,selector:{kind:'variables',template:'cmliu'},value:[{key:'UNIT_MARKER',value:'must-not-write'}]};
const post=(x:unknown)=>({method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(x),redirect:'manual'});
describe('isolated application acceptance transport',()=>{
 it('allows the finite existing read fixture URLs and a bounded bootstrap',()=>{for(const p of GETS)expect(applicationSpec(origin+p).limit).toBe(65536);expect(applicationSpec(origin+'/app.js?v=bdf30971').limit).toBe(2097152);});
 it('accepts only login and the exact synthetic maintenance refusal payload',()=>{expect(applicationSpec(origin+'/api/login',post({code:'fake-secret'})).method).toBe('POST');expect(applicationSpec(origin+'/api/reliability/config',post(refusal)).body.toString()).toBe(JSON.stringify(refusal));});
 it.each(['epoch','revision','generation','key','selector','value'])('rejects changed refusal %s',key=>{expect(()=>applicationSpec(origin+'/api/reliability/config',post({...refusal,[key]:'changed'}))).toThrow();});
 it.each(['/api/deploy','/api/reliability/maintenance','/api/restore','/api/login?redirect=external'])('rejects non-acceptance writes %s',p=>expect(()=>applicationSpec(origin+p,post({code:'fake'}))).toThrow());
 it('rejects arbitrary hosts, provider endpoints, HTTP, redirects and credential headers',()=>{for(const p of ['https://manager.mak.kdns.fr/api/accounts','https://api.cloudflare.com/client/v4/accounts/x','http://cfauto-accept-47142c9e5f538c32.mak.kdns.fr/api/accounts'])expect(()=>applicationSpec(p)).toThrow('TARGET_DENIED');expect(()=>applicationSpec(origin+'/api/accounts',{redirect:'follow'})).toThrow();expect(()=>applicationSpec(origin+'/api/accounts',{headers:{Authorization:'secret'}})).toThrow();});
 it('rejects arbitrary queries, paths, POST bodies, origins and malformed login',()=>{expect(()=>applicationSpec(origin+'/api/settings?type=other')).toThrow();expect(()=>applicationSpec(origin+'/app.js?v=secret')).toThrow();expect(()=>applicationSpec(origin+'/api/accounts',{body:'x'})).toThrow();expect(()=>applicationSpec(origin+'/api/login',{...post({code:'test'}),headers:{Origin:'https://example.com'}})).toThrow();expect(()=>applicationSpec(origin+'/api/login',post({code:'x',extra:true}))).toThrow();});
 it('keeps 64KiB default while permitting explicit 2MiB app bytes',async()=>{const b=Buffer.alloc(70000,97),h=Buffer.from('HTTP/2 200\r\nContent-Type: text/javascript\r\n\r\n');expect(()=>parseReply('200 0',h,b)).toThrow();expect((await parseReply('200 0',h,b,2097152).arrayBuffer()).byteLength).toBe(70000);for(const cap of [0,-1,Infinity,2097153])expect(()=>parseReply('200 0',h,b,cap)).toThrow('LIMIT_INVALID');});
 it('keeps login body and cookie headers out of command arguments and preserves raw response',async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'cfauto-app-transport-'));let calls=0;const t=await createIsolatedApplicationTransport({out:path.join(base,'evidence'),run:async(args:string[],config:string)=>{calls++;expect(args.join(' ')).not.toMatch(/fake-secret|fake-cookie|insecure|--retry|--location/);expect(args).toContain('--ipv6');expect(config).toContain('fake-cookie');const line=config.split('\n').find(l=>l.startsWith('data-binary = '))!;expect(await fs.readFile(JSON.parse(line.slice('data-binary = '.length)).slice(1),'utf8')).toBe(JSON.stringify({code:'fake-secret'}));await assertPrivateCurlOutputs(args);await fs.writeFile(args[args.indexOf('--dump-header')+1],'HTTP/2 200\r\nSet-Cookie: __Host-auth=fake-result; Secure\r\nContent-Type: application/json\r\n\r\n');await fs.writeFile(args[args.indexOf('--output')+1],'{"ok":true}');return '200 0';}});const r=await t(origin+'/api/login',{...post({code:'fake-secret'}),headers:{Cookie:'fake-cookie'}});expect(r.headers.getSetCookie()).toHaveLength(1);expect(await r.json()).toEqual({ok:true});expect(calls).toBe(1);
 },30000);
 it('performs no retry on uncertain refusal response and retains failure',async()=>{const base=await fs.mkdtemp(path.join(os.tmpdir(),'cfauto-app-fail-'));let calls=0;const t=await createIsolatedApplicationTransport({out:path.join(base,'evidence'),run:async()=>{calls++;throw Object.assign(Error('TRANSPORT_FAILED_OUTCOME_UNCERTAIN'),{curlExitCode:28});}});await expect(t(origin+'/api/reliability/config',post(refusal))).rejects.toThrow();expect(calls).toBe(1);const e=JSON.parse(await fs.readFile(path.join(base,'evidence/0001/failure.json'),'utf8'));expect(e.curlExitCode).toBe(28);expect(e.automaticRetry).toBe(false);},30000);
});
