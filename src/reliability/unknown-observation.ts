import type {SqlDatabase} from './config-store';
import type {CredentialPermit} from './credential-authority';
import {ExecutionJournal,type JournalCallEvidence} from './execution-journal';
import {SealedStore,type SealedContext} from './sealed-store';
import {canonical,identifier,revision,ReliabilityError,type Json} from './protocol';
import {accountId,shape} from './business-command';
export interface ObservationRequest {id:string;operator:string;permit:CredentialPermit;epoch:number;accountsRevision:number;step:number;call:number}
interface Options {digestSecret:string;authorize:(request:ObservationRequest)=>Promise<void>;transport:(url:string,init:RequestInit)=>Promise<Response>;isExecuting:()=>boolean;timeoutMs?:number}
interface Row extends Record<string,unknown>{id:string;intent:string;basis:string;state:string;summary:string|null;error:string|null}
interface Target {url:string;kind:string;collection:boolean}
interface ReadSummary {kind:string;page:number;status:number;resourceState:'present'|'absent'|'unconfirmed';completeInventory:boolean;bytes:number;startedAt:number;finishedAt:number}
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
const encoder=new TextEncoder();
function copied<T>(value:T):T{return JSON.parse(canonical(value));}
export function parseObservationRequest(raw:ObservationRequest):ObservationRequest {
 const r=copied(raw);shape(r,'id,operator,permit,epoch,accountsRevision,step,call');identifier(r.id);identifier(r.operator);if(r.id.length>60)invalid();
 shape(r.permit,'task,account,generation,snapshot,token,credentialRevision');accountId(r.permit.account);
 for(const key of ['task','generation','snapshot','token'] as const)identifier(r.permit[key]);
 for(const n of [r.permit.credentialRevision,r.epoch,r.accountsRevision,r.step,r.call])revision(n);
 if(!r.permit.credentialRevision||!r.accountsRevision||r.step>=100||r.call>=500)invalid();return r;
}
function targets(call:JournalCallEvidence,account:string):{targets:Target[];headers:Headers} {
 if(!Array.isArray(call.request)||call.request.length!==4)invalid();const [raw,method,headers]=call.request as Json[];
 if(typeof raw!=='string'||typeof method!=='string'||!Array.isArray(headers))invalid();
 const url=new URL(raw as string),prefix='/client/v4/accounts/'+account;
 if(url.origin!=='https://api.cloudflare.com'||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(prefix+'/'))invalid();
 const auth=new Headers();for(const pair of headers as Json[]){if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||typeof pair[1]!=='string')invalid();const [name,value]=pair as string[];if(['authorization','x-auth-email','x-auth-key'].includes(name.toLowerCase())){if(auth.has(name))invalid();auth.set(name,value);}}
 if(auth.has('authorization')?(auth.has('x-auth-key')||auth.has('x-auth-email')||!/^Bearer [^\s]+$/.test(auth.get('authorization')!)):(!auth.has('x-auth-key')||!auth.has('x-auth-email')))invalid();
 const path=url.pathname.slice(prefix.length),result:Target[]=[];
 const add=(suffix:string,kind:string,collection=false)=>result.push({url:'https://api.cloudflare.com'+prefix+suffix,kind,collection});
 if(/^\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,62}$/.test(path)&&['PUT','DELETE'].includes(method as string)){
  add(path,'worker');add(path+'/bindings','bindings');add(path+'/subdomain','workers_dev');
 }else if(/^\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,62}\/subdomain$/.test(path)&&method==='POST')add(path,'workers_dev');
 else if(path==='/workers/subdomain'&&['PUT','DELETE'].includes(method as string))add(path,'account_subdomain');
 else if(path==='/workers/domains'&&method==='PUT')add(path,'domains',true);
 else if(path==='/storage/kv/namespaces'&&method==='POST')add(path,'namespaces',true);
 else if(/^\/storage\/kv\/namespaces\/[a-f0-9]{32}$/.test(path)&&method==='DELETE')add(path,'namespace');
 else if(/^\/storage\/kv\/namespaces\/[a-f0-9]{32}\/values\/[^/]+$/.test(path)&&method==='PUT')add(path,'kv_value');
 else invalid();return {targets:result,headers:auth};
}
function b64(bytes:Uint8Array):string{let text='';for(let i=0;i<bytes.length;i+=4096)text+=String.fromCharCode(...bytes.subarray(i,i+4096));return btoa(text);}
/** Account-local observation, not execution or adjudication. Only a role-authenticated
 * maintenance orchestrator may call this service. Original call data never enters a
 * public response. All GET results are point-in-time observations: unknown calls may
 * still complete later and Secret bindings are not thereby proven. No queue mutation,
 * journal replay/repair, provider write, permit release or arbitrary URL is exposed. */

/** Shared immutable review barrier; no observation or adjudication may invent it. */
export function unknownReviewBasis(db:SqlDatabase,account:string,r:ObservationRequest,isExecuting:()=>boolean):string {
  if(isExecuting()||r.permit.account!==account)conflict();
  const inbox=db.rows<{delivery:string}>('SELECT delivery FROM coordinator_inbox WHERE task=?',r.permit.task)[0];if(!inbox)conflict();
  const d=JSON.parse(inbox.delivery);for(const key of ['task','account','generation','snapshot','token','credentialRevision'] as const)if(d[key]!==r.permit[key])conflict();
  const job=db.rows<{snapshot:string;state:string;digest:string;cancel_requested:number}>('SELECT snapshot,state,digest,cancel_requested FROM account_jobs WHERE id=?',r.permit.task)[0];
  const step=db.rows<Record<string,Json>>('SELECT * FROM account_steps WHERE job=? AND ordinal=?',r.permit.task,r.step)[0];
  const call=db.rows<Record<string,Json>>('SELECT * FROM execution_calls WHERE job=? AND ordinal=?',r.permit.task+'_'+r.step,r.call)[0];
  if(!job||job.state!=='needs_review'||job.snapshot!==r.permit.snapshot||job.digest!==d.digest||!step||step.state!=='unknown'||typeof step.token!=='string'||!step.token||!call||call.mutation!==1||!['unknown','in_flight'].includes(String(call.state)))conflict();
  if(!Array.isArray(d.steps)||d.steps[r.step]!==step.kind)conflict();
  return canonical({delivery:d,job:{...job},step:{...step},call:{...call}});
 }
export class UnknownObservation {
 private readonly work=new Map<string,{intent:string;promise:Promise<Json>}>();
 private readonly options:Options;
 constructor(private readonly db:SqlDatabase,private readonly sealed:SealedStore,private readonly account:string,options:Options){
  accountId(account);if(typeof options.digestSecret!=='string'||encoder.encode(options.digestSecret).length<32)invalid();
  this.options={...options};const timeout=options.timeoutMs??15000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)invalid();
  db.rows('CREATE TABLE IF NOT EXISTS unknown_observations (id TEXT PRIMARY KEY,intent TEXT NOT NULL,basis TEXT NOT NULL,state TEXT NOT NULL,summary TEXT,error TEXT)');
 }
 private context(r:ObservationRequest,suffix=''):SealedContext{return {id:'observation_'+r.id+suffix,kind:'artifact',account:this.account,generation:r.permit.generation};}
 private row(id:string):Row|undefined{return this.db.rows<Row>('SELECT * FROM unknown_observations WHERE id=?',id)[0];}
 private basis(r:ObservationRequest):string {return unknownReviewBasis(this.db,this.account,r,this.options.isExecuting);}
 private async guard(r:ObservationRequest,basis:string):Promise<void>{if(this.basis(r)!==basis)conflict();await this.options.authorize(copied(r));if(this.basis(r)!==basis)conflict();}
 capture(raw:ObservationRequest):Promise<Json>{
  const r=parseObservationRequest(raw),intent=canonical(r),old=this.work.get(r.id);if(old){if(old.intent!==intent)return Promise.reject(new ReliabilityError('CONFLICT',409));return old.promise;}
  const promise=this.captureOnce(r,intent).finally(()=>this.work.delete(r.id));this.work.set(r.id,{intent,promise});return promise;
 }
 private async proof(value:unknown):Promise<string>{const key=await crypto.subtle.importKey('raw',encoder.encode(this.options.digestSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(canonical(['cfauto-observation-v1',value])))),b=>b.toString(16).padStart(2,'0')).join('');}
 private async read(url:string,headers:Headers):Promise<{status:number;bytes:Uint8Array;contentType:string}> {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ReliabilityError('NOT_READY',503));},this.options.timeoutMs??15000);});
  try{
   const pending=this.options.transport(url,{method:'GET',headers:new Headers(headers),redirect:'manual',signal:controller.signal});
   // A response arriving after timeout is never followed; release its unused body.
   void pending.then(response=>{if(controller.signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
   const response=await Promise.race([pending,timeout]);reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
   if(reader)for(;;){const next=await Promise.race([reader.read(),timeout]);if(next.done)break;size+=next.value.length;if(size>2*1024*1024)unavailable();chunks.push(next.value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return {status:response.status,bytes,contentType:response.headers.get('content-type')??''};
  }finally{if(timer!==undefined)clearTimeout(timer);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
 }
 private async captureOnce(r:ObservationRequest,intent:string):Promise<Json>{
  const old=this.row(r.id);if(old&&old.intent!==intent)conflict();const basis=this.basis(r);if(old&&old.basis!==basis)conflict();await this.guard(r,basis);
  if(old?.state==='complete'){if(old.summary===null)unavailable();const root=await this.sealed.get(this.context(r)) as {intent:string;basis:string;summary:Json};if(root.intent!==intent||root.basis!==basis||canonical(root.summary)!==old.summary)conflict();await this.guard(r,basis);return root.summary;}
  const journal=new ExecutionJournal(this.db,this.sealed,{job:r.permit.task+'_'+r.step,account:this.account,generation:r.permit.generation},{digestSecret:this.options.digestSecret,authorizeMutation:async()=>invalid(),transport:async()=>invalid()});
  const original=await journal.readCallEvidence(r.call),plan=targets(original,this.account);await this.guard(r,basis);
  if(old){
   // A sealed root followed by lost local ACK can be committed without any new GET.
   // A pre-root interrupted attempt is retained; a new explicitly signed read intent
   // is required rather than mixing later pages into an earlier observation.
   const root=await this.sealed.get(this.context(r)) as {intent:string;basis:string;summary:Json};
   if(root.intent!==intent||root.basis!==basis)conflict();await this.guard(r,basis);return this.complete(r,basis,root.summary);
  }
  this.db.transaction(()=>{if(this.basis(r)!==basis||this.row(r.id))conflict();this.db.rows("INSERT INTO unknown_observations VALUES (?,?,?,'pending',NULL,NULL)",r.id,intent,basis);});
  try{
   const reads:ReadSummary[]=[],refs:Json[]=[];let totalBytes=0;
   for(const target of plan.targets){
    let page=1,count=0,total:number|null=null;const ids=new Set<string>();
    for(;;){
     await this.guard(r,basis);const url=target.url+(target.collection?'?page='+page+'&per_page=100':'');
     const startedAt=Date.now(),response=await this.read(url,plan.headers),finishedAt=Date.now();totalBytes+=response.bytes.length;
     if(totalBytes>4*1024*1024)unavailable();
     const ref=this.context(r,'_'+reads.length);const packet={schema:1,intent,basis,callDigest:original.digest,url,status:response.status,contentType:response.contentType,body:b64(response.bytes),startedAt,finishedAt};
     // Preserve completed raw reads even if later authorization or another page fails.
     await this.sealed.put(ref,packet);refs.push({id:ref.id,proof:await this.proof(packet)});await this.guard(r,basis);
     let json:any=null;try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(response.bytes));}catch{/* Not all fixed GETs are JSON. Raw bytes remain sealed. */}
     let resourceState:ReadSummary['resourceState']='unconfirmed';
     if(target.kind==='worker'&&response.status===200&&response.bytes.length>0&&/^(application|text)\/(javascript|ecmascript)(;|$)/i.test(response.contentType))resourceState='present';
     if(target.kind==='worker'&&response.status===404&&json?.success===false&&Array.isArray(json.errors)&&json.errors.length>0&&json.errors.every((e:any)=>e?.code===10007))resourceState='absent';
     let completeInventory=false,next=false;
     if(target.collection&&response.status===200&&json?.success===true&&Array.isArray(json.result)){
      const info=json.result_info;let valid=info&&info.page===page&&info.per_page===100&&Number.isSafeInteger(info.total_count)&&info.total_count>=0&&Number.isSafeInteger(info.total_pages)&&info.total_pages>=1&&info.total_pages<=32&&info.total_pages===Math.max(1,Math.ceil(info.total_count/100))&&json.result.length<=100;
      if(total!==null&&info?.total_count!==total)valid=false;
      if(valid){total=info.total_count;for(const item of json.result){if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)){valid=false;break;}ids.add(item.id);}count+=json.result.length;valid=valid&&count<=total!&&(page===info.total_pages?count===total:json.result.length===100);}
      if(valid){completeInventory=page===info.total_pages;next=!completeInventory;}
     }
     reads.push({kind:target.kind,page,status:response.status,resourceState,completeInventory,bytes:response.bytes.length,startedAt,finishedAt});
     if(!next)break;page++;
    }
   }
   const core={id:r.id,operator:r.operator,task:r.permit.task,account:this.account,generation:r.permit.generation,epoch:r.epoch,accountsRevision:r.accountsRevision,step:r.step,call:r.call,state:'observed',possibleInFlight:true,settled:false,secretBindingsVerified:false,reads,refs};
   const summary={...core,evidence:await this.proof({intent,basis,...core})} as unknown as Json;
   await this.guard(r,basis);await this.sealed.put(this.context(r),{intent,basis,summary});await this.guard(r,basis);return this.complete(r,basis,summary);
  }catch(error){this.db.rows('UPDATE unknown_observations SET error=? WHERE id=?',error instanceof ReliabilityError?error.code:'NOT_READY',r.id);throw new ReliabilityError(error instanceof ReliabilityError?error.code:'NOT_READY',error instanceof ReliabilityError?error.status:503);}
 }
 private complete(r:ObservationRequest,basis:string,summary:Json):Json{return this.db.transaction(()=>{if(this.basis(r)!==basis)conflict();const row=this.row(r.id);if(!row||row.basis!==basis)conflict();this.db.rows("UPDATE unknown_observations SET state='complete',summary=?,error=NULL WHERE id=?",canonical(summary),r.id);return summary;});}
}
