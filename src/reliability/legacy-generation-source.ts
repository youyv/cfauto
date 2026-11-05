import {completeGenerationDomains,legacyBusinessDomain,type GenerationData,type GenerationSource} from './generation-data';
import type {LoadedGenerationSource} from './generation-import';
import {accountId,workerName} from './business-command';
import {canonical,encoded,identifier,revision,ReliabilityError,type Json,type ConfigRecord} from './protocol';
export interface LegacyBackupTarget {account:string;worker:string;namespace:string;deployment:string;version:string}
interface Entry {name:string;file:string;bytes:number;sha256:string;expiration?:number;metadata?:Json}
function invalid():never{throw new ReliabilityError('INVALID',400);}
function shape(v:unknown,required:string[],optional:string[]=[]):asserts v is Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))invalid();}
async function hash(bytes:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)),b=>b.toString(16).padStart(2,'0')).join('');}
/** JSON grammar is parsed by the platform, then walked lexically to reject duplicate
 * members (including escaped aliases). Do not let an ambiguous credential field win
 * merely because JSON.parse normally keeps its last occurrence. No values in errors. */
function parse(bytes:Uint8Array):Json {
 try {
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),value=JSON.parse(text);let i=0;
  const ws=()=>{while(/[\t\n\r ]/.test(text[i]??'!'))i++;};
  const string=():string=>{const start=i++;while(i<text.length){const c=text[i++];if(c==='\\')i++;else if(c==='"')return JSON.parse(text.slice(start,i));}return invalid();};
  const walk=(depth:number):void=>{if(depth>64)invalid();ws();const c=text[i];if(c==='"'){string();return;}
   if(c==='{'){i++;const keys=new Set<string>();ws();if(text[i]==='}'){i++;return;}for(;;){ws();if(text[i]!=='"')invalid();const key=string();if(keys.has(key))invalid();keys.add(key);ws();if(text[i++]!==':')invalid();walk(depth+1);ws();const end=text[i++];if(end==='}')return;if(end!==',')invalid();}}
   if(c==='['){i++;ws();if(text[i]===']'){i++;return;}for(;;){walk(depth+1);ws();const end=text[i++];if(end===']')return;if(end!==',')invalid();}}
   const start=i;while(i<text.length&&!/[\t\n\r ,}\]]/.test(text[i]))i++;if(i===start)invalid();
  };walk(0);ws();if(i!==text.length)invalid();canonical(value);return value;
 }catch{return invalid();}
}
/** Complete LOCAL evidence adapter for the existing read-only KV backup protocol.
 * expectedHash/target must be pinned by the trusted maintenance loader, not supplied
 * by a public restore request as its own proof. Every file (even ignored auth/cache
 * data) is verified. This does not certify remote stability/drain or install a key.
 * In particular, a live backup remains migrationReady:false / legacyDrainUnproven. */
export async function legacyGenerationSource(raw:Uint8Array,expectedHash:string,expected:LegacyBackupTarget,readEntry:(file:string,expectedBytes:number)=>Promise<Uint8Array>,resolveCustom?:(template:string,digest:string)=>Promise<GenerationSource>):Promise<LoadedGenerationSource>{
 if(!(raw instanceof Uint8Array)||raw.byteLength>4*1024*1024||typeof expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedHash))invalid();
 raw=Uint8Array.from(raw);expected=JSON.parse(canonical(expected));shape(expected,['account','worker','namespace','deployment','version']);accountId(expected.account);accountId(expected.namespace);workerName(expected.worker);identifier(expected.deployment);if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expected.version))invalid();
 if(await hash(raw)!==expectedHash)invalid();const manifest:unknown=parse(raw);shape(manifest,['schema','readOnly','account','worker','namespace','startedAt','capturedAt','deployment','version','consistency','migrationReady','inventoryMatched','verifiedLocalBytes','totalBytes','entries']);
 if(manifest.schema!==1||manifest.readOnly!==true||manifest.consistency!=='live-best-effort-not-cutover'||manifest.migrationReady!==false||manifest.inventoryMatched!==true||manifest.verifiedLocalBytes!==true||Object.entries(expected).some(([k,v])=>manifest[k]!==v))invalid();
 for(const name of ['startedAt','capturedAt'])if(typeof manifest[name]!=='string'||!Number.isFinite(Date.parse(manifest[name])))invalid();if(Date.parse(manifest.capturedAt)<Date.parse(manifest.startedAt))invalid();
 revision(manifest.totalBytes);if(manifest.totalBytes>512*1024*1024||!Array.isArray(manifest.entries)||manifest.entries.length>100000)invalid();
 let bytes=0,last='';for(const [index,entry] of manifest.entries.entries()){shape(entry,['name','file','bytes','sha256'],['expiration','metadata']);if(typeof entry.name!=='string'||!entry.name||new TextEncoder().encode(entry.name).length>512||(index>0&&entry.name<=last)||entry.file!=='value-'+String(index).padStart(6,'0')+'.bin'||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))invalid();last=entry.name;revision(entry.bytes);if(entry.bytes>25*1024*1024)invalid();bytes+=entry.bytes;if(entry.expiration!==undefined)revision(entry.expiration);}
 if(bytes!==manifest.totalBytes)invalid();const records:ConfigRecord[]=[];let businessBytes=0;
 for(const entry of manifest.entries as Entry[]){const fetched=await readEntry(entry.file,entry.bytes);if(!(fetched instanceof Uint8Array)||fetched.byteLength!==entry.bytes)invalid();const value=Uint8Array.from(fetched);if(await hash(value)!==entry.sha256)invalid();const domain=legacyBusinessDomain(entry.name);if(domain===null)continue;
  // Expiring business configuration cannot silently become permanent authority.
  if(entry.expiration!==undefined)invalid();businessBytes+=value.byteLength;if(businessBytes>4*1024*1024)invalid();const decoded=parse(value);encoded(decoded);records.push({domain,revision:1,value:decoded});
 }
 const data:GenerationData={schema:1,records:completeGenerationDomains(records),runtime:{revision:0,value:{}},credentialPolicy:{observationUntil:0,revocations:[]}};
 return {identity:expectedHash,data,blockers:{legacyDrainUnproven:1},migrationReady:false,...(resolveCustom?{resolveCustom}:{})};
}
