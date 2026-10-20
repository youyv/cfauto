import {validateAuthorityBasis,type AuthorityBasis} from './authority-basis';
import {GenerationSourcePins} from './generation-source-pins';
import {ConfigStore,type SqlDatabase} from './config-store';
import {SealedStore,type SealedContext} from './sealed-store';
import type {KeyRing} from './credential-envelope';
import {prepareGenerationData,type GenerationData,type GenerationSource,type PreparedGeneration} from './generation-data';
import {canonical,encoded,identifier,revision,manifestDigest,ReliabilityError,type Json} from './protocol';
export interface GenerationImportRequest {id:string;target:string;source:string;baseGeneration:string|null;epoch:number;credentials:'strict_v2'|'migrate';unprefixed?:'plaintext'|'encrypted'}
export interface LoadedGenerationSource {identity:string;data:GenerationData;sourceBasis?:AuthorityBasis;sourceRecordsDigest?:string;blockers:Record<string,number>;migrationReady:false;resolveCustom?:(template:string,digest:string)=>Promise<GenerationSource>}
export type GenerationLoader=(source:string)=>Promise<LoadedGenerationSource>;
interface ImportRow extends Record<string,unknown>{id:string;digest:string;source:string;target:string;baseline:string;prepared:string;state:string;count:number;records_digest:string|null;error:string|null;created_at:number}
interface Preparation {schema:1;requestDigest:string;sourceIdentity:string;sourceBlockers:Record<string,number>;sourceBasis:AuthorityBasis|null;sourceRecordsDigest:string|null;data:PreparedGeneration}
function invalid():never{throw new ReliabilityError('INVALID',400);}
function conflict():never{throw new ReliabilityError('CONFLICT',409);}
function unavailable():never{throw new ReliabilityError('NOT_READY',503);}
function request(raw:unknown):GenerationImportRequest {
 const value=JSON.parse(encoded(raw));if(!value||typeof value!=='object'||Array.isArray(value)||['id','target','source','baseGeneration','epoch','credentials'].some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!['id','target','source','baseGeneration','epoch','credentials','unprefixed'].includes(k)))invalid();
 for(const field of ['id','target','source'])identifier(value[field]);if(value.id.length>60)invalid();if(value.baseGeneration!==null)identifier(value.baseGeneration);revision(value.epoch);if(!['strict_v2','migrate'].includes(value.credentials)||(value.unprefixed!==undefined&&!['plaintext','encrypted'].includes(value.unprefixed))||(value.credentials==='strict_v2'&&value.unprefixed!==undefined))invalid();return value;
}
/** A staged, persistent business import, NOT a maintenance switch or raw SQL restore.
 * All old generations/evidence remain intact. Verification never claims drain:
 * activationReady is always false until a separate guarded activation protocol exists. */
export class GenerationImport {
 private readonly pins:GenerationSourcePins;private readonly ring:KeyRing;private readonly secret:Uint8Array;private readonly work=new Map<string,Promise<Json>>();
 constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly sealed:SealedStore,ring:KeyRing,secret:Uint8Array,private readonly load:GenerationLoader,private readonly now:()=>number=Date.now){
  if(!(secret instanceof Uint8Array)||secret.length<32)invalid();this.secret=Uint8Array.from(secret);this.ring={...ring,keys:{...ring.keys}};
  this.pins=new GenerationSourcePins(db,sealed);
  db.rows('CREATE TABLE IF NOT EXISTS generation_imports (id TEXT PRIMARY KEY,digest TEXT NOT NULL,source TEXT NOT NULL,target TEXT UNIQUE NOT NULL,baseline TEXT NOT NULL,prepared TEXT NOT NULL,state TEXT NOT NULL,count INTEGER NOT NULL,records_digest TEXT,error TEXT,created_at INTEGER NOT NULL)');
 }
 private async mac(value:unknown):Promise<string>{const key=await crypto.subtle.importKey('raw',this.secret as Uint8Array<ArrayBuffer>,{name:'HMAC',hash:'SHA-256'},false,['sign']);const result=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(canonical(['cfauto:generation-import:v1',value])));return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,'0')).join('');}
 private row(id:string):ImportRow {identifier(id);const row=this.db.rows<ImportRow>('SELECT * FROM generation_imports WHERE id=?',id)[0];if(!row)unavailable();return row;}
 private context(row:ImportRow):SealedContext{return {id:row.prepared,kind:'artifact',account:'migration',generation:row.target};}
 private baseline():string {
  const meta={...this.config.status()};
  const has=(name:string)=>this.db.rows('SELECT name FROM sqlite_master WHERE type=? AND name=?','table',name).length>0;
  return canonical({meta,watermark:this.db.rows<{n:number}>('SELECT COALESCE(MAX(id),0) AS n FROM config_outbox')[0].n,
   runtime:this.db.rows('SELECT domain,revision FROM runtime_records ORDER BY domain').map(r=>({...r})),
   policy:has('credential_policy')?this.db.rows('SELECT generation,observation_until FROM credential_policy WHERE generation=?',meta.generation).map(r=>({...r})):[],
   revocations:has('credential_revocations')?this.db.rows('SELECT account,revision FROM credential_revocations WHERE generation=? ORDER BY account,revision',meta.generation).map(r=>({...r})):[]});
 }
 private barrier(row:ImportRow):void {const meta=this.config.status();if(!meta.maintenance)throw new ReliabilityError('MAINTENANCE',503);if(row.baseline!==this.baseline()||meta.generation===row.target)conflict();}
 inspect(id:string):Json {const row=this.row(id),staged=this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM config_records WHERE generation=?',row.target)[0].n;return {id:row.id,target:row.target,source:row.source,state:row.state,count:row.count,staged,stale:row.baseline!==this.baseline(),activationReady:false,error:row.error};}
 async begin(raw:unknown):Promise<Json>{
  const input=request(raw),digest=await this.mac(input),old=this.db.rows<ImportRow>('SELECT * FROM generation_imports WHERE id=?',input.id)[0];
  if(old&&old.digest!==digest)conflict();const running=this.work.get(input.id);if(running)return running;
  const pending=this.beginOnce(input,digest).finally(()=>{if(this.work.get(input.id)===pending)this.work.delete(input.id);});this.work.set(input.id,pending);return pending;
 }
 private async beginOnce(input:GenerationImportRequest,digest:string):Promise<Json>{
  const row=this.db.transaction(()=>{
   const old=this.db.rows<ImportRow>('SELECT * FROM generation_imports WHERE id=?',input.id)[0];if(old){if(old.digest!==digest)conflict();return old;}
   const meta=this.config.status();if(!meta.maintenance)throw new ReliabilityError('MAINTENANCE',503);if(meta.generation!==input.baseGeneration||meta.epoch!==input.epoch||meta.generation===input.target)conflict();
   // Never borrow a previously staged/live generation belonging to another import.
   if(this.db.rows('SELECT id FROM config_generations WHERE id=?',input.target).length||this.db.rows('SELECT id FROM generation_imports WHERE target=?',input.target).length)conflict();
   const now=this.now();revision(now);const baseline=this.baseline(),prepared='generation_'+input.id;
   this.db.rows("INSERT INTO generation_imports VALUES (?,?,?,?,?,?,'preparing',0,NULL,NULL,?)",input.id,digest,input.source,input.target,baseline,prepared,now);return this.row(input.id);
  });
  this.barrier(row);if(row.state==='verified'||row.state==='staging')return this.inspect(row.id);
  try {
   let preparation:Preparation;
   if(this.db.rows('SELECT id FROM sealed_objects WHERE id=?',row.prepared).length)preparation=await this.readPrepared(row);
   else {
    const source=await this.load(row.source);
    if(!source||typeof source.identity!=='string'||! /^[a-f0-9]{64}$/.test(source.identity)||source.migrationReady!==false||!source.blockers||Object.getPrototypeOf(source.blockers)!==Object.prototype)invalid();
    for(const [name,count] of Object.entries(source.blockers)){identifier(name);revision(count);}
    // Capture authenticated identity and blockers before source/credential crypto can yield.
    const sourceIdentity=source.identity,sourceBlockers={...source.blockers},sourceBasis=source.sourceBasis===undefined?null:validateAuthorityBasis(source.sourceBasis);
    const sourceRecordsDigest=source.sourceRecordsDigest??null;if(sourceRecordsDigest!==null&&!/^[a-f0-9]{64}$/.test(sourceRecordsDigest))invalid();
    const data=await prepareGenerationData(source.data,this.ring,{credentials:input.credentials,unprefixed:input.unprefixed,resolveCustom:source.resolveCustom});
    preparation={schema:1,requestDigest:row.digest,sourceIdentity,sourceBlockers,sourceBasis,sourceRecordsDigest,data};this.barrier(row);
    await this.sealed.put(this.context(row),preparation as unknown as Json,row.created_at);
    preparation=await this.readPrepared(row);
   }
   const recordsDigest=await manifestDigest(preparation.data.records);this.barrier(row);
   this.config.beginImport(row.target,recordsDigest,preparation.data.records.length,()=>this.barrier(row));
   this.db.transaction(()=>{this.barrier(row);this.db.rows("UPDATE generation_imports SET state='staging',count=?,records_digest=?,error=NULL WHERE id=?",preparation.data.records.length,recordsDigest,row.id);});return this.describe(row.id,preparation);
  }catch(error){this.error(row.id,error);throw error;}
 }
 private error(id:string,error:unknown):void {this.db.rows('UPDATE generation_imports SET error=? WHERE id=?',error instanceof ReliabilityError?error.code:'NOT_READY',id);}
 private async readPrepared(row:ImportRow):Promise<Preparation>{const value=await this.sealed.get(this.context(row)) as unknown as Preparation;if(value.schema!==1||value.requestDigest!==row.digest||!Array.isArray(value.data?.records)||! /^[a-f0-9]{64}$/.test(value.sourceIdentity))invalid();return value;}
 private describe(id:string,prepared:Preparation):Json{return {...this.inspect(id) as Record<string,Json>,sourceIdentity:prepared.sourceIdentity,sourceBlockers:prepared.sourceBlockers,normalizations:prepared.data.normalizations as unknown as Json};}
 async resume(id:string,limit=20):Promise<Json>{
  revision(limit);if(limit<1||limit>100)invalid();const row=this.row(id);this.barrier(row);if(!['staging','verified'].includes(row.state))unavailable();
  try {
   const preparation=await this.readPrepared(row);this.barrier(row);
   if(row.records_digest!==await manifestDigest(preparation.data.records)||row.count!==preparation.data.records.length)conflict();
   this.barrier(row);const staged=this.db.rows<{domain:string;revision:number;payload:string}>('SELECT domain,revision,payload FROM config_records WHERE generation=? ORDER BY domain',row.target);
   for(const record of staged){const expected=preparation.data.records.find(r=>r.domain===record.domain);if(!expected||record.revision!==expected.revision||record.payload!==canonical(expected.value))conflict();}
   const todo=preparation.data.records.filter(r=>!staged.some(old=>old.domain===r.domain)).slice(0,limit);
   for(const record of todo)this.config.stage(row.target,record,()=>this.barrier(row));
   const count=this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM config_records WHERE generation=?',row.target)[0].n;
   if(count===row.count){
    const {schema,records,runtime,credentialPolicy}=preparation.data;
    await prepareGenerationData({schema,records,runtime,credentialPolicy},this.ring,{credentials:'strict_v2',resolveCustom:async(template,digest)=>{const source=preparation.data.customSources.find(s=>s.artifact.template===template&&s.artifact.digest===digest);if(!source)unavailable();return source;}});
    this.db.transaction(()=>{this.barrier(row);const saved=this.db.rows<{domain:string;revision:number;payload:string}>('SELECT domain,revision,payload FROM config_records WHERE generation=? ORDER BY domain',row.target).map(r=>({domain:r.domain,revision:r.revision,value:JSON.parse(r.payload)}));if(canonical(saved)!==canonical(preparation.data.records))conflict();this.pins.stageInTransaction(row.id,row.target,row.prepared,preparation.sourceIdentity,preparation.data.customSources);this.db.rows("UPDATE generation_imports SET state='verified',error=NULL WHERE id=?",row.id);});
   }
   return this.describe(row.id,preparation);
  }catch(error){this.error(row.id,error);throw error;}
 }
 /** Internal activation coordinator input. This method itself performs no cutover. */
 async verified(id:string):Promise<{target:string;data:PreparedGeneration;sourceIdentity:string;sourceBlockers:Record<string,number>;sourceBasis:AuthorityBasis|null;sourceRecordsDigest:string|null}>{if(this.row(id).state!=='verified')unavailable();await this.resume(id,1);const row=this.row(id);const value=await this.readPrepared(row);this.barrier(row);return {target:row.target,data:value.data,sourceIdentity:value.sourceIdentity,sourceBlockers:value.sourceBlockers,sourceBasis:value.sourceBasis??null,sourceRecordsDigest:value.sourceRecordsDigest??null};}
 /** Trusted synchronous final guard in the activation's SAME-DB transaction. The
  * caller has just decrypted/validated this exact preparation with verified(). */
 consumeInTransaction(id:string,expected:{target:string;data:PreparedGeneration}):void {
  const row=this.row(id);this.barrier(row);if(row.state!=='verified'||row.target!==expected.target)conflict();const staged=this.db.rows<{domain:string;revision:number;payload:string}>('SELECT domain,revision,payload FROM config_records WHERE generation=? ORDER BY domain',row.target).map(r=>({domain:r.domain,revision:r.revision,value:JSON.parse(r.payload)}));if(canonical(staged)!==canonical(expected.data.records))conflict();
  const generation=this.db.rows<{state:string;digest:string;count:number}>('SELECT state,digest,count FROM config_generations WHERE id=?',row.target)[0];if(!generation||generation.state!=='staging'||generation.digest!==row.records_digest||generation.count!==row.count)conflict();
  const pins=this.db.rows<{template:string;digest:string;preparation:string;import_id:string;provenance:string}>('SELECT template,digest,preparation,import_id,provenance FROM generation_source_pins WHERE generation=?',row.target);if(pins.length!==expected.data.customSources.length||expected.data.customSources.some(s=>!pins.some(p=>p.template===s.artifact.template&&p.digest===s.artifact.digest&&p.preparation===row.prepared&&p.import_id===row.id&&p.provenance===canonical(s.provenance))))conflict();
  this.db.rows("UPDATE generation_imports SET state='activated' WHERE id=?",id);
 }

}
