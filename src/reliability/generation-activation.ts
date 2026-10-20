import {ConfigStore,type SqlDatabase} from './config-store';
import {GenerationImport} from './generation-import';
import {AuthorityDrain} from './authority-drain';
import {canonical,manifestDigest,encoded,identifier,revision,ReliabilityError,type Json} from './protocol';
interface Request {id:string;importId:string;drainId:string}
interface Receipt extends Record<string,unknown>{request:string;receipt:string}
function conflict():never{throw new ReliabilityError('CONFLICT',409);}
function notReady():never{throw new ReliabilityError('NOT_READY',503);}
/** Atomic current-authority replacement (including key rotation), not legacy initial
 * cutover. Requires a capture-time latest source basis, verified complete import,
 * and durable sealed account-DO drain. There is no raw SQL restore, public bypass,
 * implicit maintenance exit, deletion, external mutation or stale-KV fallback. */
export class GenerationActivation {
 constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly imports:GenerationImport,private readonly drain:AuthorityDrain,private readonly now:()=>number=Date.now){db.rows('CREATE TABLE IF NOT EXISTS generation_activations (id TEXT PRIMARY KEY,import_id TEXT UNIQUE NOT NULL,drain_id TEXT UNIQUE NOT NULL,request TEXT NOT NULL,source_identity TEXT NOT NULL,from_generation TEXT NOT NULL,to_generation TEXT UNIQUE NOT NULL,from_epoch INTEGER NOT NULL,to_epoch INTEGER NOT NULL,committed_at INTEGER NOT NULL,receipt TEXT NOT NULL)');}
 private request(raw:unknown):Request {const value=JSON.parse(encoded(raw));if(!value||Object.keys(value).sort().join(',')!=='drainId,id,importId')throw new ReliabilityError('INVALID',400);for(const v of Object.values(value))identifier(v as string);return value;}
 private replay(input:Request):Json|null {const row=this.db.rows<Receipt>('SELECT request,receipt FROM generation_activations WHERE id=?',input.id)[0];if(!row)return null;if(row.request!==canonical(input))conflict();return JSON.parse(row.receipt);}
 inspect(id:string):Json {identifier(id);const row=this.db.rows<Receipt>('SELECT receipt,request FROM generation_activations WHERE id=?',id)[0];if(!row)notReady();return JSON.parse(row.receipt);}
 async activate(raw:unknown,beforeCommit?:(receipt:Json)=>void):Promise<Json>{
  const input=this.request(raw),old=this.replay(input);if(old)return old;
  let candidate:Awaited<ReturnType<GenerationImport['verified']>>;
  try{candidate=await this.imports.verified(input.importId);}catch(error){const replay=this.replay(input);if(replay)return replay;throw error;}
  const afterVerification=this.replay(input);if(afterVerification)return afterVerification;
  if(!candidate.sourceRecordsDigest||!candidate.sourceBasis||candidate.sourceBasis.maintenance!==1||Object.values(candidate.sourceBlockers).some(n=>n!==0))notReady();
  const live=this.config.readAll(),sourceDigest=await manifestDigest(live.records);const afterDigest=this.replay(input);if(afterDigest)return afterDigest;if(sourceDigest!==candidate.sourceRecordsDigest)conflict();
  return this.db.transaction(()=>{
   const replay=this.replay(input);if(replay)return replay;
   if(canonical(this.db.rows<{domain:string;revision:number;payload:string}>('SELECT domain,revision,payload FROM config_records WHERE generation=? ORDER BY domain',live.generation).map(r=>({domain:r.domain,revision:r.revision,value:JSON.parse(r.payload)})))!==canonical(live.records))conflict();
   const meta=this.config.status();if(!meta.maintenance||!meta.generation||meta.generation!==candidate.sourceBasis!.generation||meta.generation===candidate.target)conflict();
   const active=this.db.rows<{id:string}>("SELECT id FROM config_generations WHERE state='active'");if(active.length!==1||active[0].id!==meta.generation)conflict();
   // Both consume operations are part of this SAME transaction and roll back if
   // any policy/runtime/pointer/outbox/receipt write subsequently fails.
   this.drain.consumeInTransaction(input.drainId,candidate.sourceBasis!);
   this.imports.consumeInTransaction(input.importId,candidate);
   const committedAt=this.now();revision(committedAt);const nextEpoch=meta.epoch+1;revision(nextEpoch);
   const policy=this.db.rows<{observation_until:number}>('SELECT observation_until FROM credential_policy WHERE generation=?',meta.generation)[0];if(!policy)notReady();
   const observationUntil=Math.max(policy.observation_until,candidate.data.credentialPolicy.observationUntil,committedAt+7*24*60*60*1000);revision(observationUntil);
   if(this.db.rows('SELECT generation FROM credential_policy WHERE generation=?',candidate.target).length||this.db.rows('SELECT generation FROM credential_revocations WHERE generation=?',candidate.target).length||this.db.rows('SELECT generation FROM runtime_generations WHERE generation=?',candidate.target).length)conflict();
   const oldRuntime=this.config.readRuntime(),oldPayload=canonical(oldRuntime.value),savedRuntime=this.db.rows<{revision:number;payload:string}>("SELECT revision,payload FROM runtime_generations WHERE generation=? AND domain='automation'",meta.generation)[0];
   if(canonical(oldRuntime)!==canonical(candidate.data.runtime))conflict();
   if(savedRuntime&&(savedRuntime.revision!==oldRuntime.revision||savedRuntime.payload!==oldPayload))conflict();
   if(!savedRuntime)this.db.rows("INSERT INTO runtime_generations VALUES (?,'automation',?,?)",meta.generation,oldRuntime.revision,oldPayload);
   this.db.rows('INSERT OR IGNORE INTO runtime_receipt_owners SELECT operation,? FROM runtime_receipts',meta.generation);
   const runtimePayload=canonical(candidate.data.runtime.value);
   this.db.rows("INSERT INTO runtime_generations VALUES (?,'automation',?,?)",candidate.target,candidate.data.runtime.revision,runtimePayload);
   this.db.rows("INSERT INTO runtime_records VALUES ('automation',?,?) ON CONFLICT(domain) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",candidate.data.runtime.revision,runtimePayload);
   this.db.rows('INSERT INTO credential_policy VALUES (?,?)',candidate.target,observationUntil);
   for(const revoked of candidate.data.credentialPolicy.revocations)this.db.rows('INSERT INTO credential_revocations VALUES (?,?,?)',candidate.target,revoked.account,revoked.revision);
   this.db.rows("UPDATE config_generations SET state='retained' WHERE id=?",meta.generation);
   this.db.rows("UPDATE config_generations SET state='active' WHERE id=?",candidate.target);
   this.db.rows('UPDATE config_meta SET generation=?,epoch=? WHERE id=1',candidate.target,nextEpoch);
   this.db.rows('INSERT INTO authority_heads VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config_generation=excluded.config_generation,credential_generation=excluded.credential_generation,runtime_generation=excluded.runtime_generation,epoch=excluded.epoch',candidate.target,candidate.target,candidate.target,nextEpoch);
   for(const record of candidate.data.records)this.db.rows('INSERT INTO config_outbox(generation,domain,revision) VALUES (?,?,?)',candidate.target,record.domain,record.revision);
   const receipt:Json={id:input.id,importId:input.importId,drainId:input.drainId,sourceIdentity:candidate.sourceIdentity,fromGeneration:meta.generation,generation:candidate.target,epoch:nextEpoch,maintenance:true,observationUntil,committedAt,scope:'current_authority',legacyCutover:false};
   this.db.rows('INSERT INTO generation_activations VALUES (?,?,?,?,?,?,?,?,?,?,?)',input.id,input.importId,input.drainId,canonical(input),candidate.sourceIdentity,meta.generation,candidate.target,meta.epoch,nextEpoch,committedAt,canonical(receipt));
   this.config.status();this.config.readRuntime();
   // Trusted synchronous audit ACK shares this exact pointer/policy/runtime transaction.
   if(beforeCommit&&(beforeCommit(JSON.parse(canonical(receipt))) as unknown)!==undefined)throw new ReliabilityError('INVALID',400);
   return receipt;
  });
 }
}
