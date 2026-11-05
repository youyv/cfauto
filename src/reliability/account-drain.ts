import {adjudicationGuard,type VerifiedAdjudication} from './adjudication-fact';
import type {SqlDatabase} from './config-store';
import {canonical,identifier,revision,ReliabilityError,type Json} from './protocol';
export interface DrainRequest {id:string;generation:string;epoch:number;challenge:string}
export interface AccountDrainReport extends DrainRequest {schema:1;account:string;ready:boolean;blockers:Record<string,number>;humanSettlements?:number}
export function drainRequest(raw:unknown):DrainRequest {const value=JSON.parse(canonical(raw));if(!value||Object.keys(value).sort().join(',')!=='challenge,epoch,generation,id')throw new ReliabilityError('INVALID',400);for(const k of ['id','generation','challenge'])identifier(value[k]);revision(value.epoch);return value;}
const terminal="'succeeded','failed','partial_failed','cancelled','partial_cancelled'";
/** Account-role durable quiescence fence. It never times out, resolves unknown,
 * deletes evidence, or marks unfinished work successful. Only authenticated global
 * RPC calls this helper. A ready fence rejects late deliveries of its generation. */
export class AccountDrain {
 constructor(private readonly db:SqlDatabase,private readonly account:string){identifier(account);db.rows('CREATE TABLE IF NOT EXISTS account_drain_fences (id TEXT PRIMARY KEY,generation TEXT NOT NULL,epoch INTEGER NOT NULL,challenge TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL)');}
 probe(raw:unknown,running=false,businessProgress=true,settlements:VerifiedAdjudication[]=[]):AccountDrainReport {
  const request=drainRequest(raw);return this.db.transaction(()=>{
   const old=this.db.rows<{generation:string;epoch:number;challenge:string;state:string}>('SELECT generation,epoch,challenge,state FROM account_drain_fences WHERE id=?',request.id)[0];if(old&&(old.generation!==request.generation||old.epoch!==request.epoch||old.challenge!==request.challenge||old.state==='released'))throw new ReliabilityError('CONFLICT',409);
   if(this.db.rows("SELECT id FROM account_drain_fences WHERE generation=? AND state='sealed' AND id!=?",request.generation,request.id).length)throw new ReliabilityError('CONFLICT',409);
   const has=(table:string)=>this.db.rows('SELECT name FROM sqlite_master WHERE type=? AND name=?','table',table).length>0;
   const count=(sql:string)=>this.db.rows<{n:number}>(sql)[0].n;
   if(!has('account_jobs')||!has('account_steps')||!has('coordinator_inbox')||!has('coordinator_receipts')||!has('coordinator_progress'))throw new ReliabilityError('NOT_READY',503);
   for(const v of settlements)if(!adjudicationGuard(this.db,v))throw new ReliabilityError('CONFLICT',409);
   const unresolvedMutations=has('execution_calls')?this.db.rows<{job:string;ordinal:number;digest:string}>("SELECT job,ordinal,digest FROM execution_calls WHERE mutation=1 AND state!='done'"):[];
   const remaining=unresolvedMutations.filter(c=>!settlements.some(v=>v.job===c.job&&v.ordinal===c.ordinal&&v.digest===c.digest));
   const blockers={running:Number(running),jobs:count('SELECT COUNT(*) AS n FROM account_jobs WHERE state NOT IN ('+terminal+')'),steps:count("SELECT COUNT(*) AS n FROM account_steps WHERE state NOT IN ('verified','failed','skipped')"),mutations:remaining.length,
    receipts:count('SELECT COUNT(*) AS n FROM coordinator_receipts WHERE acknowledged!=1'),progress:businessProgress?count('SELECT COUNT(*) AS n FROM coordinator_progress WHERE acknowledged!=1'):0,
    missingReceipts:count('SELECT COUNT(*) AS n FROM account_jobs j LEFT JOIN coordinator_receipts r ON r.task=j.id WHERE r.task IS NULL'),missingInbox:count('SELECT COUNT(*) AS n FROM account_jobs j LEFT JOIN coordinator_inbox i ON i.task=j.id WHERE i.task IS NULL'),
    staleProgress:businessProgress?count('SELECT COUNT(*) AS n FROM account_jobs j LEFT JOIN coordinator_progress p ON p.task=j.id WHERE p.task IS NULL OR p.version!=(SELECT COALESCE(MAX(seq),0) FROM account_receipts WHERE job=j.id) OR p.cancel_requested!=j.cancel_requested'):0};
   const report:AccountDrainReport={schema:1,account:this.account,...request,...(unresolvedMutations.length!==remaining.length?{humanSettlements:unresolvedMutations.length-remaining.length}:{}),ready:Object.values(blockers).every(n=>n===0),blockers};
   this.db.rows('INSERT INTO account_drain_fences VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload',request.id,request.generation,request.epoch,request.challenge,report.ready?'sealed':old?.state==='sealed'?'sealed':'waiting',canonical(report));return report;
  });
 }
 assertDelivery(generation:string):void {identifier(generation);if(this.db.rows("SELECT id FROM account_drain_fences WHERE generation=? AND state='sealed' LIMIT 1",generation).length)throw new ReliabilityError('MAINTENANCE',503);}
 release(raw:unknown):Json {const request=drainRequest(raw);return this.db.transaction(()=>{const row=this.db.rows<{generation:string;epoch:number;challenge:string}>('SELECT generation,epoch,challenge FROM account_drain_fences WHERE id=?',request.id)[0];if(row&&(row.generation!==request.generation||row.epoch!==request.epoch||row.challenge!==request.challenge))throw new ReliabilityError('CONFLICT',409);if(!row)this.db.rows("INSERT INTO account_drain_fences VALUES (?,?,?,?,'released','{}')",request.id,request.generation,request.epoch,request.challenge);else this.db.rows("UPDATE account_drain_fences SET state='released' WHERE id=?",request.id);return {released:true,...request};});}
}
