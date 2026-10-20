import {resourcePolicy,type ProtectedResources} from './business-command';
import {ConfigStore} from './config-store';
import {CredentialAuthority} from './credential-authority';
import {readCredentialAccounts} from './credential-accounts';
import type {KeyRing} from './credential-envelope';
import {ConfigReadSnapshot} from './config-read-snapshot';
import {withReadOnlyNetwork,enforceReadOnlyNetwork} from './read-only-network';
import {boundedReadResponse} from './read-response';
import {parseExternalRead,type ExternalReadIntent} from './external-read-intent';
import {canonical,ReliabilityError,type Json} from './protocol';
import {cf,fetchWithTimeout,getAuthHeaders} from '../lib/cloudflare-api';
import {fetchInternalStats} from '../lib/stats';
import {getWorkerNames,hasAccountCredentials} from '../lib/account-store';
import {handleCheckUpdate,handleGetCode,handleDiff} from '../routes/check';
import {handleDeployPreview} from '../lib/deploy-preview';
import {validateGithubDraft} from '../lib/github';
import {legacyHttpIntent} from './application-intent';
import {TEMPLATES} from '../config/templates';
import type {AccountEntry} from '../lib/types';
import type {AppEnv} from '../config/env';
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
const object=(v:any):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const worker=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(v);
const date=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
export type ReadTransport=(url:string,init:RequestInit,timeout:number)=>Promise<Response>;
interface Options {ring:KeyRing;githubToken?:string;transport?:ReadTransport;protected?:ProtectedResources}
/** Global-only authenticated reads. Captures one DO generation; never accepts a
 * live CONFIG_KV binding, caller credentials, arbitrary URL or arbitrary handler.
 * No admission, mutation, writes to config, cache, task or deployment state. */
export class ExternalReads {
 private readonly options:Options;
 constructor(private readonly config:ConfigStore,private readonly authority:CredentialAuthority,options:Options){this.options={...options,protected:resourcePolicy(options.protected??{workers:[],namespaces:[]}),ring:{...options.ring,keys:{...options.ring.keys}}};}
 private async response(url:string,account:AccountEntry):Promise<{status:number;body:any}>{
  if(!hasAccountCredentials(account))return unavailable();
  const init=enforceReadOnlyNetwork(url,{method:'GET',headers:getAuthHeaders(account),redirect:'manual'})!;
  const controller=new AbortController(),deadline=Date.now()+10000;let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ReliabilityError('NOT_READY',503));},10000);});
  try{
   const pending=(this.options.transport??fetchWithTimeout)(url,{...init,signal:controller.signal},10000);
   void pending.then(r=>{if(controller.signal.aborted)void r.body?.cancel().catch(()=>{});},()=>{});
   const raw=await Promise.race([pending,timeout]),response=await boundedReadResponse(raw,deadline);
   if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return unavailable();
   let body:any;try{body=await response.json();}catch{return unavailable();}
   return {status:response.status,body};
  }finally{if(timer!==undefined)clearTimeout(timer);}
 }
 private async success(url:string,account:AccountEntry):Promise<any>{
  const r=await this.response(url,account);
  if(r.status!==200||!object(r.body)||r.body.success!==true||(r.body.errors!==undefined&&(!Array.isArray(r.body.errors)||r.body.errors.length)))return unavailable();
  return r.body;
 }
 private async bindings(account:AccountEntry,name:string):Promise<Array<Record<string,any>>>{
  const value=(await this.success(cf.workerBindings(account.accountId,name),account)).result;
  if(!Array.isArray(value)||value.length>256)return unavailable();const names=new Set<string>();
  return value.map(b=>{
   if(!object(b)||typeof b.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(b.name)||names.has(b.name)||typeof b.type!=='string')return unavailable();names.add(b.name);
   if(b.type==='plain_text'&&(typeof b.text!=='string'||b.text.length>65536))return unavailable();
   // Hidden Secrets must stay hidden even if a provider accidentally includes text.
   return b.type==='secret_text'?{name:b.name,type:b.type}:b;
  });
 }
 private async list(account:AccountEntry,kind:'zones'|'workers'|'namespaces'):Promise<any[]> {
  const items:any[]=[],seen=new Set<string>();let expectedTotal:number|undefined,expectedPages:number|undefined,expectedPageSize:number|undefined;
  for(let page=1;page<=100;page++){
   const url=kind==='zones'?cf.zones(account.accountId)+'&page='+page:(kind==='workers'?cf.workerScripts(account.accountId):cf.kvNamespaces(account.accountId))+'?per_page=100&page='+page;
   const data=await this.success(url,account),rows=data.result;
   if(!Array.isArray(rows)||rows.length>100)return unavailable();
   for(const row of rows){
    if(!object(row)||!(kind==='zones'?id(row.id)&&typeof row.name==='string'&&/^[a-z0-9.-]{1,253}$/i.test(row.name):kind==='namespaces'?id(row.id)&&typeof row.title==='string'&&row.title.length<=512:worker(row.id))||seen.has(row.id))return unavailable();
    if(kind==='workers'&&((row.created_on!==undefined&&!date(row.created_on))||(row.modified_on!==undefined&&!date(row.modified_on))))return unavailable();
    seen.add(row.id);items.push(kind==='zones'?{id:row.id,name:row.name}:kind==='namespaces'?{id:row.id,title:row.title}:{id:row.id,...(row.created_on?{created_on:row.created_on}:{}),...(row.modified_on?{modified_on:row.modified_on}:{})});
   }
   const info=data.result_info;
   // Workers schema may omit pagination entirely. A page-sized response without
   // metadata is ambiguous, never proof of complete inventory. Remote contract
   // acceptance remains a release gate; do not silently drop a possible next page.
   if(info===undefined){if(kind!=='workers'||page!==1||rows.length>=100||Object.keys(data).some(k=>!['success','errors','messages','result'].includes(k)))return unavailable();return items;}
   if(!object(info)||!['page','per_page','count','total_count','total_pages'].every(k=>Number.isSafeInteger(info[k])&&info[k]>=0)||info.page!==page||info.per_page<1||info.per_page>100||info.count!==rows.length||rows.length>info.per_page||info.total_count>5000||info.total_pages>100)return unavailable();
   const pages=Math.max(1,Math.ceil(info.total_count/info.per_page));
   if(info.total_pages!==pages&&!(info.total_count===0&&info.total_pages===0))return unavailable();
   if(expectedTotal!==undefined&&(expectedTotal!==info.total_count||expectedPages!==pages||expectedPageSize!==info.per_page))return unavailable();
   expectedTotal=info.total_count;expectedPages=pages;expectedPageSize=info.per_page;
   if(page>=pages){if(items.length!==info.total_count)return unavailable();return items;}
   if(rows.length!==info.per_page)return unavailable();
  }
  return unavailable();
 }
 async read(input:unknown):Promise<Json>{
  const intent=parseExternalRead(input),view=this.config.readAll(),runtime=this.config.readRuntime();
  const records=new Map(view.records.map(r=>[r.domain,r])),accountRecord=records.get('accounts');if(!accountRecord?.revision)return unavailable();
  this.authority.authorizeRead(view.generation,view.epoch,accountRecord.revision,[]);
  const accounts=await readCredentialAccounts(accountRecord.value as unknown as AccountEntry[],this.options.ring);
  let selected='account' in intent?accounts.filter(a=>a.accountId===intent.account):['stats','verify','diag','preview'].includes(intent.kind)?accounts:[];
  if('account' in intent&&selected.length!==1)throw new ReliabilityError('NOT_READY',404);
  if(intent.kind==='preview'){
   const draft=intent.draft as Record<string,any>;
   selected=draft.batch?accounts.filter(a=>Array.isArray(draft.batch.targetAccounts)&&draft.batch.targetAccounts.includes(a.alias)):accounts.filter(a=>getWorkerNames(a,intent.template).length&&(!draft.targetAccountIds||Array.isArray(draft.targetAccountIds)&&draft.targetAccountIds.includes(a.accountId)));
  }
  const assertCurrent=()=>{
   this.authority.authorizeRead(view.generation,view.epoch,accountRecord.revision,selected.map(a=>({account:a.accountId,credentialRevision:a.credentialRevision!})));
   const now=this.config.readAll();if(now.generation!==view.generation||now.epoch!==view.epoch||now.watermark!==view.watermark)throw new ReliabilityError('CONFLICT',409);
  };
  assertCurrent();
  const env:AppEnv={CONFIG_KV:new ConfigReadSnapshot(view.records),reliabilityReadOnly:true,reliabilityPreview:{namespaces:a=>this.list(a,'namespaces'),workers:a=>this.list(a,'workers'),bindings:(a,w)=>this.bindings(a,w)},reliabilityCredentials:{ring:this.options.ring,observationUntil:0,now:Date.now()},...(this.options.githubToken?{GITHUB_TOKEN:this.options.githubToken}:{})};
  const data=await withReadOnlyNetwork({accounts:selected.map(a=>a.accountId),assertCurrent},()=>this.execute(intent,accounts,env,view,runtime));
  assertCurrent();
  return JSON.parse(canonical({data,generation:view.generation,epoch:view.epoch,revisions:Object.fromEntries(view.records.map(r=>[r.domain,r.revision]))}));
 }
 private async execute(intent:ExternalReadIntent,accounts:AccountEntry[],env:AppEnv,view:ReturnType<ConfigStore['readAll']>,runtime:ReturnType<ConfigStore['readRuntime']>):Promise<Json>{
  const selected='account' in intent?accounts.find(a=>a.accountId===intent.account)!:null;
  if(intent.kind==='zones')return {success:true,zones:await this.list(selected!,'zones')};
  if(intent.kind==='workers')return {success:true,workers:await this.list(selected!,'workers')};
  if(intent.kind==='bindings'){
   const value=await this.bindings(selected!,intent.worker);
   return {success:true,data:value.filter(b=>['plain_text','secret_text'].includes(b.type)).map(b=>({key:b.name,value:b.type==='secret_text'?'':b.text,secret:b.type==='secret_text'}))};
  }
  if(intent.kind==='subdomain'){
   const r=await this.response(cf.acctSubdomain(intent.account),selected!);
   // An arbitrary 404 is NOT proof that the account has no subdomain. Keep its
   // absence unconfirmed until the real API absence contract is validated.
   if(r.status!==200||r.body?.success!==true||(r.body.errors!==undefined&&(!Array.isArray(r.body.errors)||r.body.errors.length))||!object(r.body.result)||typeof r.body.result.subdomain!=='string'||(r.body.result.subdomain&&!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(r.body.result.subdomain)))return unavailable();
   return {success:true,subdomain:r.body.result.subdomain};
  }
  if(intent.kind==='stats')return (await fetchInternalStats(accounts)).map(r=>({...r,...(r.error?{error:'统计不可核验；禁止据此熔断'}:{})}));
  if(intent.kind==='verify'){
   const results:Json[]=[];for(const a of accounts){try{const r=await this.success(cf.account(a.accountId),a);if(r.result?.id!==a.accountId)return unavailable();results.push({accountId:a.accountId,alias:a.alias,ok:true,status:200});}catch{results.push({accountId:a.accountId,alias:a.alias,ok:false,error:'账号归属或凭据无法核验'});}}return results;
  }
  if(intent.kind==='diag'){
   const records=new Map(view.records.map(r=>[r.domain,r])),drifted:string[]=[],missing:string[]=[],unreadable:string[]=[];let checked=0;
   for(const a of accounts){const targets=Object.keys(TEMPLATES).flatMap(t=>getWorkerNames(a,t).map(name=>({name,t,at:(records.get('deploy:'+t)?.value as any)?.deployTime})));checked+=targets.length;if(!targets.length)continue;
    try{const remote=await this.list(a,'workers'),map=new Map(remote.map(r=>[r.id,r.modified_on]));for(const target of targets){const label=target.t+' '+a.alias+' -> ['+target.name+']';if(!map.has(target.name))missing.push(label);else if(!date(map.get(target.name))||!date(target.at))unreadable.push(label);else if(Date.parse(map.get(target.name))<Date.parse(target.at)-120000)drifted.push(label);}}
    catch{unreadable.push(a.alias+'（完整列表无法核验）');}
   }
   return {success:true,__authority:{kind:'durable_object',generation:view.generation,epoch:view.epoch,watermark:view.watermark,domains:view.records.length,runtimeRevision:runtime.revision,retention:'retain_all_no_deletes'},__github_token_set:!!this.options.githubToken,__deploy_drift:{checked,drifted,missing,unreadable,evidence:'metadata_only',note:'时间戳仅提示可能漂移，不能证明源码/绑定相同；缺少或不完整列表不推断资源已删除。'}};
  }
  if(intent.kind==='preview_targets'){
   const targets=accounts.flatMap(a=>getWorkerNames(a,intent.template).map(workerName=>({accountId:a.accountId,alias:a.alias,workerName,...(this.options.protected!.workers.some(p=>p.account===a.accountId)?{subdomainRotationAllowed:false}:{})})));
   return {success:true,accounts:new Set(targets.map(t=>t.accountId)).size,workers:targets.length,targets,details:targets.map(t=>t.alias+' -> ['+t.workerName+']')};
  }
  if(intent.kind==='validate_source')return await validateGithubDraft(env,intent.template,intent.draft) as unknown as Json;
  const deployed:unknown='template' in intent?view.records.find(r=>r.domain==='deploy:'+intent.template)?.value:null;
  const custom=object(deployed)&&deployed.mode==='fixed'&&deployed.currentSha===null&&typeof deployed.currentCustomSha==='string'&&/^[a-f0-9]{64}$/.test(deployed.currentCustomSha)?deployed:null;
  if(intent.kind==='diff'&&custom)return {status:'custom_fixed',commits:[],localSha:null,customDigest:custom.currentCustomSha,remoteSha:null,pending:custom.pendingTargets??[],message:'当前为固定自定义源码，不伪造官方 SHA，也不使用官方提交数衡量落后。'};
  let response:Response;
  if(intent.kind==='preview'){
   const draft=intent.draft as Record<string,Json>,batch=draft.batch;
   if(batch!==undefined){if(Object.keys(draft).length!==1||!object(batch)||(batch as Record<string,Json>).template!==intent.template)throw new ReliabilityError('INVALID',400);legacyHttpIntent(new Request('https://preview.invalid/api/batch_deploy',{method:'POST',headers:{'idempotency-key':'preview-only'}}),batch);}
   else legacyHttpIntent(new Request('https://preview.invalid/api/deploy?type='+intent.template,{method:'POST',headers:{'idempotency-key':'preview-only'}}),draft);
   response=await handleDeployPreview(new Request('https://preview.invalid/api/deploy/preview?type='+intent.template,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(draft)}),env);
  }else if(intent.kind==='code')response=await handleGetCode(env,intent.template);
  else if(intent.kind==='diff')response=await handleDiff(env,intent.template);
  else if(intent.kind==='version')response=await handleCheckUpdate(env,intent.template,intent.history?'history':undefined,intent.limit);
  else return unavailable();
  if(!response.ok)return unavailable();let result:Json;try{result=await response.json();}catch{return unavailable();}if(intent.kind==='version'&&!intent.history&&custom&&object(result))result={...result,local:{kind:'custom',sha:null,digest:custom.currentCustomSha,date:custom.deployTime??null},comparable:false};return result;
 }
}
