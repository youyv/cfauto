import type {SqlDatabase} from './config-store';
import {AccountQueue} from './account-queue';
import {ExecutionJournal} from './execution-journal';
import {SealedStore,type SealedContext} from './sealed-store';
import {parseObservationRequest,unknownReviewBasis,type ObservationRequest} from './unknown-observation';
import {canonical,identifier,sha256,ReliabilityError,type Json} from './protocol';
import {accountId,shape} from './business-command';
export interface SettlementAttestation {id:string;operator:string;observation:ObservationRequest;evidence:string;statement:'provider_confirmed_terminal';reference:string;document:string}
export interface FailureAdjudication {id:string;operator:string;attestation:string;proof:string}
interface Options {digestSecret:string;isExecuting:()=>boolean;authorize:(action:'attest'|'close_failed',operator:string,observation:ObservationRequest,replay:boolean)=>Promise<void>}
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
const copy=<T>(v:T):T=>JSON.parse(canonical(v));
/** TWO distinct independently authorized operator identities: one attests the provider
 * confirmed the original request terminal; the other closes the unverified business
 * step as FAILED. The attachment is an operator assertion, not machine verification.
 * No GET result, timeout or boolean from the browser proves external settlement.
 * Only trusted maintenance wiring may construct this service. No HTTP or executor.
 */
export class UnknownAdjudication {
 constructor(private readonly db:SqlDatabase,private readonly sealed:SealedStore,private readonly queue:AccountQueue,private readonly account:string,private readonly options:Options){accountId(account);if(typeof options.digestSecret!=='string'||options.digestSecret.length<32)invalid();
  db.rows('CREATE TABLE IF NOT EXISTS unknown_attestations (id TEXT PRIMARY KEY,intent TEXT NOT NULL,basis TEXT NOT NULL,operator TEXT NOT NULL,artifact TEXT NOT NULL,proof TEXT NOT NULL,summary TEXT NOT NULL)');
  db.rows('CREATE TABLE IF NOT EXISTS unknown_adjudications (id TEXT PRIMARY KEY,intent TEXT NOT NULL,attestation TEXT NOT NULL,operator TEXT NOT NULL,job TEXT NOT NULL,step INTEGER NOT NULL,call INTEGER NOT NULL,digest TEXT NOT NULL,step_token TEXT NOT NULL,evidence TEXT NOT NULL,summary TEXT NOT NULL,UNIQUE(job,step,call))');
 }
 private context(id:string,generation:string):SealedContext{return {id:'adjudication_'+id,kind:'artifact',account:this.account,generation};}
 private basis(r:ObservationRequest){return unknownReviewBasis(this.db,this.account,r,this.options.isExecuting);}
 private async proof(v:unknown){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(this.options.digestSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(canonical(['cfauto-human-adjudication-v1',v])))),b=>b.toString(16).padStart(2,'0')).join('');}
 private async guard(action:'attest'|'close_failed',operator:string,r:ObservationRequest,basis:string){if(this.basis(r)!==basis)conflict();await this.options.authorize(action,operator,copy(r),false);if(this.basis(r)!==basis)conflict();}
 async attest(raw:SettlementAttestation):Promise<Json>{const a=copy(raw);shape(a,'id,operator,observation,evidence,statement,reference,document');identifier(a.id);identifier(a.operator);if(a.id.length>60)invalid();a.observation=parseObservationRequest(a.observation);if(a.observation.permit.account!==this.account||typeof a.evidence!=='string'||!/^[a-f0-9]{64}$/.test(a.evidence)||a.statement!=='provider_confirmed_terminal'||typeof a.reference!=='string'||a.reference.length<1||a.reference.length>200||typeof a.document!=='string'||new TextEncoder().encode(a.document).length<32||new TextEncoder().encode(a.document).length>4096)invalid();
  const intent=await this.proof(a),basis=this.basis(a.observation);await this.guard('attest',a.operator,a.observation,basis);const previous=this.db.rows<Record<string,any>>('SELECT * FROM unknown_attestations WHERE id=?',a.id)[0];if(previous){if(previous.intent!==intent||previous.basis!==basis)conflict();const saved=await this.sealed.get(this.context(a.id,a.observation.permit.generation)) as any;if(canonical(saved.attestation)!==canonical(a)||saved.basis!==basis||saved.proof!==previous.proof||canonical(saved.summary)!==previous.summary)conflict();await this.guard('attest',a.operator,a.observation,basis);return saved.summary;}
  const observation=this.db.rows<Record<string,any>>('SELECT * FROM unknown_observations WHERE id=?',a.observation.id)[0];if(!observation||observation.state!=='complete'||observation.intent!==canonical(a.observation)||observation.basis!==basis)conflict();const root=await this.sealed.get({id:'observation_'+a.observation.id,kind:'artifact',account:this.account,generation:a.observation.permit.generation}) as any;if(root.intent!==observation.intent||root.basis!==basis||canonical(root.summary)!==observation.summary||root.summary.evidence!==a.evidence||root.summary.possibleInFlight!==true||root.summary.settled!==false)conflict();
  const journal=new ExecutionJournal(this.db,this.sealed,{job:a.observation.permit.task+'_'+a.observation.step,account:this.account,generation:a.observation.permit.generation},{digestSecret:this.options.digestSecret,transport:async()=>invalid(),authorizeMutation:async()=>invalid()}),call=await journal.readCallEvidence(a.observation.call);if(!call.mutation)conflict();
  const proof=await this.proof({intent,basis,callDigest:call.digest}),summary={id:a.id,operator:a.operator,task:a.observation.permit.task,account:this.account,generation:a.observation.permit.generation,epoch:a.observation.epoch,accountsRevision:a.observation.accountsRevision,step:a.observation.step,call:a.observation.call,observation:a.observation.id,callDigest:call.digest,proof,documentDigest:await sha256(a.document),settlement:'operator_attested',machineVerified:false,approved:false,possibleInFlight:true};
  await this.guard('attest',a.operator,a.observation,basis);await this.sealed.put(this.context(a.id,a.observation.permit.generation),{attestation:a,intent,basis,proof,summary} as unknown as Json);await this.guard('attest',a.operator,a.observation,basis);
  this.db.transaction(()=>{if(this.basis(a.observation)!==basis)conflict();const old=this.db.rows<Record<string,any>>('SELECT * FROM unknown_attestations WHERE id=?',a.id)[0];if(old){if(old.intent!==intent||old.proof!==proof||old.basis!==basis)conflict();}else this.db.rows('INSERT INTO unknown_attestations VALUES (?,?,?,?,?,?,?)',a.id,intent,basis,a.operator,this.context(a.id,a.observation.permit.generation).id,proof,canonical(summary));});return summary;
 }
 async closeFailed(raw:FailureAdjudication):Promise<Json>{const a=copy(raw);shape(a,'id,operator,attestation,proof');for(const key of ['id','operator','attestation'] as const)identifier(a[key]);if(a.id.length>60||typeof a.proof!=='string'||!/^[a-f0-9]{64}$/.test(a.proof))invalid();const att=this.db.rows<Record<string,any>>('SELECT * FROM unknown_attestations WHERE id=?',a.attestation)[0];if(!att||att.proof!==a.proof||att.operator===a.operator)conflict();const stored=JSON.parse(att.basis),generation=stored.delivery.generation,packet=await this.sealed.get(this.context(a.attestation,generation)) as any;
  if(packet.attestation.operator!==att.operator||packet.summary.operator!==att.operator||att.artifact!==this.context(a.attestation,generation).id||packet.intent!==att.intent||packet.basis!==att.basis||packet.proof!==a.proof||canonical(packet.summary)!==att.summary||await this.proof(packet.attestation)!==att.intent)conflict();const r=parseObservationRequest(packet.attestation.observation),intent=await this.proof(a),old=this.db.rows<Record<string,any>>('SELECT * FROM unknown_adjudications WHERE id=?',a.id)[0];
  if(old){if(old.intent!==intent||old.attestation!==a.attestation||old.operator!==a.operator)conflict();await this.options.authorize('close_failed',a.operator,copy(r),true);const saved=await this.sealed.get(this.context(a.id,generation)) as any;if(saved.intent!==intent||canonical(saved.summary)!==old.summary||saved.summary.evidence!==old.evidence)conflict();return saved.summary;}
  const basis=this.basis(r);if(basis!==att.basis)conflict();await this.guard('close_failed',a.operator,r,basis);
  // Only ONE still-unknown mutation is supported. Never silently settle another
  // call or overwrite an original sealed execution result/response.
  const unresolved=this.db.rows<Record<string,any>>("SELECT * FROM execution_calls WHERE job=? AND mutation=1 AND state!='done'",r.permit.task+'_'+r.step);if(unresolved.length!==1||unresolved[0].ordinal!==r.call||unresolved[0].digest!==packet.summary.callDigest)conflict();
  if(this.db.rows('SELECT id FROM sealed_objects WHERE id IN (?,?)','result_'+r.permit.task+'_'+r.step,'response_'+r.permit.task+'_'+r.step+'_'+r.call).length)conflict();
  const evidence=await this.proof({intent,basis,attestation:a.attestation,proof:a.proof}),summary={id:a.id,operator:a.operator,attestor:att.operator,task:r.permit.task,account:this.account,generation:r.permit.generation,epoch:r.epoch,accountsRevision:r.accountsRevision,step:r.step,call:r.call,attestation:a.attestation,evidence,outcome:'failed',code:'OPERATOR_CLOSED_UNCONFIRMED',settlement:'operator_attested',machineVerified:false,externalSuccessClaimed:false};
  await this.sealed.put(this.context(a.id,generation),{intent,basis,summary});await this.guard('close_failed',a.operator,r,basis);
  // Keep this distinct from executor-produced result_<task>_<step>; the production
  // progress adapter must use the authenticated adjudication receipt, never invent
  // PROVIDER_REJECTED or a verified effect. No result is installed for the executor.
  this.queue.reconcile(r.permit.task,r.step,stored.step.token,'failed',evidence,()=>{if(this.options.isExecuting())conflict();const found=this.db.rows<Record<string,any>>('SELECT * FROM unknown_adjudications WHERE id=?',a.id)[0];if(found)conflict();this.db.rows('INSERT INTO unknown_adjudications VALUES (?,?,?,?,?,?,?,?,?,?,?)',a.id,intent,a.attestation,a.operator,r.permit.task,r.step,r.call,unresolved[0].digest,stored.step.token,evidence,canonical(summary));},()=>{if(this.basis(r)!==basis)conflict();});return summary;
 }
}
