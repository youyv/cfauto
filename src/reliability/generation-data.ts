import {TEMPLATES,KV_KEYS} from '../config/templates';
import {normalizeVariables,validateAccountsPayload} from '../lib/validate';
import {normalizeUpstream} from '../lib/upstream';
import type {AccountEntry} from '../lib/types';
import {accountId,workerName,templateType} from './business-command';
import {splitAutomationConfig} from './config-editor';
import {migrateCredentialAccounts,readCredentialAccounts} from './credential-accounts';
import type {KeyRing} from './credential-envelope';
import {customSourceCode,type CustomSourceArtifact} from './source-artifact';
import {canonical,encoded,identifier,revision,ReliabilityError,sha256,type Json,type ConfigRecord} from './protocol';
export interface GenerationData {schema:1;records:ConfigRecord[];runtime:{revision:number;value:{lastCheck?:number;lastGc?:number}};credentialPolicy:{observationUntil:number;revocations:Array<{account:string;revision:number}>}}
export interface GenerationSource {artifact:CustomSourceArtifact;provenance:{generation:string;snapshot:string;account:string;keyId:string;task:string}}
export interface PreparedGeneration extends GenerationData {customSources:GenerationSource[];normalizations:Array<{domain:string;rule:string}>}
export interface GenerationOptions {credentials:'strict_v2'|'migrate';unprefixed?:'plaintext'|'encrypted';resolveCustom?:(template:string,digest:string)=>Promise<GenerationSource>}
export const BASE_GENERATION_DOMAINS=['accounts','autoConfig','deployJournal',...Object.keys(TEMPLATES).flatMap(t=>['vars:'+t,'deploy:'+t,'favorites:'+t,'upstream:'+t])].sort();
function fail():never{throw new ReliabilityError('INVALID',400);}
function missing():never{throw new ReliabilityError('NOT_READY',503);}
function shape(value:unknown,required:string[],optional:string[]=[]):asserts value is Record<string,any>{if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))fail();}
function text(value:unknown,max=8192):asserts value is string {if(typeof value!=='string'||new TextEncoder().encode(value).length>max)fail();}
function digest(value:unknown,optional=false):void {if(optional&&value===null)return;if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))fail();}
function sha(value:unknown):void {if(value!==null&&(typeof value!=='string'||! /^[a-f0-9]{7,40}$/.test(value)))fail();}
function date(value:unknown):void {if(value!==null&&(typeof value!=='string'||value.length>40||!Number.isFinite(Date.parse(value))))fail();}
function variables(value:unknown):Json {
 if(!Array.isArray(value))fail();for(const item of value){shape(item,['key','value'],['secret','type']);text(item.key,64);text(item.value);if(item.secret!==undefined&&typeof item.secret!=='boolean')fail();if(item.type!==undefined&&(item.type!=='plain_text'||item.secret===true))fail();}
 const normalized=normalizeVariables(value);if(!normalized.ok||normalized.value.length!==value.length)fail();return normalized.value as unknown as Json;
}
function upstream(value:unknown):Json {shape(value,['path','branch']);try{return normalizeUpstream(value) as unknown as Json;}catch{return fail();}}
function sourceIdentity(value:unknown):void {text(value,2048);if(!value)return;try{if(JSON.stringify(normalizeUpstream(JSON.parse(value)))!==value)fail();}catch{fail();}}
function target(value:unknown):{account:string;worker:string}{if(typeof value!=='string')fail();const pieces=(value as string).split('::');if(pieces.length!==2)fail();accountId(pieces[0]);workerName(pieces[1]);return {account:pieces[0],worker:pieces[1]};}
function targets(value:unknown):string[]{if(!Array.isArray(value)||value.length>10000||new Set(value).size!==value.length)fail();value.forEach(target);return value;}
function favorites(value:unknown):Json {if(!Array.isArray(value)||value.length>200)fail();const seen=new Set<string>();for(const item of value){shape(item,['sha'],['alias','type','name','date','message']);sha(item.sha);if(item.sha===null||seen.has(item.sha))fail();seen.add(item.sha);for(const entry of Object.values(item))text(entry);}return value;}
function journal(value:unknown):Json {if(!Array.isArray(value)||value.length>1000)fail();for(const row of value){shape(row,['time','type','sha','accounts','total','summary'],['taskId','customSha','failed']);date(row.time);if(row.time===null)fail();templateType(row.type);sha(row.sha);revision(row.accounts);revision(row.total);text(row.summary,32768);if(row.taskId!==undefined)identifier(row.taskId);if(row.customSha!==undefined)digest(row.customSha);if(row.failed!==undefined)targets(row.failed);}return value;}
function deploy(value:unknown,legacy:boolean):{value:Json;unknownSha:boolean}{
 shape(value,['mode'],['currentSha','deployTime','commitDate','pendingTargets','pendingSha','lastAttempt','sourceIdentity','lastTaskId','currentCustomSha','currentDigest','pendingCustomSha','pendingDigest','pendingSourceIdentity']);
 if(!['latest','fixed'].includes(value.mode))fail();let unknownSha=false;
 for(const key of ['currentSha','pendingSha'])if(Object.hasOwn(value,key)){if(legacy&&value[key]==='unknown'){value[key]=null;unknownSha=true;}else sha(value[key]);}
 for(const key of ['deployTime','commitDate','lastAttempt'])if(Object.hasOwn(value,key))date(value[key]);
 for(const key of ['sourceIdentity','pendingSourceIdentity'])if(Object.hasOwn(value,key)&&value[key]!==null)sourceIdentity(value[key]);
 for(const key of ['currentCustomSha','currentDigest','pendingCustomSha','pendingDigest'])if(Object.hasOwn(value,key))digest(value[key],true);
 if(value.lastTaskId!==undefined)identifier(value.lastTaskId);if(value.pendingTargets!==undefined)targets(value.pendingTargets);
 if(value.currentCustomSha!==undefined&&value.currentCustomSha!==null){if(value.mode!=='fixed'||value.currentSha!==null||value.currentDigest!==value.currentCustomSha||value.sourceIdentity)fail();}
 else if(value.currentDigest&&!value.currentSha)fail();
 if(value.mode==='fixed'&&!value.currentSha&&!value.currentCustomSha)missing();
 if(value.pendingCustomSha){if(value.pendingSha!==null||value.pendingDigest!==value.pendingCustomSha||value.pendingSourceIdentity)fail();}
 else if(value.pendingDigest&&!value.pendingSha)fail();
 return {value:value as Json,unknownSha};
}
/** Entire input must be a complete frozen business-domain manifest, never an
 * arbitrary patch. This validates data only; it is NOT a drain/cutover authorization. */
export async function prepareGenerationData(raw:unknown,ring:KeyRing,options:GenerationOptions):Promise<PreparedGeneration>{
 const serialized=canonical(raw);if(new TextEncoder().encode(serialized).length>4*1024*1024)fail();
 const input=JSON.parse(serialized) as GenerationData;shape(input,['schema','records','runtime','credentialPolicy']);
 if(input.schema!==1||!Array.isArray(input.records)||input.records.length>10000||!['strict_v2','migrate'].includes(options.credentials)||(options.unprefixed!==undefined&&!['plaintext','encrypted'].includes(options.unprefixed))||(options.credentials==='strict_v2'&&options.unprefixed!==undefined))fail();
 ring={...ring,keys:{...ring.keys}};options={...options};
 const records=new Map<string,ConfigRecord>();for(const record of input.records){shape(record,['domain','revision','value']);text(record.domain,160);revision(record.revision);if(!record.revision||records.has(record.domain))fail();encoded(record.value);records.set(record.domain,record);}
 if(BASE_GENERATION_DOMAINS.some(d=>!records.has(d)))fail();
 const incoming=records.get('accounts')!.value as unknown as AccountEntry[];if(!validateAccountsPayload(incoming).ok)fail();
 for(const a of incoming){accountId(a.accountId);for(const [key,value] of Object.entries(a))if(key.startsWith('workers_')){templateType(key.slice(8));if(value!==undefined){if(!Array.isArray(value)||new Set(value).size!==value.length)fail();value.forEach(workerName);}}}
 const encrypted=options.credentials==='migrate'?await migrateCredentialAccounts(incoming,ring,options.unprefixed):incoming;
 const plain=await readCredentialAccounts(encrypted,ring);for(const a of plain)if(a.authMode==='token'?!a.apiToken:a.authMode==='key'?!a.globalKey||!a.email.trim():!a.apiToken&&(!a.globalKey||!a.email.trim()))fail();
 records.get('accounts')!.value=encrypted as unknown as Json;
 shape(input.runtime,['revision','value']);revision(input.runtime.revision);shape(input.runtime.value,[],['lastCheck','lastGc']);Object.values(input.runtime.value).forEach(revision);if(!input.runtime.revision&&Object.keys(input.runtime.value).length)fail();
 shape(input.credentialPolicy,['observationUntil','revocations']);revision(input.credentialPolicy.observationUntil);if(!Array.isArray(input.credentialPolicy.revocations)||input.credentialPolicy.revocations.length>10000)fail();
 const revoked=new Set<string>();for(const r of input.credentialPolicy.revocations){shape(r,['account','revision']);accountId(r.account);revision(r.revision);if(!r.revision||revoked.has(r.account+':'+r.revision))fail();revoked.add(r.account+':'+r.revision);const a=encrypted.find(a=>a.accountId===r.account);if(a&&r.revision>a.credentialRevision!)fail();}
 const normalizations:PreparedGeneration['normalizations']=[],customSources:GenerationSource[]=[];
 for(const record of records.values()){
  const {domain,value}=record;if(domain==='accounts')continue;
  if(domain==='autoConfig'){
   if(value===null)continue;let automation=value;
   if(options.credentials==='migrate'&&automation&&typeof automation==='object'&&!Array.isArray(automation)){automation={...automation};for(const field of ['interval','fuseThreshold'])if(typeof automation[field]==='string'){if(!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(automation[field] as string))fail();automation[field]=Number(automation[field]);}}
   if(automation&&typeof automation==='object'&&!Array.isArray(automation))for(const field of ['interval','fuseThreshold'])if(Object.hasOwn(automation,field)&&!Number.isSafeInteger(automation[field]))fail();
   const split=splitAutomationConfig(automation);if(options.credentials==='strict_v2'&&Object.keys(split.runtime).length)fail();
   for(const [key,stamp] of Object.entries(split.runtime)){const name=key as 'lastCheck'|'lastGc';input.runtime.value[name]=Math.max(input.runtime.value[name]??0,stamp!);}
   if(Object.keys(split.runtime).length&&!input.runtime.revision)input.runtime.revision=1;
   record.value=split.config;if(canonical(value)!==canonical(record.value))normalizations.push({domain,rule:'automation_runtime_split_and_defaults'});continue;
  }
  if(domain==='deployJournal'){if(value!==null)record.value=journal(value);continue;}
  const parts=domain.split(':');if(!['vars','favorites','upstream','deploy','override'].includes(parts[0])||parts.length!==(parts[0]==='override'?3:2))fail();templateType(parts[1]);
  if(parts[0]==='override'){accountId(parts[2]);if(value!==null&&!encrypted.some(a=>a.accountId===parts[2]))fail();}
  if(value===null)continue;
  if(parts[0]==='vars'||parts[0]==='override'){record.value=variables(value);if(canonical(record.value)!==canonical(value))normalizations.push({domain,rule:'legacy_variable_metadata_normalized'});}
  else if(parts[0]==='favorites')record.value=favorites(value);
  else if(parts[0]==='upstream')record.value=upstream(value);
  else {
   const validated=deploy(value,options.credentials==='migrate');record.value=validated.value;if(validated.unknownSha)normalizations.push({domain,rule:'legacy_unknown_sha_to_null'});
   const data=record.value as Record<string,Json>;
   for(const item of (data.pendingTargets??[]) as string[]){const t=target(item),a=encrypted.find(a=>a.accountId===t.account);if(!a||(a[`workers_${parts[1]}`]??[]).includes(t.worker)===false)fail();}
   for(const customDigest of new Set([data.currentCustomSha,data.pendingCustomSha].filter((v):v is string=>typeof v==='string'))){
    if(!options.resolveCustom)missing();const source=JSON.parse(canonical(await options.resolveCustom!(parts[1],customDigest))) as GenerationSource;
    shape(source,['artifact','provenance']);shape(source.artifact,['kind','template','code','digest']);shape(source.provenance,['generation','snapshot','account','keyId','task']);
    if(source.artifact.kind!=='custom'||source.artifact.template!==parts[1]||source.artifact.digest!==customDigest)fail();customSourceCode(source.artifact.code);if(await sha256(source.artifact.code)!==source.artifact.digest)fail();for(const item of Object.values(source.provenance))identifier(item);accountId(source.provenance.account);customSources.push(source);
   }
  }
 }
 for(const r of records.values())encoded(r.value);
 return {schema:1,records:[...records.values()].sort((a,b)=>a.domain<b.domain?-1:1),runtime:input.runtime,credentialPolicy:input.credentialPolicy,customSources,normalizations};
}
/** Complete-source adapters call this only after enumerating every source key/domain.
 * Missing base domains become explicit null records, not a stale-KV fallback. */
export function completeGenerationDomains(records:ConfigRecord[]):ConfigRecord[]{const result=JSON.parse(canonical(records)) as ConfigRecord[];const names=new Set(result.map(r=>r.domain));for(const domain of BASE_GENERATION_DOMAINS)if(!names.has(domain))result.push({domain,revision:1,value:domain==='accounts'?[]:null});return result;}
/** Legacy key mapping only; sessions, limits and unknown keys are not configuration. */
export function legacyBusinessDomain(key:string):string|null {
 if(key===KV_KEYS.ACCOUNTS)return 'accounts';if(key===KV_KEYS.GLOBAL_CONFIG)return 'autoConfig';if(key===KV_KEYS.DEPLOY_JOURNAL)return 'deployJournal';
 for(const type of Object.keys(TEMPLATES)){for(const [domain,name] of [['vars',KV_KEYS.vars(type)],['deploy',KV_KEYS.deployConfig(type)],['favorites',KV_KEYS.favorites(type)],['upstream',KV_KEYS.upstream(type)]])if(key===name)return domain+':'+type;const prefix=KV_KEYS.accountVars(type,'');if(key.startsWith(prefix)){const id=key.slice(prefix.length);accountId(id);return 'override:'+type+':'+id;}}
 return null;
}
