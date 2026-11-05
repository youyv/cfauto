import type {SqlDatabase} from './config-store';
import type {CoordinatorRole} from './coordinator-rpc';
import {canonical,identifier,revision,ReliabilityError,type Json} from './protocol';
import {SealedStore,MAX_SEALED_BYTES,type SealedContext,type SealedPacket} from './sealed-store';
/** Exhaustive state inventory. New tables must be classified before an archive can
 * be made; no downloaded SQL is ever executed. Platform-owned SQLite tables are not
 * business data. Archived backups retain references, not recursively copied payloads. */
export const AUTHORITY_ARCHIVE_TABLES = [
 'account_jobs','account_steps','account_receipts','automation_cycles','automation_flows','automation_lanes','automation_tick_cursor','automation_gc_audits',
 'business_admission_key','business_admissions','business_facts','business_step_state','config_edit_receipts','config_projection','config_projection_generations',
 'config_meta','config_generations','config_records','runtime_records','runtime_receipts','config_outbox','coordinator_identity','coordinator_alarm',
 'coordinator_inbox','coordinator_receipts','coordinator_progress','credential_policy','credential_revocations','deployment_runs','deployment_target_versions',
 'execution_calls','retained_source_references','sealed_objects','sealed_chunks','dispatch_key','dispatch_tasks','dispatch_outbox','dispatch_wakeups','dispatch_cancellations','webhook_outbox','authority_archives','generation_imports','generation_source_pins','account_drain_fences','authority_drains','authority_drain_accounts','authority_identity','authority_heads','runtime_generations','runtime_receipt_owners','generation_activations','initial_generation_activations','initial_cutover_sources','initial_cutover_frames','initial_cutover_proofs','maintenance_receipts','maintenance_attempts','unknown_observations','archive_packet_transfers','archive_transfer_frames','account_archive_registry','archive_bundle_collections','archive_bundle_collection_transfers','unknown_attestations','unknown_adjudications','no_mutation_settlements'
] as const;
const PAGE_BYTES=512*1024,MAX_ARCHIVE_BYTES=64*1024*1024,MAX_PAGES=512,MAX_ROWS=250000;
const encoder=new TextEncoder();
interface ArchiveRow extends Record<string,unknown>{id:string;installation:string;role:string;generation:string;epoch:number;captured_at:number;state:string;root:string;error:string|null}
interface TableSpec {name:string;sql:string;columns:string[];rows:number;pages:string[]}
interface Page {schema:1;archive:string;installation:string;role:CoordinatorRole;generation:string;epoch:number;table:string;ordinal:number;columns:string[];rows:Array<{position:number;values:Json[]}>}
interface Manifest {format:'cfauto.authority-object';version:1;id:string;installation:string;role:CoordinatorRole;generation:string;epoch:number;capturedAt:number;maintenance:boolean|null;migrationReady:false;scope:'one_durable_object';exclusions:string[];tables:TableSpec[];pages:Array<{id:string;bytes:number;keyId:string;digest:string}>;sequences:Array<{name:string;seq:number}>}
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
function exact(value:unknown,fields:string[]):asserts value is Record<string,any>{if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k)))invalid();}
function copyPacket(raw:unknown):SealedPacket {
 exact(raw,['format','version','object','chunks','proof']);exact(raw.object,['id','kind','account','generation','key_id','digest','bytes','chunks','created_at']);
 if(raw.format!=='cfauto.sealed-object'||raw.version!==1||typeof raw.proof!=='string'||! /^[a-f0-9]{64}$/.test(raw.proof)||!Array.isArray(raw.chunks)||raw.chunks.length<1||raw.chunks.length>107)invalid();
 for(const name of ['id','kind','account','generation','key_id','digest'])if(typeof raw.object[name]!=='string'||raw.object[name].length>100)invalid();
 for(const name of ['bytes','chunks','created_at'])revision(raw.object[name]);
 let size=0;for(const chunk of raw.chunks){exact(chunk,['ordinal','ciphertext']);revision(chunk.ordinal);if(typeof chunk.ciphertext!=='string'||chunk.ciphertext.length>70000)invalid();size+=chunk.ciphertext.length;}
 if(size>MAX_SEALED_BYTES*1.5)invalid();return JSON.parse(canonical(raw)) as SealedPacket;
}
/** A complete, transaction-consistent archive of ONE object's operational tables.
 * It is not a multi-DO drain proof or a cutover backup. No methods activate an old
 * queue/config/KV snapshot. The later maintenance orchestrator must collect every
 * account object and prove actual request/Cron drain before declaring readiness. */
export class AuthorityArchive {
 private readonly owner:string;
 private readonly role:CoordinatorRole;
 private readonly work=new Map<string,Promise<Json>>();
 constructor(private readonly db:SqlDatabase,private readonly sealed:SealedStore,private readonly installation:string,role:CoordinatorRole,private readonly now:()=>number=Date.now){
  identifier(installation);if(role.role==='global'){exact(role,['role']);this.role={role:'global'};this.owner='archive_global';}else{exact(role,['role','account']);identifier(role.account);this.role={...role};this.owner=role.account;}
  db.rows('CREATE TABLE IF NOT EXISTS authority_archives (id TEXT PRIMARY KEY,installation TEXT NOT NULL,role TEXT NOT NULL,generation TEXT NOT NULL,epoch INTEGER NOT NULL,captured_at INTEGER NOT NULL,state TEXT NOT NULL,root TEXT NOT NULL,error TEXT)');
 }
 private context(id:string,generation:string):SealedContext{return {id,kind:'config_backup',account:this.owner,generation};}
 private row(id:string):ArchiveRow {identifier(id);const row=this.db.rows<ArchiveRow>('SELECT * FROM authority_archives WHERE id=?',id)[0];if(!row)unavailable();if(row.installation!==this.installation||row.role!==canonical(this.role))conflict();return row;}
 inspect(id:string):Json {const r=this.row(id);return {id:r.id,state:r.state,generation:r.generation,epoch:r.epoch,capturedAt:r.captured_at,scope:'one_durable_object',migrationReady:false,error:r.error};}
 create(id:string,generation:string,epoch:number):Promise<Json>{
  identifier(id);identifier(generation);revision(epoch);if(id.length>60)invalid();
  const key=canonical([id,generation,epoch]),prior=this.work.get(key);if(prior)return prior;
  const pending=this.createOnce(id,generation,epoch).finally(()=>{if(this.work.get(key)===pending)this.work.delete(key);});this.work.set(key,pending);return pending;
 }
 private async createOnce(id:string,generation:string,epoch:number):Promise<Json>{
  const capturedAt=this.now();revision(capturedAt);
  const fresh=this.db.transaction(()=>{
   const prior=this.db.rows<ArchiveRow>('SELECT * FROM authority_archives WHERE id=?',id)[0];
   if(prior){if(prior.installation!==this.installation||prior.role!==canonical(this.role)||prior.generation!==generation||prior.epoch!==epoch)conflict();return false;}
   this.db.rows("INSERT INTO authority_archives VALUES (?,?,?,?,?,?,'preparing',?,NULL)",id,this.installation,canonical(this.role),generation,epoch,capturedAt,'backup_'+id+'_root');return true;
  });
  const row=this.row(id);
  if(row.state==='ready'){await this.verifyStored(row);return this.inspect(id);}
  if(!fresh){await this.verifyStored(row);this.finish(row);return this.inspect(id);} // Never recapture a newer snapshot under the same identity.
  try {
   const captured=this.capture(row);
   const pages:Manifest['pages']=[];
   for(const page of captured.pages){const pageId='backup_'+id+'_p'+pages.length;await this.sealed.put(this.context(pageId,generation),page as unknown as Json,capturedAt);const packet=await this.sealed.exportPacket(this.context(pageId,generation));pages.push({id:pageId,bytes:packet.object.bytes,keyId:packet.object.key_id,digest:packet.object.digest});}
   const manifest:Manifest={...captured.manifest,pages};
   await this.sealed.put(this.context(row.root,generation),manifest as unknown as Json,capturedAt);
   await this.verifyStored(row);this.finish(row);return this.inspect(id);
  }catch(error){this.db.rows('UPDATE authority_archives SET error=? WHERE id=? AND state!=?',error instanceof ReliabilityError?error.code:'NOT_READY',id,'ready');throw error instanceof ReliabilityError?error:new ReliabilityError('NOT_READY',503);}
 }
 private finish(row:ArchiveRow):void {this.db.transaction(()=>{const current=this.row(row.id);if(current.root!==row.root||current.generation!==row.generation||current.epoch!==row.epoch)conflict();this.db.rows("UPDATE authority_archives SET state='ready',error=NULL WHERE id=?",row.id);});}
 private capture(row:ArchiveRow):{manifest:Omit<Manifest,'pages'>;pages:Page[]} {
  return this.db.transaction(()=>{
   const schema=this.db.rows<{name:string;sql:string}>('SELECT name,sql FROM sqlite_master WHERE type=? ORDER BY name','table');
   const allowed=new Set<string>(AUTHORITY_ARCHIVE_TABLES);
   const names=schema.filter(t=>!t.name.startsWith('sqlite_')&&!t.name.startsWith('_cf_')&&t.name!=='__miniflare_do_name');
   if(names.some(t=>!allowed.has(t.name)))unavailable();
   for(const required of ['sealed_objects','sealed_chunks',...(this.role.role==='global'?['config_meta','config_generations','config_records']:['account_jobs','account_steps','account_receipts'])])if(!names.some(t=>t.name===required))unavailable();
   let maintenance:boolean|null=null;
   if(this.role.role==='global'){const meta=this.db.rows<{generation:string;epoch:number;maintenance:number}>('SELECT generation,epoch,maintenance FROM config_meta WHERE id=1')[0];if(!meta||meta.generation!==row.generation||meta.epoch!==row.epoch)conflict();maintenance=!!meta.maintenance;}
   const storedRole=names.some(t=>t.name==='coordinator_identity')?this.db.rows<{role:string}>('SELECT role FROM coordinator_identity WHERE id=1')[0]:undefined;
   if(storedRole&&storedRole.role!==canonical(this.role))conflict();
   const tables:TableSpec[]=[],pages:Page[]=[];let bytes=0,totalRows=0;
   for(const table of names){
    // Only static allowlisted names reach these SQL identifiers; no archive SQL is executed.
    const columns=this.db.rows<{name:string}>('PRAGMA table_info("'+table.name+'")').map(c=>c.name);
    if(columns.length===0||columns.some(c=>!/^[a-z_]+$/.test(c)))unavailable();
    const spec:TableSpec={name:table.name,sql:table.sql,columns,rows:0,pages:[]};tables.push(spec);
    let position=0,current:Page|undefined,pageBytes=0;
    const flush=()=>{if(!current)return;const payloadBytes=encoder.encode(canonical(current)).length;if(payloadBytes>MAX_SEALED_BYTES||pages.length>=MAX_PAGES)unavailable();bytes+=payloadBytes;if(bytes>MAX_ARCHIVE_BYTES)unavailable();spec.pages.push('backup_'+row.id+'_p'+pages.length);pages.push(current);current=undefined;pageBytes=0;};
    // Packet frames are retained backup payloads, not recursively copied into the next archive.
    const filter=table.name==='archive_transfer_frames'?' AND 0':table.name==='sealed_objects'?" AND kind!='config_backup'":table.name==='sealed_chunks'?" AND id NOT IN (SELECT id FROM sealed_objects WHERE kind='config_backup')":table.name==='authority_archives'?' AND id!=?':'';
    for(;;){
     const rows=this.db.rows<Record<string,unknown>>('SELECT rowid AS archive_position,* FROM "'+table.name+'" WHERE rowid>?'+filter+' ORDER BY rowid LIMIT 250',position,...(table.name==='authority_archives'?[row.id]:[]));
     if(!rows.length)break;
     for(const entry of rows){
      const at=entry.archive_position;if(typeof at!=='number'||!Number.isSafeInteger(at)||at<=position)unavailable();position=at as number;
      const values=columns.map(c=>entry[c]);if(values.some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v))))unavailable();
      const next={position:at as number,values:values as Json[]},size=encoder.encode(canonical(next)).length;
      if(current&&pageBytes+size>PAGE_BYTES)flush();
      if(!current)current={schema:1,archive:row.id,installation:this.installation,role:this.role,generation:row.generation,epoch:row.epoch,table:table.name,ordinal:spec.pages.length,columns,rows:[]};
      current.rows.push(next);pageBytes+=size;spec.rows++;totalRows++;if(totalRows>MAX_ROWS)unavailable();
     }
    }
    flush();
   }
   const sequences=schema.some(t=>t.name==='sqlite_sequence')?this.db.rows<{name:string;seq:number}>('SELECT name,seq FROM sqlite_sequence ORDER BY name').filter(r=>allowed.has(r.name)).map(r=>({...r})):[];
   for(const r of sequences)revision(r.seq);
   return {manifest:{format:'cfauto.authority-object',version:1,id:row.id,installation:this.installation,role:this.role,generation:row.generation,epoch:row.epoch,capturedAt:row.captured_at,maintenance,migrationReady:false,scope:'one_durable_object',exclusions:['platform_internal_tables','prior_backup_payloads'],tables,sequences},pages};
  });
 }
 private async verifyStored(row:ArchiveRow):Promise<{manifest:Manifest;pages:Page[]}>{
  const root=await this.sealed.exportPacket(this.context(row.root,row.generation));
  const manifest=await this.sealed.openPacket(this.context(row.root,row.generation),root) as unknown as Manifest;
  const pages:SealedPacket[]=[];
  if(!Array.isArray(manifest.pages)||manifest.pages.length>MAX_PAGES)invalid();
  for(const page of manifest.pages)pages.push(await this.sealed.exportPacket(this.context(page.id,row.generation)));
  return this.verify(row.id,row.generation,row.epoch,root,pages);
 }
 /** Internal verified source for typed generation migration; never serialize this as a public response. */
 async snapshot(id:string):Promise<{manifest:Manifest;pages:Page[]}>{const row=this.row(id);if(row.state!=='ready')unavailable();return this.verifyStored(row);}
 /** Read only an original encrypted object contained in the authenticated archive.
  * Does not consult a newer live object or execute/restore any archived SQL. */
 async archivedObject(id:string,context:SealedContext):Promise<{value:Json;keyId:string}>{
  context={...context};const snapshot=await this.snapshot(id);
  const rows=(name:string,columns:string[])=>{const spec=snapshot.manifest.tables.find(t=>t.name===name);if(!spec||canonical([...spec.columns].sort())!==canonical([...columns].sort()))invalid();return snapshot.pages.filter(p=>p.table===name).flatMap(p=>p.rows.map(r=>Object.fromEntries(p.columns.map((c,i)=>[c,r.values[i]]))));};
  const objects=rows('sealed_objects',['id','kind','account','generation','key_id','digest','bytes','chunks','created_at']).filter(o=>o.id===context.id);if(objects.length!==1)unavailable();
  const chunks=rows('sealed_chunks',['id','ordinal','ciphertext']).filter(c=>c.id===context.id).sort((a,b)=>Number(a.ordinal)-Number(b.ordinal)).map(c=>({ordinal:c.ordinal,ciphertext:c.ciphertext}));
  const value=await this.sealed.openArchiveObject(context,objects[0],chunks);return {value,keyId:objects[0].key_id as string};
 }
 async rootPacket(id:string):Promise<SealedPacket>{const row=this.row(id);if(row.state!=='ready')unavailable();return this.sealed.exportPacket(this.context(row.root,row.generation));}
 async pagePacket(id:string,ordinal:number):Promise<SealedPacket>{revision(ordinal);const row=this.row(id);if(row.state!=='ready')unavailable();const manifest=await this.sealed.get(this.context(row.root,row.generation)) as unknown as Manifest;if(ordinal>=manifest.pages.length)invalid();return this.sealed.exportPacket(this.context(manifest.pages[ordinal].id,row.generation));}
 /** Verifies all pages and row counts, retaining typed data for the future generation
  * importer. This is deliberately NOT a raw SQL restore or an activation method. */
 async verify(id:string,generation:string,epoch:number,root:unknown,packets:unknown[]):Promise<{manifest:Manifest;pages:Page[]}>{
  identifier(id);identifier(generation);revision(epoch);if(id.length>60||!Array.isArray(packets)||packets.length>MAX_PAGES)invalid();
  let encodedBytes=0;
  for(const input of packets){exact(input,['format','version','object','chunks','proof']);exact(input.object,['id','kind','account','generation','key_id','digest','bytes','chunks','created_at']);if(!Array.isArray(input.chunks)||input.chunks.length>107)invalid();for(const chunk of input.chunks){exact(chunk,['ordinal','ciphertext']);if(typeof chunk.ciphertext!=='string'||chunk.ciphertext.length>70000)invalid();encodedBytes+=chunk.ciphertext.length;if(encodedBytes>MAX_ARCHIVE_BYTES*1.5)invalid();}}
  const frozen=packets.map(copyPacket);
  const manifest=await this.sealed.openPacket(this.context('backup_'+id+'_root',generation),root) as unknown as Manifest;
  this.validateManifest(manifest,id,generation,epoch);
  if(manifest.pages.length!==frozen.length)invalid();
  const expectedPages=manifest.tables.flatMap(t=>t.pages);
  const decoded:Page[]=[];let bytes=0,rows=0;
  for(let i=0;i<manifest.pages.length;i++){
   const ref=manifest.pages[i];exact(ref,['id','bytes','keyId','digest']);
   if(ref.id!=='backup_'+id+'_p'+i||expectedPages[i]!==ref.id)invalid();
   const p=frozen[i];if(!p||ref.bytes!==p.object?.bytes||ref.keyId!==p.object?.key_id||ref.digest!==p.object?.digest)invalid();
   const page=await this.sealed.openPacket(this.context(ref.id,generation),p) as unknown as Page;
   exact(page,['schema','archive','installation','role','generation','epoch','table','ordinal','columns','rows']);
   const spec=manifest.tables.find(t=>t.name===page.table);
   if(!spec||page.schema!==1||page.archive!==id||page.installation!==this.installation||canonical(page.role)!==canonical(this.role)||page.generation!==generation||page.epoch!==epoch||spec.pages[page.ordinal]!==ref.id||canonical(page.columns)!==canonical(spec.columns)||!Array.isArray(page.rows)||!page.rows.length)invalid();
   let last=decoded.filter(p=>p.table===page.table).at(-1)?.rows.at(-1)?.position??0;
   for(const row of page.rows){exact(row,['position','values']);revision(row.position);if(row.position<=last||!Array.isArray(row.values)||row.values.length!==page.columns.length||row.values.some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v))))invalid();last=row.position;}
   rows+=page.rows.length;bytes+=p.object.bytes;if(rows>MAX_ROWS||bytes>MAX_ARCHIVE_BYTES)invalid();decoded.push(page);
  }
  for(const spec of manifest.tables)if(decoded.filter(p=>p.table===spec.name).reduce((n,p)=>n+p.rows.length,0)!==spec.rows)invalid();
  return {manifest,pages:decoded};
 }
 private validateManifest(manifest:Manifest,id:string,generation:string,epoch:number):void {
  exact(manifest,['format','version','id','installation','role','generation','epoch','capturedAt','maintenance','migrationReady','scope','exclusions','tables','pages','sequences']);
  if(manifest.format!=='cfauto.authority-object'||manifest.version!==1||manifest.id!==id||manifest.installation!==this.installation||canonical(manifest.role)!==canonical(this.role)||manifest.generation!==generation||manifest.epoch!==epoch||manifest.scope!=='one_durable_object'||manifest.migrationReady!==false||!(manifest.maintenance===null||typeof manifest.maintenance==='boolean')||canonical(manifest.exclusions)!==canonical(['platform_internal_tables','prior_backup_payloads']))invalid();
  revision(manifest.capturedAt);
  if(!Array.isArray(manifest.tables)||manifest.tables.length>AUTHORITY_ARCHIVE_TABLES.length||!Array.isArray(manifest.pages)||manifest.pages.length>MAX_PAGES||!Array.isArray(manifest.sequences))invalid();
  const names=new Set<string>(),expectedPages:string[]=[];
  for(const spec of manifest.tables){exact(spec,['name','sql','columns','rows','pages']);if(!(AUTHORITY_ARCHIVE_TABLES as readonly string[]).includes(spec.name)||names.has(spec.name)||typeof spec.sql!=='string'||!Array.isArray(spec.columns)||new Set(spec.columns).size!==spec.columns.length||!spec.columns.length||spec.columns.some(c=>typeof c!=='string'||!/^[a-z_]+$/.test(c))||!Array.isArray(spec.pages))invalid();revision(spec.rows);names.add(spec.name);expectedPages.push(...spec.pages);}
  for(const required of ['sealed_objects','sealed_chunks',...(this.role.role==='global'?['config_meta','config_generations','config_records']:['account_jobs','account_steps','account_receipts'])])if(!names.has(required))invalid();
  if(expectedPages.length!==manifest.pages.length||new Set(expectedPages).size!==expectedPages.length)invalid();
  const sequenceNames=new Set<string>();
  for(const seq of manifest.sequences){exact(seq,['name','seq']);if(!names.has(seq.name)||sequenceNames.has(seq.name))invalid();sequenceNames.add(seq.name);revision(seq.seq);}
  for(let i=0;i<manifest.pages.length;i++){const ref=manifest.pages[i];exact(ref,['id','bytes','keyId','digest']);if(ref.id!=='backup_'+id+'_p'+i||expectedPages[i]!==ref.id||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>MAX_SEALED_BYTES||!/^[a-f0-9]{64}$/.test(ref.digest))invalid();identifier(ref.keyId);}
 }
 /** Resumable transfer into a receiving archive, never into active SQL tables.
  * Root/page ciphertext identity is immutable; malformed pages are not overwritten. */
 async receiveRoot(id:string,generation:string,epoch:number,raw:unknown):Promise<Json>{
  identifier(id);identifier(generation);revision(epoch);if(id.length>60)invalid();
  const packet=copyPacket(raw);
  const ctx=this.context('backup_'+id+'_root',generation);
  const manifest=await this.sealed.openPacket(ctx,packet) as unknown as Manifest;
  this.validateManifest(manifest,id,generation,epoch);
  const prior=this.db.rows<ArchiveRow>('SELECT * FROM authority_archives WHERE id=?',id)[0];
  if(prior&&(prior.installation!==this.installation||prior.role!==canonical(this.role)||prior.generation!==generation||prior.epoch!==epoch||prior.captured_at!==manifest.capturedAt))conflict();
  await this.sealed.importPacket(ctx,packet);
  this.db.transaction(()=>{
   const old=this.db.rows<ArchiveRow>('SELECT * FROM authority_archives WHERE id=?',id)[0];
   if(old){if(old.installation!==this.installation||old.role!==canonical(this.role)||old.generation!==generation||old.epoch!==epoch||old.captured_at!==manifest.capturedAt)conflict();return;}
   this.db.rows("INSERT INTO authority_archives VALUES (?,?,?,?,?,?,'receiving',?,NULL)",id,this.installation,canonical(this.role),generation,epoch,manifest.capturedAt,ctx.id);
  });
  return this.inspect(id);
 }
 async receivePage(id:string,ordinal:number,raw:unknown):Promise<{duplicate:boolean}>{
  revision(ordinal);const packet=copyPacket(raw),row=this.row(id);
  if(!['receiving','ready'].includes(row.state))conflict();
  const manifest=await this.sealed.get(this.context(row.root,row.generation)) as unknown as Manifest;
  this.validateManifest(manifest,id,row.generation,row.epoch);
  if(ordinal>=manifest.pages.length)invalid();
  const ref=manifest.pages[ordinal],ctx=this.context(ref.id,row.generation);
  const page=await this.sealed.openPacket(ctx,packet) as unknown as Page;
  exact(page,['schema','archive','installation','role','generation','epoch','table','ordinal','columns','rows']);
  const spec=manifest.tables.find(t=>t.name===page.table);
  if(ref.bytes!==packet.object.bytes||ref.keyId!==packet.object.key_id||ref.digest!==packet.object.digest||!spec||page.schema!==1||page.archive!==id||page.installation!==this.installation||canonical(page.role)!==canonical(this.role)||page.generation!==row.generation||page.epoch!==row.epoch||spec.pages[page.ordinal]!==ref.id||canonical(spec.columns)!==canonical(page.columns)||!Array.isArray(page.rows)||!page.rows.length)invalid();
  let last=0;for(const record of page.rows){exact(record,['position','values']);revision(record.position);if(record.position<=last||!Array.isArray(record.values)||record.values.length!==page.columns.length||record.values.some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v))))invalid();last=record.position;}
  return this.sealed.importPacket(ctx,packet);
 }
 async finishReceive(id:string):Promise<Json>{const row=this.row(id);if(!['receiving','ready'].includes(row.state))conflict();await this.verifyStored(row);this.finish(row);return this.inspect(id);}

}
