import {accountExport} from './account-transfer';
import {TEMPLATES,readTemplateSettings} from '../config/templates';
import {normalizeVariables} from '../lib/validate';
import {normalizeUpstream} from '../lib/upstream';
import type {AccountEntry} from '../lib/types';
import {shape,templateType} from './business-command';
import {parseConfigSelector,splitAutomationConfig,type ConfigSelector} from './config-editor';
import {ConfigStore} from './config-store';
import {ConfigProjection} from './config-projection';
import {readCredentialAccounts} from './credential-accounts';
import type {KeyRing} from './credential-envelope';
import {canonical,ReliabilityError,type Json} from './protocol';
export type ViewSelector={kind:'init';templates:string[]}|{kind:'config';selector:ConfigSelector}|{kind:'journal'}|{kind:'projection'}|{kind:'accounts_export'}|{kind:'recovery'};
export const LEGACY_VIEW_PATHS=['/api/accounts/export','/api/init_data','/api/accounts','/api/settings','/api/auto_config','/api/deploy_config','/api/favorites','/api/upstream','/api/deploy_journal'] as const;
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
export function parseViewSelector(input:unknown):ViewSelector{
 if(!input||typeof input!=='object'||Array.isArray(input))return invalid();
 const v=input as Record<string,unknown>;
 if(v.kind==='init'){shape(v,'kind,templates');const templates=v.templates;if(!Array.isArray(templates)||templates.length>Object.keys(TEMPLATES).length||new Set(templates).size!==templates.length)return invalid();templates.forEach(templateType);return {kind:'init',templates:[...templates].sort()};}
 if(v.kind==='config'){shape(v,'kind,selector');return {kind:'config',selector:parseConfigSelector(v.selector)};}
 if(v.kind==='journal'||v.kind==='projection'||v.kind==='accounts_export'||v.kind==='recovery'){shape(v,'kind');return {kind:v.kind};}
 return invalid();
}
export function legacyViewSelector(request:Request):ViewSelector{
 const url=new URL(request.url);if(request.method!=='GET'||url.hash||!(LEGACY_VIEW_PATHS as readonly string[]).includes(url.pathname))invalid();
 const scalar:Record<string,string>={'/api/accounts':'accounts','/api/auto_config':'auto','/api/settings':'variables','/api/deploy_config':'deploy','/api/favorites':'favorites','/api/upstream':'upstream'};
 if(url.pathname==='/api/init_data'){if([...url.searchParams.keys()].some(k=>k!=='types')||url.searchParams.getAll('types').length>1)invalid();return parseViewSelector({kind:'init',templates:url.searchParams.has('types')?url.searchParams.get('types')!.split(','):Object.keys(TEMPLATES)});}
 if(url.pathname==='/api/accounts/export'){if(url.search)invalid();return {kind:'accounts_export'};}
 if(url.pathname==='/api/deploy_journal'){if(url.search)invalid();return {kind:'journal'};}
 const kind=scalar[url.pathname],hasTemplate=['variables','deploy','favorites','upstream'].includes(kind);
 if([...url.searchParams.keys()].some(k=>!hasTemplate||k!=='type')||url.searchParams.getAll('type').length>1)invalid();
 return {kind:'config',selector:parseConfigSelector({kind,...(hasTemplate?{template:url.searchParams.get('type')}: {})})};
}
const domain=(s:ConfigSelector):string=>'template' in s?({variables:'vars',favorites:'favorites',upstream:'upstream',deploy:'deploy',template:'template'} as Record<string,string>)[s.kind]+':'+s.template:s.kind==='accounts'?'accounts':s.kind==='auto'?'autoConfig':'vars:joey';
function journal(value:Json):Json{
 if(value===null)return [];if(!Array.isArray(value))return unavailable();
 return value.slice(0,100).map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row))return unavailable();
  // Legacy summaries can contain arbitrary provider data. Retain the original in
  // protected authority/backup, but never expose it as a supposedly sanitized log.
  const safe:Record<string,Json>={summary:'retained legacy entry'};
  if(typeof row.type==='string'&&Object.hasOwn(TEMPLATES,row.type))safe.type=row.type;
  for(const key of ['time'])if(typeof row[key]==='string'&&Number.isFinite(Date.parse(row[key] as string)))safe[key]=row[key];
  for(const key of ['sha','customSha'])if(row[key]===null||(typeof row[key]==='string'&&/^[a-f0-9]{7,64}$/.test(row[key] as string)))safe[key]=row[key];
  for(const key of ['accounts','total'])if(Number.isSafeInteger(row[key])&&(row[key] as number)>=0)safe[key]=row[key];
  if(typeof row.taskId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(row.taskId))safe.taskId=row.taskId;
  if(typeof row.summary==='string'&&/^(succeeded|failed|partial_failed|cancelled|partial_cancelled); scope=(full|partial); ledger=(advanced|superseded|source_changed|retained)$/.test(row.summary))safe.summary=row.summary;
  if(Array.isArray(row.failed)&&row.failed.every(v=>typeof v==='string'&&/^[a-f0-9]{32}::[a-z0-9][a-z0-9-]{0,62}$/.test(v)))safe.failed=row.failed.slice(0,100);
  return safe;
 });
}
/** A point-in-time, single-generation read. Returned CAS revisions describe this
 * exact snapshot, not a later reread. Maintenance permits reads but never writes.
 * No KV, automatic migration, HTTP mutation, source lookup, or credential fallback. */
export class AuthorityViews {
 private readonly ring:KeyRing;
 constructor(private readonly config:ConfigStore,ring:KeyRing,private readonly projection:ConfigProjection){this.ring={...ring,keys:{...ring.keys}};}
 private async value(selector:ConfigSelector,value:Json):Promise<Json>{
  if(selector.kind==='accounts'){const entries=await readCredentialAccounts((value??[]) as unknown as AccountEntry[],this.ring);return entries.map(a=>({...a,globalKey:a.globalKey?'***':'',apiToken:a.apiToken?'***':''})) as unknown as Json;}
  if(selector.kind==='template'){const settings=readTemplateSettings(selector.template,value);if(!settings)return unavailable();return settings as unknown as Json;}
  if(selector.kind==='auto'){const split=splitAutomationConfig(value??{});if(Object.keys(split.runtime).length)unavailable();return split.config;}
  if(selector.kind==='variables'||selector.kind==='joey_nodes'){if(value===null)return null;const result=normalizeVariables(value);if(!result.ok)return unavailable();return result.value as unknown as Json;}
  if(selector.kind==='upstream'){const selected=normalizeUpstream(value??{path:'',branch:''}),t=TEMPLATES[selector.template];return {...selected,repository:t.ghUser+'/'+t.ghRepo,defaultPath:t.ghPath,defaultBranch:t.ghBranch};}
  if(selector.kind==='favorites'){if(value===null)return [];if(!Array.isArray(value))return unavailable();return value.map(row=>{if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.sha!=='string'||!/^[a-f0-9]{7,40}$/i.test(row.sha))return unavailable();const safe:Record<string,Json>={sha:row.sha};for(const k of ['alias','type','name','date','message'])if(typeof row[k]==='string')safe[k]=row[k];return safe;});}
  if(value===null)return {mode:'latest',currentSha:null,deployTime:null};
  if(typeof value!=='object'||Array.isArray(value)||!['latest','fixed'].includes(value.mode as string))return unavailable();
  const safe:Record<string,Json>={mode:value.mode};
  for(const key of ['lastTaskId','sourceIdentity','currentSha','deployTime','commitDate','pendingTargets','pendingSha','lastAttempt','currentCustomSha','currentDigest','pendingCustomSha','pendingDigest','pendingSourceIdentity'])if(Object.hasOwn(value,key)){
   const item=value[key];
   if(key==='pendingTargets'){if(!Array.isArray(item)||item.length>10000||item.some(v=>typeof v!=='string'||!/^[a-f0-9]{32}::[a-z0-9][a-z0-9-]{0,62}$/.test(v)))return unavailable();}
   else if(item!==null){
    if(typeof item!=='string')return unavailable();
    if(key==='lastTaskId'){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(item))return unavailable();}
    else if(key==='sourceIdentity'||key==='pendingSourceIdentity'){if(item){try{const selected=normalizeUpstream(JSON.parse(item));if(!selected.path||JSON.stringify(selected)!==item)return unavailable();}catch{return unavailable();}}}
    else if(['deployTime','commitDate','lastAttempt'].includes(key)){if(item.length>40||!Number.isFinite(Date.parse(item)))return unavailable();}
    else if(!/^[a-f0-9]{7,64}$/.test(item))return unavailable();
   }
   safe[key]=item;
  }
  return safe;
 }
 async read(input:unknown):Promise<Json>{
  const selector=parseViewSelector(input);
  if(selector.kind==='recovery'){const meta=this.config.status();return {generation:meta.generation,epoch:meta.epoch,maintenance:!!meta.maintenance,protocol:1,backupClient:'archive-bundle-client.cjs',uploadClient:'archive-bundle-upload.cjs',maintenanceClient:'maintenance-client.cjs',activationPerformed:false,migrationReady:false,maintenanceIsDrainProof:false,browserMutationAllowed:false};}
  const domains=selector.kind==='init'?['accounts','autoConfig',...selector.templates.flatMap(t=>['vars:'+t,'deploy:'+t,'template:'+t])]:selector.kind==='config'?[domain(selector.selector)]:selector.kind==='journal'?['deployJournal']:selector.kind==='accounts_export'?['accounts']:[];
  const view=this.config.read(domains),runtime=this.config.readRuntime(),meta=this.config.status(),revisions=Object.fromEntries(view.records.map(r=>[r.domain,r.revision]));
  const record=(name:string)=>view.records.find(r=>r.domain===name)!.value;
  let data:Json;
  if(selector.kind==='init'){
   const vars:Record<string,Json>={},deployConfigs:Record<string,Json>={},templateSettings:Record<string,Json>={};for(const t of selector.templates){vars[t]=await this.value({kind:'variables',template:t},record('vars:'+t));deployConfigs[t]=await this.value({kind:'deploy',template:t},record('deploy:'+t));templateSettings[t]=await this.value({kind:'template',template:t},record('template:'+t));}
   data={accounts:await this.value({kind:'accounts'},record('accounts')),autoConfig:await this.value({kind:'auto'},record('autoConfig')),runtime:runtime as unknown as Json,vars,deployConfigs,templateSettings};
  }else if(selector.kind==='config'){data=await this.value(selector.selector,record(domain(selector.selector)));if(data===null&&(selector.selector.kind==='variables'||selector.selector.kind==='joey_nodes'))data=[];if(selector.selector.kind==='auto')data={...(data as Record<string,Json>),...runtime.value as Record<string,Json>};}
  else if(selector.kind==='accounts_export'){
   data=await accountExport(view,this.ring);
   const current=this.config.read(['accounts']);
   if(current.generation!==view.generation||current.epoch!==view.epoch||current.records[0].revision!==view.records[0].revision)throw new ReliabilityError('CONFLICT',409);
  }
  else if(selector.kind==='journal')data=journal(record('deployJournal'));
  else data=this.projection.status();
  return JSON.parse(canonical({data,generation:view.generation,epoch:view.epoch,revisions,maintenance:!!meta.maintenance}));
 }
}
