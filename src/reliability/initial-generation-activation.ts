import {ConfigStore,type SqlDatabase} from './config-store';
import {GenerationImport} from './generation-import';
import {canonical,encoded,identifier,revision,manifestDigest,ReliabilityError,type Json} from './protocol';
export interface InitialCutoverBinding {installation:string;importId:string;generation:string;epoch:number;sourceIdentity:string;recordsDigest:string}
/** Trusted server-only dependency, NOT a caller-supplied certificate or boolean.
 * Implementations must authenticate retained freeze/propagation/legacy-drain/provider
 * terminal/post-freeze backup evidence bound to this exact installation and import.
 * consumeInTransaction must recheck/consume that proof in the SAME SQLite transaction.
 * No production implementation is installed yet; no public activation is exported. */
export interface InitialCutoverProofStore {
 verify(proofId:string,binding:InitialCutoverBinding):Promise<{digest:string}>;
 consumeInTransaction(proofId:string,binding:InitialCutoverBinding,digest:string):void;
}
interface Request {id:string;importId:string;proofId:string;epoch:number}
interface Row extends Record<string,unknown>{request:string;receipt:string}
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
/** Empty-authority transaction participant only. Never invokes the low-level
 * activateInitial (which would commit before policy/runtime/audit), never clears
 * source blockers, exits maintenance, restores SQL or mutates legacy KV. */
export class InitialGenerationActivation {
 constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly imports:GenerationImport,private readonly proofs:InitialCutoverProofStore,private readonly now:()=>number=Date.now){
  db.rows('CREATE TABLE IF NOT EXISTS initial_generation_activations (id TEXT PRIMARY KEY,import_id TEXT UNIQUE NOT NULL,proof_id TEXT UNIQUE NOT NULL,generation TEXT UNIQUE NOT NULL,request TEXT NOT NULL,binding TEXT NOT NULL,proof_digest TEXT NOT NULL,receipt TEXT NOT NULL)');
 }
 private request(raw:unknown):Request {const r=JSON.parse(encoded(raw));if(!r||Object.keys(r).sort().join(',')!=='epoch,id,importId,proofId')throw new ReliabilityError('INVALID',400);identifier(r.id);identifier(r.importId);identifier(r.proofId);revision(r.epoch);return r;}
 private replay(r:Request):Json|null {const row=this.db.rows<Row>('SELECT request,receipt FROM initial_generation_activations WHERE id=?',r.id)[0];if(!row)return null;if(row.request!==canonical(r))conflict();return JSON.parse(row.receipt);}
 inspect(id:string):Json {identifier(id);const row=this.db.rows<Row>('SELECT receipt,request FROM initial_generation_activations WHERE id=?',id)[0];if(!row)unavailable();return JSON.parse(row.receipt);}
 private empty(epoch:number):string {
  const m=this.config.status();if(m.generation!==null||m.maintenance!==1||m.epoch!==epoch)conflict();
  if(this.db.rows("SELECT id FROM config_generations WHERE state!='staging' LIMIT 1").length)conflict();
  // Empty means no prior authority, receipts, runtime or business admissions. Do
  // not turn pointer corruption or a partially initialized store into bootstrap.
  for(const table of ['authority_heads','config_outbox','runtime_records','runtime_generations','runtime_receipts','runtime_receipt_owners','credential_policy','credential_revocations','dispatch_tasks','dispatch_outbox','dispatch_wakeups','dispatch_cancellations','business_admissions','automation_cycles']){
   if(this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table).length&&this.db.rows('SELECT 1 AS present FROM '+table+' LIMIT 1').length)conflict();
  }
  const identity=this.db.rows<{identity:string}>('SELECT identity FROM authority_identity WHERE id=1')[0]?.identity;if(!identity)unavailable();return identity;
 }
 async activate(raw:unknown,beforeCommit?:(receipt:Json)=>void):Promise<Json>{
  const r=this.request(raw),old=this.replay(r);if(old)return old;
  const installation=this.empty(r.epoch);
  let candidate:Awaited<ReturnType<GenerationImport['verified']>>;
  try{candidate=await this.imports.verified(r.importId);}catch(e){const replay=this.replay(r);if(replay)return replay;throw e;}
  let replay=this.replay(r);if(replay)return replay;
  // Current-authority archives and live legacy backups are not initial-cutover
  // sources. A proof cannot waive an unresolved source blocker.
  if(candidate.sourceBasis!==null||Object.values(candidate.sourceBlockers).some(n=>n!==0))unavailable();
  const recordsDigest=await manifestDigest(candidate.data.records);
  replay=this.replay(r);if(replay)return replay;
  const binding:InitialCutoverBinding={installation,importId:r.importId,generation:candidate.target,epoch:r.epoch,sourceIdentity:candidate.sourceIdentity,recordsDigest};
  let verified:{digest:string};
  try{verified=await this.proofs.verify(r.proofId,JSON.parse(canonical(binding)));}catch(e){const replay=this.replay(r);if(replay)return replay;throw e;}
  replay=this.replay(r);if(replay)return replay;
  if(!verified||Object.keys(verified).join(',')!=='digest'||typeof verified.digest!=='string'||! /^[a-f0-9]{64}$/.test(verified.digest))unavailable();
  const proofDigest=verified.digest;
  return this.db.transaction(()=>{
   const old=this.replay(r);if(old)return old;
   if(this.empty(r.epoch)!==installation)conflict();
   if((this.proofs.consumeInTransaction(r.proofId,JSON.parse(canonical(binding)),proofDigest) as unknown)!==undefined)throw new ReliabilityError('INVALID',400);
   this.imports.consumeInTransaction(r.importId,candidate);
   const committedAt=this.now();revision(committedAt);const epoch=r.epoch+1;revision(epoch);
   const observationUntil=Math.max(candidate.data.credentialPolicy.observationUntil,committedAt+7*24*60*60*1000);revision(observationUntil);
   const runtime=candidate.data.runtime;
   this.db.rows("INSERT INTO runtime_records VALUES ('automation',?,?)",runtime.revision,canonical(runtime.value));
   this.db.rows("INSERT INTO runtime_generations VALUES (?,'automation',?,?)",candidate.target,runtime.revision,canonical(runtime.value));
   this.db.rows('INSERT INTO credential_policy VALUES (?,?)',candidate.target,observationUntil);
   for(const revoked of candidate.data.credentialPolicy.revocations)this.db.rows('INSERT INTO credential_revocations VALUES (?,?,?)',candidate.target,revoked.account,revoked.revision);
   this.db.rows("UPDATE config_generations SET state='active' WHERE id=?",candidate.target);
   this.db.rows('UPDATE config_meta SET generation=?,epoch=? WHERE id=1',candidate.target,epoch);
   this.db.rows('INSERT INTO authority_heads VALUES (1,?,?,?,?)',candidate.target,candidate.target,candidate.target,epoch);
   for(const record of candidate.data.records)this.db.rows('INSERT INTO config_outbox(generation,domain,revision) VALUES (?,?,?)',candidate.target,record.domain,record.revision);
   const receipt:Json={id:r.id,importId:r.importId,proofId:r.proofId,proofDigest,sourceIdentity:candidate.sourceIdentity,generation:candidate.target,epoch,maintenance:true,observationUntil,committedAt,scope:'initial_authority'};
   this.db.rows('INSERT INTO initial_generation_activations VALUES (?,?,?,?,?,?,?,?)',r.id,r.importId,r.proofId,candidate.target,canonical(r),canonical(binding),proofDigest,canonical(receipt));
   this.config.status();this.config.readRuntime();
   if(beforeCommit&&(beforeCommit(JSON.parse(canonical(receipt))) as unknown)!==undefined)throw new ReliabilityError('INVALID',400);
   return receipt;
  });
 }
}
