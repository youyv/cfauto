import {packetDescriptor} from './archive-packet-transport';
import {accountId,shape,workerName} from './business-command';
import {canonical,identifier,revision,ReliabilityError,type Json} from './protocol';
export const MAINTENANCE_ORIGIN='https://maintenance.internal';
export const MAINTENANCE_PATH='/v1';
export const MAX_MAINTENANCE_BYTES=8192;
export const ARCHIVE_MAINTENANCE_ACTIONS=['archive_create','archive_inventory','archive_export_begin','archive_export_frame','archive_import_begin','archive_import_frame','archive_import_commit','archive_finish','archive_transfer_status'] as const;
export const INITIAL_MAINTENANCE_ACTIONS=['initial_identity','initial_source_begin','initial_source_frame','initial_source_commit','initial_source_inspect','initial_import_begin','initial_import_resume','initial_import_inspect','initial_activate','initial_activation_inspect'] as const;
export const GENERATION_MAINTENANCE_ACTIONS=['generation_begin','generation_resume','generation_inspect','generation_activate','generation_activation_inspect'] as const;
export type MaintenancePermission='inspect'|'maintain'|'drain'|'review'|'attest'|'adjudicate'|'recover'|'archive'|'migrate'|'activate';
export interface MaintenanceTarget {account:string;worker:string;namespace:string}
export interface MaintenanceConfig {operators:Record<string,{secret:string;permissions:MaintenancePermission[]}>}
export interface MaintenanceCommand {id:string;action:'audit_list'|'review_candidates'|'review_attest'|'review_close_failed'|'account_archive'|'archive_accounts'|typeof INITIAL_MAINTENANCE_ACTIONS[number]|typeof GENERATION_MAINTENANCE_ACTIONS[number]|typeof ARCHIVE_MAINTENANCE_ACTIONS[number]|'admission_list'|'admission_recover'|'review_observe'|'status'|'audit'|'set_maintenance'|'drain_begin'|'drain_advance'|'drain_inspect'|'drain_release';expected:{generation:string|null;epoch:number;maintenance:number}|null;args:Json}
export interface MaintenanceMessage {version:1;target:MaintenanceTarget;operator:string;at:number;nonce:string;command:MaintenanceCommand}
export interface SignedMaintenance extends MaintenanceMessage {signature:string}
const denied=():never=>{throw new ReliabilityError('INVALID',403);};
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
const encoder=new TextEncoder();
function target(raw:unknown):asserts raw is MaintenanceTarget {shape(raw,'account,namespace,worker');accountId(raw.account);accountId(raw.namespace);workerName(raw.worker);}
/** Optional while the production shell remains disabled. When present, every
 * operator has a separately provisioned key. No ACCESS_CODE/session/RPC fallback. */
export function maintenanceConfig(raw:unknown,forbidden:readonly string[]):MaintenanceConfig|undefined {
 if(raw===undefined)return undefined;
 try {if(typeof raw!=='string'||encoder.encode(raw).length>16384)unavailable();const value=JSON.parse(raw as string);shape(value,'operators');if(canonical(value)!==raw||!value.operators||Object.getPrototypeOf(value.operators)!==Object.prototype)unavailable();const entries=Object.entries(value.operators);if(!entries.length||entries.length>16)unavailable();const keys=new Set(forbidden);
  for(const [id,item] of entries){identifier(id);if(['__proto__','constructor','prototype'].includes(id))unavailable();shape(item,'permissions,secret');if(typeof item.secret!=='string'||!/^[a-f0-9]{64}$/.test(item.secret)||keys.has(item.secret))unavailable();keys.add(item.secret);if(!Array.isArray(item.permissions)||!item.permissions.length||new Set(item.permissions).size!==item.permissions.length||item.permissions.some(p=>!['inspect','maintain','drain','review','attest','adjudicate','recover','archive','migrate','activate'].includes(p)))unavailable();Object.freeze(item.permissions);Object.freeze(item);}
  Object.freeze(value.operators);return Object.freeze(value) as MaintenanceConfig;
 }catch{return unavailable();}
}
export function maintenanceCommand(raw:unknown):MaintenanceCommand {
 // Freeze before any crypto/transport await; no caller-owned references survive.
 const text=canonical(raw);if(encoder.encode(text).length>MAX_MAINTENANCE_BYTES)denied();const value=JSON.parse(text);shape(value,'action,args,expected,id');identifier(value.id);
 if(value.action==='account_archive'){shape(value.args,'account,action,args');accountId(value.args.account);if(!(ARCHIVE_MAINTENANCE_ACTIONS as readonly string[]).includes(value.args.action))denied();maintenanceCommand({id:value.id,action:value.args.action,expected:value.expected,args:value.args.args});return value as MaintenanceCommand;}
 if(!['audit_list','review_candidates','review_attest','review_close_failed','archive_accounts',...INITIAL_MAINTENANCE_ACTIONS,...GENERATION_MAINTENANCE_ACTIONS,...ARCHIVE_MAINTENANCE_ACTIONS,'admission_list','admission_recover','review_observe','status','audit','set_maintenance','drain_begin','drain_advance','drain_inspect','drain_release'].includes(value.action))denied();
 if((INITIAL_MAINTENANCE_ACTIONS as readonly string[]).includes(value.action)){
  const read=['initial_identity','initial_source_inspect','initial_import_inspect','initial_activation_inspect'].includes(value.action);
  if(read){if(value.expected!==null)denied();}else{shape(value.expected,'epoch,generation,maintenance');revision(value.expected.epoch);if(value.expected.generation!==null||value.expected.maintenance!==1)denied();}
  if(['initial_identity','initial_import_begin','initial_import_inspect','initial_activate'].includes(value.action))shape(value.args,'');
  else if(value.action==='initial_import_resume'){shape(value.args,'limit');revision(value.args.limit);if(value.args.limit<1||value.args.limit>100)denied();}
  else{shape(value.args,value.action==='initial_source_frame'?'id,ordinal,data':'id');identifier(value.args.id);if(value.action==='initial_source_frame'){revision(value.args.ordinal);if(value.args.ordinal>=2731||typeof value.args.data!=='string'||!value.args.data.length||value.args.data.length>4096||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.args.data))denied();}}
  return value as MaintenanceCommand;
 }
 if(['audit_list','review_candidates','status','audit','drain_inspect','admission_list','archive_inventory','archive_export_begin','archive_export_frame','archive_transfer_status','generation_inspect','generation_activation_inspect','archive_accounts'].includes(value.action)){if(value.expected!==null)denied();}else{shape(value.expected,'epoch,generation,maintenance');if(value.expected.generation!==null)identifier(value.expected.generation);revision(value.expected.epoch);if(![0,1].includes(value.expected.maintenance))denied();}
 if(value.action==='audit_list'){shape(value.args,'limit,cursor');revision(value.args.limit);if(value.args.limit<1||value.args.limit>50||(value.args.cursor!==null&&(typeof value.args.cursor!=='string'||!/^a1\.[1-9][0-9]{0,15}\.[1-9][0-9]{0,15}\.[a-f0-9]{64}$/.test(value.args.cursor))))denied();return value as MaintenanceCommand;}
 if(value.action==='review_candidates'){shape(value.args,'task,account,after,limit');identifier(value.args.task);accountId(value.args.account);revision(value.args.limit);if(value.args.limit<1||value.args.limit>50)denied();if(value.args.after!==null){revision(value.args.after);if(value.args.after>=50000)denied();}return value as MaintenanceCommand;}
 if(['review_attest','review_close_failed'].includes(value.action)){if(value.expected?.maintenance!==1)denied();const a=value.args;shape(a,value.action==='review_attest'?'account,task,step,call,observation,evidence,statement,reference,document':'account,task,step,call,attestation,proof');accountId(a.account);identifier(a.task);revision(a.step);revision(a.call);if(a.step>=100||a.call>=500||value.id.length>60)denied();if(value.action==='review_attest'){identifier(a.observation);if(typeof a.evidence!=='string'||! /^[a-f0-9]{64}$/.test(a.evidence)||a.statement!=='provider_confirmed_terminal'||typeof a.reference!=='string'||a.reference.length<1||a.reference.length>200||typeof a.document!=='string'||encoder.encode(a.document).length<32||encoder.encode(a.document).length>4096)denied();}else{identifier(a.attestation);if(typeof a.proof!=='string'||! /^[a-f0-9]{64}$/.test(a.proof))denied();}return value as MaintenanceCommand;}
 if(value.action==='archive_accounts'){shape(value.args,'after,limit,digest');revision(value.args.limit);if(value.args.limit<1||value.args.limit>50)denied();if(value.args.after!==null){accountId(value.args.after);if(typeof value.args.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.args.digest))denied();}else if(value.args.digest!==null)denied();}
 else if(GENERATION_MAINTENANCE_ACTIONS.includes(value.action)){
  if(['generation_begin','generation_resume','generation_activate'].includes(value.action)&&value.expected?.maintenance!==1)denied();
  if(value.action==='generation_begin'){shape(value.args,'id,target,source,credentials');for(const key of ['id','target','source'])identifier(value.args[key]);if(value.args.id.length>60||!['strict_v2','migrate'].includes(value.args.credentials))denied();}
  else if(value.action==='generation_resume'){shape(value.args,'id,limit');identifier(value.args.id);revision(value.args.limit);if(value.args.limit<1||value.args.limit>100)denied();}
  else if(value.action==='generation_activate'){shape(value.args,'importId,drainId');identifier(value.args.importId);identifier(value.args.drainId);}
  else{shape(value.args,'id');identifier(value.args.id);}
 }
 else if(ARCHIVE_MAINTENANCE_ACTIONS.includes(value.action)){
  if(['archive_create','archive_import_begin','archive_import_frame','archive_import_commit','archive_finish'].includes(value.action)&&value.expected?.maintenance!==1)denied();
  if(value.action==='archive_import_begin'){shape(value.args,'descriptor');packetDescriptor(value.args.descriptor);}
  else if(value.action==='archive_export_begin'){shape(value.args,'id,archive,part');identifier(value.args.id);identifier(value.args.archive);if(value.args.id.length>60||value.args.archive.length>60)denied();if(value.args.part!==null){revision(value.args.part);if(value.args.part>=512)denied();}}
  else if(value.action==='archive_export_frame'||value.action==='archive_import_frame'){shape(value.args,value.action==='archive_export_frame'?'id,ordinal':'id,ordinal,data');identifier(value.args.id);revision(value.args.ordinal);if(value.args.ordinal>=2731)denied();if(value.action==='archive_import_frame'&&(typeof value.args.data!=='string'||value.args.data.length<1||value.args.data.length>4096||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.args.data)))denied();}
  else{shape(value.args,'id');identifier(value.args.id);if(value.args.id.length>60)denied();}
 }
 else if(value.action==='admission_list'){shape(value.args,'limit,cursor');revision(value.args.limit);if(value.args.limit<1||value.args.limit>50||(value.args.cursor!==null&&(typeof value.args.cursor!=='string'||value.args.cursor.length>100)))denied();}
 else if(value.action==='admission_recover'){shape(value.args,'id');identifier(value.args.id);}
 else if(value.action==='review_observe'){shape(value.args,'task,account,step,call');identifier(value.args.task);accountId(value.args.account);revision(value.args.step);revision(value.args.call);if(value.args.step>=100||value.args.call>=500||value.id.length>60)denied();}
 else if(value.action==='status')shape(value.args,'');
 else if(value.action==='set_maintenance'){shape(value.args,'enabled');if(typeof value.args.enabled!=='boolean')denied();}
 else {shape(value.args,value.action==='drain_advance'?'id,limit':'id');identifier(value.args.id);if(value.action==='drain_advance'){revision(value.args.limit);if(value.args.limit<1||value.args.limit>100)denied();}}
 return value as MaintenanceCommand;
}
function permission(action:MaintenanceCommand['action']):MaintenancePermission{if((INITIAL_MAINTENANCE_ACTIONS as readonly string[]).includes(action))return action==='initial_activate'?'activate':['initial_identity','initial_source_inspect','initial_import_inspect','initial_activation_inspect'].includes(action)?'inspect':'migrate';return ['audit_list','review_candidates'].includes(action)?'inspect':action==='review_attest'?'attest':action==='review_close_failed'?'adjudicate':['account_archive','archive_accounts'].includes(action)?'archive':action==='generation_activate'?'activate':['generation_begin','generation_resume'].includes(action)?'migrate':['generation_inspect','generation_activation_inspect'].includes(action)?'inspect':(ARCHIVE_MAINTENANCE_ACTIONS as readonly string[]).includes(action)?'archive':action==='admission_recover'?'recover':action==='admission_list'?'inspect':action==='review_observe'?'review':['status','audit','drain_inspect'].includes(action)?'inspect':action==='set_maintenance'?'maintain':'drain';}
function message(raw:unknown):MaintenanceMessage {shape(raw,'at,command,nonce,operator,target,version');if(raw.version!==1)denied();target(raw.target);identifier(raw.operator);identifier(raw.nonce);revision(raw.at);return {...raw,command:maintenanceCommand(raw.command)} as MaintenanceMessage;}
async function key(secret:string):Promise<CryptoKey>{if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))denied();return crypto.subtle.importKey('raw',Uint8Array.from(secret.match(/../g)!,b=>parseInt(b,16)),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
const content=(value:MaintenanceMessage)=>encoder.encode('cfauto:maintenance:v1\n'+canonical(value));
/** Used by the local maintenance client; signatures bind exact target + operator +
 * intent + precondition. Stable command IDs, fresh timestamp/nonce on manual retry. */
export async function signMaintenance(input:MaintenanceMessage,secret:string):Promise<SignedMaintenance>{const value=message(JSON.parse(canonical(input))),signature=await crypto.subtle.sign('HMAC',await key(secret),content(value));return {...value,signature:Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('')};}
export class MaintenanceAuthentication {
 private readonly target:MaintenanceTarget;
 constructor(private readonly config:MaintenanceConfig,expected:MaintenanceTarget,private readonly now:()=>number=Date.now){target(expected);this.target=JSON.parse(canonical(expected));}
 async verify(raw:unknown):Promise<MaintenanceMessage>{try{const text=canonical(raw);if(encoder.encode(text).length>MAX_MAINTENANCE_BYTES)denied();const frozen=JSON.parse(text);shape(frozen,'at,command,nonce,operator,signature,target,version');const {signature,...rest}=frozen,value=message(rest);if(canonical(value.target)!==canonical(this.target)||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!Object.hasOwn(this.config.operators,value.operator))denied();const operator=this.config.operators[value.operator];if(!operator.permissions.includes(permission(value.command.action)))denied();if(!await crypto.subtle.verify('HMAC',await key(operator.secret),Uint8Array.from(signature.match(/../g)!,b=>parseInt(String(b),16)),content(value)))denied();if(Math.abs(this.now()-value.at)>60000)denied();return value;}catch{return denied();}}
}
/** Internal binding endpoint only. Public gateway must forward original bytes;
 * ordinary login authentication must never mint maintenance signatures. */
export async function readMaintenanceRequest(request:Request):Promise<unknown>{const url=new URL(request.url);if(request.method!=='POST'||url.origin!==MAINTENANCE_ORIGIN||url.pathname!==MAINTENANCE_PATH||url.search||url.hash||request.headers.get('content-type')!=='application/json'||!request.body)denied();const reader=request.body!.getReader();let size=0;const chunks:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_MAINTENANCE_BYTES){await reader.cancel();denied();}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{return denied();}finally{reader.releaseLock();}}

export function archiveAction(command:MaintenanceCommand):string{return command.action==='account_archive'?(command.args as {action:string}).action:command.action;}
