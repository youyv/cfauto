import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {HOST,requestSpec,parseReply,runCurl,createIsolatedReadTransport}=require('../scripts/isolated-read-transport.cjs');
const target={account:'fb86300faed47e7052b380db19fe844d',worker:'cfauto-accept-47142c9e5f538c32',namespace:'93710833ee1c40dd88a3a3a5a526453f'};
const message=(action='status')=>JSON.stringify({target,command:{id:'test',action,expected:null,args:{}},signature:'test-signature'});
const post=(body=message())=>({method:'POST',body,headers:{'Content-Type':'application/json'},redirect:'manual'});
const url='https://'+HOST+'/api/reliability/maintenance';
const reply=(status=200,extra='')=>Buffer.from('HTTP/2 '+status+'\r\nContent-Type: application/json\r\n'+extra+'\r\n');
describe('isolated alternate read transport',()=>{
 it('allows only fixed isolated read-only maintenance commands',()=>{expect(requestSpec(url,post()).body.toString()).toBe(message());expect(requestSpec(url,post(message('initial_identity'))).method).toBe('POST');});
 it.each(['initial_activate','initial_import_begin','set_maintenance','review_close_failed'])('rejects mutation %s before network',action=>{expect(()=>requestSpec(url,post(message(action)))).toThrow('ACTION_DENIED');});
 it('rejects other targets, redirects, credential headers and malformed/oversize requests',()=>{
  for(const u of ['https://manager.mak.kdns.fr/api/reliability/maintenance','http://'+HOST+'/api/reliability/maintenance','https://user:pass@'+HOST+'/api/reliability/maintenance'])expect(()=>requestSpec(u,post())).toThrow('TARGET_DENIED');
  expect(()=>requestSpec(url,{...post(),redirect:'follow'})).toThrow('REDIRECT_DENIED');expect(()=>requestSpec(url,{...post(),headers:{Authorization:'secret'}})).toThrow('HEADER_DENIED');
  for(const body of ['bad','x'.repeat(8193),message().replace(target.account,'wrong')])expect(()=>requestSpec(url,post(body))).toThrow();
 });
 it('returns exact body, status and repeated cookies while handling interim headers',async()=>{const r=parseReply('200 0',Buffer.concat([Buffer.from('HTTP/1.1 100 Continue\r\n\r\n'),reply(200,'Set-Cookie: one=1\r\nSet-Cookie: two=2\r\n')]),Buffer.from('{"ok":true}'));expect(await r.text()).toBe('{"ok":true}');expect(r.headers.getSetCookie()).toEqual(['one=1','two=2']);});
 it.each([['200 7',reply(),Buffer.from('{}')],['302 0',reply(302),Buffer.alloc(0)],['200 0',reply(403),Buffer.alloc(0)],['200 0',reply(200,'Content-Encoding: gzip\r\n'),Buffer.alloc(0)],['200 0',reply(),Buffer.alloc(65537)]])('rejects unsafe response %s',(status,headers,body)=>expect(()=>parseReply(status,headers,body)).toThrow());
 it('does not spawn an already aborted request',async()=>{const c=new AbortController();c.abort();await expect(runCurl([], '',c.signal,()=>{throw Error('spawned');})).rejects.toThrow('ABORTED');});
 it('aborts one child without retry and hides stderr',async()=>{const c=new AbortController(),child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};let killed=0,spawned=0;child.kill=()=>{killed++;};const p=runCurl([], 'private',c.signal,()=>{spawned++;return child;});child.stderr.emit('data',Buffer.from('secret'));c.abort();child.emit('close',1);await expect(p).rejects.toThrow('ABORTED_OUTCOME_UNCERTAIN');expect(killed).toBe(1);expect(spawned).toBe(1);});
 it('preserves request bytes privately, passes no secret arguments, and never enables insecure/retry/redirect flags',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cfauto-read-transport-'));let calls=0;const transport=await createIsolatedReadTransport({out:path.join(dir,'evidence'),run:async(args:string[],config:string)=>{calls++;expect(args[0]).toBe('--disable');expect(args).toContain('--ipv6');expect(args.join(' ')).not.toMatch(/test-signature|insecure|--retry|--location/);expect(config).toContain('\nrequest = "POST"\n');const line=config.split('\n').find(l=>l.startsWith('data-binary = '))!;const file=JSON.parse(line.slice('data-binary = '.length)).slice(1);expect(await fs.readFile(file,'utf8')).toBe(message());await fs.writeFile(args[args.indexOf('--dump-header')+1],reply());await fs.writeFile(args[args.indexOf('--output')+1],'{"ok":true}');return '200 0';}});expect(await (await transport(url,post())).json()).toEqual({ok:true});expect(calls).toBe(1);
 },30000);
 it('only delegates fixed-account provider GET and never provider mutations',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cfauto-read-scope-'));let calls=0;const t=await createIsolatedReadTransport({out:path.join(dir,'evidence'),nativeFetch:async()=>{calls++;return new Response('{}');}});await t('https://api.cloudflare.com/client/v4/accounts/'+target.account+'/workers/scripts',{method:'GET'});await expect(t('https://api.cloudflare.com/client/v4/accounts/'+target.account+'/workers/scripts/x',{method:'PUT'})).rejects.toThrow();await expect(t('https://api.cloudflare.com/client/v4/accounts/other/workers/scripts')).rejects.toThrow();expect(calls).toBe(1);},30000);
 it('preserves curl failure and does not automatically retry',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cfauto-read-failure-'));let calls=0;const t=await createIsolatedReadTransport({out:path.join(dir,'evidence'),run:async()=>{calls++;throw Error('TRANSPORT_FAILED_OUTCOME_UNCERTAIN');}});await expect(t(url,post())).rejects.toThrow('OUTCOME_UNCERTAIN');expect(calls).toBe(1);expect(JSON.parse(await fs.readFile(path.join(dir,'evidence/0001/failure.json'),'utf8')).automaticRetry).toBe(false);},30000);
});
