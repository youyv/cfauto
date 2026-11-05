import {authorityAccounts} from './authority-accounts';
import {ConfigStore,type SqlDatabase} from './config-store';
import {authorityBasis,validateAuthorityBasis,type AuthorityBasis} from './authority-basis';
import {drainRequest,type AccountDrainReport,type DrainRequest} from './account-drain';
import type {RpcSend} from './coordinator-runtime';
import {canonical,identifier,revision,ReliabilityError,type Json} from './protocol';
interface Session extends Record<string,unknown>{id:string;generation:string;epoch:number;challenge:string;basis:string;accounts:string;state:string}
const notReady=():never=>{throw new ReliabilityError('NOT_READY',503);};
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
/** Proves quiescence of all known authority-managed account DOs. NOT proof that
 * pre-migration legacy requests/Cron have drained. It cannot certify a legacy KV
 * source or bootstrap an empty store. Account seals persist until explicit release. */
export class AuthorityDrain {
 constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly send:RpcSend){db.rows('CREATE TABLE IF NOT EXISTS authority_drains (id TEXT PRIMARY KEY,generation TEXT NOT NULL,epoch INTEGER NOT NULL,challenge TEXT NOT NULL,basis TEXT NOT NULL,accounts TEXT NOT NULL,state TEXT NOT NULL)');db.rows('CREATE TABLE IF NOT EXISTS authority_drain_accounts (drain TEXT NOT NULL,account TEXT NOT NULL,payload TEXT NOT NULL,released INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(drain,account))');}
 private row(id:string):Session {identifier(id);const row=this.db.rows<Session>('SELECT * FROM authority_drains WHERE id=?',id)[0];if(!row)notReady();return row;}
 private request(row:Session):DrainRequest{return {id:row.id,generation:row.generation,epoch:row.epoch,challenge:row.challenge};}
 private accounts():string[]{return authorityAccounts(this.db,this.config.status().generation!);}
 blockers():Record<string,number>{
  const has=(t:string)=>this.db.rows('SELECT name FROM sqlite_master WHERE type=? AND name=?','table',t).length>0;
  const count=(t:string,where:string)=>has(t)?this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM '+t+' WHERE '+where)[0].n:0;
  if(!has('dispatch_outbox'))notReady();return {dispatch:count('dispatch_outbox',"state!='terminal'"),manifests:count('business_admissions','task IS NULL'),deploymentRuns:count('deployment_runs','finished IS NULL'),unknownFacts:count('business_step_state',"state='unknown'"),automation:count('automation_flows',"state NOT IN ('complete','planning_failed')"),notices:count('webhook_outbox',"state NOT IN ('delivered','rejected')"),cancellations:count('dispatch_cancellations','acknowledged!=1'),wakeups:count('dispatch_wakeups','acknowledged!=1')};
 }
 private barrier(row:Session):void {const meta=this.config.status();if(!meta.maintenance)throw new ReliabilityError('MAINTENANCE',503);if(canonical(authorityBasis(this.db))!==row.basis||canonical(this.accounts())!==row.accounts)conflict();if(Object.values(this.blockers()).some(n=>n!==0))notReady();}
 begin(id:string):Json {return this.db.transaction(()=>this.beginInTransaction(id));}
 /** Trusted maintenance transaction shares the same receipt commit boundary. */
 beginInTransaction(id:string):Json {identifier(id);const old=this.db.rows<Session>('SELECT * FROM authority_drains WHERE id=?',id)[0];if(old){this.barrier(old);if(!['probing','ready'].includes(old.state))conflict();return this.inspect(id);}if(!this.config.status().maintenance)throw new ReliabilityError('MAINTENANCE',503);if(Object.values(this.blockers()).some(n=>n!==0))notReady();const basis=validateAuthorityBasis(authorityBasis(this.db)),accounts=this.accounts();if(this.db.rows("SELECT id FROM authority_drains WHERE generation=? AND state NOT IN ('consumed','released') LIMIT 1",basis.generation).length)conflict();if(accounts.length>10000)notReady();this.db.rows("INSERT INTO authority_drains VALUES (?,?,?,?,?,?,'probing')",id,basis.generation,basis.epoch,crypto.randomUUID(),canonical(basis),canonical(accounts));return this.inspect(id);}
 inspect(id:string):Json {const row=this.row(id);return {id,generation:row.generation,epoch:row.epoch,state:row.state,accounts:JSON.parse(row.accounts).length,probed:this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM authority_drain_accounts WHERE drain=?',id)[0].n,scope:'authority_managed_tasks',legacyDrainProven:false,blockers:this.blockers()};}
 async advance(id:string,limit=20):Promise<Json>{revision(limit);if(limit<1||limit>100)conflict();const row=this.row(id);if(!['probing','ready'].includes(row.state))conflict();this.barrier(row);const request=this.request(row),accounts=JSON.parse(row.accounts) as string[];let attempts=0;
  for(const account of accounts){const prior=this.db.rows<{payload:string}>('SELECT payload FROM authority_drain_accounts WHERE drain=? AND account=?',id,account)[0];if(prior&&JSON.parse(prior.payload).ready)continue;if(attempts++>=limit)break;
   const report=await this.send('probe_drain',account,request as unknown as Json) as unknown as AccountDrainReport;
   if(!report||canonical(Object.keys(report).sort())!==canonical(['account','blockers','challenge','epoch','generation','id','ready','schema',...(Object.hasOwn(report,'humanSettlements')?['humanSettlements']:[])].sort())||report.schema!==1||report.account!==account||canonical(drainRequest({id:report.id,generation:report.generation,epoch:report.epoch,challenge:report.challenge}))!==canonical(request)||typeof report.ready!=='boolean'||!report.blockers||Object.getPrototypeOf(report.blockers)!==Object.prototype||Object.keys(report.blockers).sort().join(',')!=='jobs,missingInbox,missingReceipts,mutations,progress,receipts,running,staleProgress,steps')conflict();if(report.humanSettlements!==undefined){revision(report.humanSettlements);if(report.humanSettlements<1)conflict();}for(const n of Object.values(report.blockers))revision(n);if(report.ready!==Object.values(report.blockers).every(n=>n===0))conflict();
   this.db.transaction(()=>{this.barrier(row);if(!['probing','ready'].includes(this.row(id).state))conflict();this.db.rows('INSERT INTO authority_drain_accounts(drain,account,payload) VALUES (?,?,?) ON CONFLICT(drain,account) DO UPDATE SET payload=excluded.payload',id,account,canonical(report));});
  }
  this.db.transaction(()=>{this.barrier(row);const reports=this.db.rows<{payload:string}>('SELECT payload FROM authority_drain_accounts WHERE drain=?',id);if(reports.length===accounts.length&&reports.every(r=>JSON.parse(r.payload).ready))this.db.rows("UPDATE authority_drains SET state='ready' WHERE id=?",id);});return this.inspect(id);
 }
 /** SAME-DB activation participant. The source's capture-time basis must equal the
  * certified maintained authority, including revoked credential revisions. */
 assertReadyInTransaction(id:string,source:AuthorityBasis):void {const row=this.row(id);if(row.state!=='ready'||canonical(validateAuthorityBasis(source))!==row.basis)conflict();this.barrier(row);const accounts=JSON.parse(row.accounts) as string[],reports=this.db.rows<{account:string;payload:string;released:number}>('SELECT account,payload,released FROM authority_drain_accounts WHERE drain=? ORDER BY account',id);if(canonical(reports.map(r=>r.account))!==canonical(accounts)||reports.some(r=>r.released||!JSON.parse(r.payload).ready))conflict();}
 consumeInTransaction(id:string,source:AuthorityBasis):void {this.assertReadyInTransaction(id,source);this.db.rows("UPDATE authority_drains SET state='consumed' WHERE id=?",id);}
 /** Explicit unwind for the SAME maintained generation, never silently unseals an
  * activated/consumed old generation. All rows remain as audit evidence. */
 async release(id:string):Promise<Json>{const row=this.row(id);if(!['probing','ready','releasing','released'].includes(row.state))conflict();const meta=this.config.status();if(!meta.maintenance||meta.generation!==row.generation)conflict();this.db.rows("UPDATE authority_drains SET state='releasing' WHERE id=?",id);for(const account of JSON.parse(row.accounts) as string[]){const saved=this.db.rows<{released:number}>('SELECT released FROM authority_drain_accounts WHERE drain=? AND account=?',id,account)[0];if(saved?.released)continue;
   // A lost probe ACK may have sealed this account without a saved report.
   const result=await this.send('release_drain',account,this.request(row) as unknown as Json) as any;if(!result?.released)conflict();this.db.rows('INSERT INTO authority_drain_accounts VALUES (?,?,?,1) ON CONFLICT(drain,account) DO UPDATE SET released=1',id,account,canonical({ready:false}));}
  this.db.rows("UPDATE authority_drains SET state='released' WHERE id=?",id);return this.inspect(id);
 }
}
