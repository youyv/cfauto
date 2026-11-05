import type {SqlDatabase} from './config-store';
import {SealedStore,type SealedContext} from './sealed-store';
import {parseObservationRequest} from './unknown-observation';
import {canonical,ReliabilityError,type Json} from './protocol';
export interface VerifiedAdjudication {fact:Json;job:string;ordinal:number;digest:string;decision:string;attestation:string;task:string;step:number;guard:string}
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
/** Read a prior committed human failure, not a new authorization. This reader never
 * executes the original operation or discards its unknown journal. */
export interface AdjudicationRecords {decision:Record<string,any>;attestation:Record<string,any>|undefined;step:Record<string,any>|undefined;call:Record<string,any>|undefined;inbox:string|undefined}
export async function verifyAdjudicationRecords(records:AdjudicationRecords,open:(context:SealedContext)=>Promise<Json>,account:string,task:string,ordinal:number,evidence:string|null):Promise<VerifiedAdjudication>{
 const d=records.decision,index=JSON.parse(d.summary),generation=index.generation;
 const value=await open({id:'adjudication_'+d.id,kind:'artifact',account,generation}) as any;
 if(value.intent!==d.intent||canonical(value.summary)!==d.summary||d.evidence!==evidence||value.summary.evidence!==evidence||value.summary.task!==task||value.summary.account!==account||value.summary.step!==ordinal||value.summary.call!==d.call||value.summary.operator!==d.operator||value.summary.attestation!==d.attestation||value.summary.outcome!=='failed'||value.summary.code!=='OPERATOR_CLOSED_UNCONFIRMED'||value.summary.settlement!=='operator_attested'||value.summary.machineVerified!==false||value.summary.externalSuccessClaimed!==false)conflict();
 const att=records.attestation;if(!att||att.operator===d.operator)return conflict();const a=await open({id:'adjudication_'+att.id,kind:'artifact',account,generation}) as any;
 if(att.artifact!=='adjudication_'+att.id||a.intent!==att.intent||a.basis!==att.basis||a.proof!==att.proof||canonical(a.summary)!==att.summary||a.attestation.operator!==att.operator||a.summary.operator!==att.operator||value.summary.attestor!==att.operator||value.basis!==a.basis||a.summary.callDigest!==d.digest||a.attestation.statement!=='provider_confirmed_terminal')conflict();
 const r=parseObservationRequest(a.attestation.observation);if(r.permit.task!==task||r.permit.account!==account||r.permit.generation!==generation||r.step!==ordinal||r.call!==d.call)conflict();const original=JSON.parse(a.basis);if(original.step.token!==d.step_token||original.call.digest!==d.digest||(!records.inbox||canonical(original.delivery)!==canonical(JSON.parse(records.inbox))))conflict();
 const step=records.step,call=records.call;
 if(!step||step.state!=='failed'||step.token!==d.step_token||step.evidence!==evidence||step.kind!==original.step.kind||!call||call.mutation!==1||!['unknown','in_flight'].includes(call.state)||call.digest!==d.digest)return conflict();
 return {fact:{kind:step.kind,code:'OPERATOR_CLOSED_UNCONFIRMED',adjudication:d.id},job:call.job,ordinal:call.ordinal,digest:call.digest,decision:d.id,attestation:att.id,task,step:ordinal,guard:canonical([d,att,step,call].map(r=>({...r})))};
}
export async function readAdjudicationFact(db:SqlDatabase,sealed:SealedStore,account:string,task:string,ordinal:number,evidence:string|null):Promise<VerifiedAdjudication|null>{
 if(!db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='unknown_adjudications'").length)return null;
 const rows=db.rows<Record<string,any>>('SELECT * FROM unknown_adjudications WHERE job=? AND step=?',task,ordinal);if(!rows.length)return null;if(rows.length!==1)conflict();const d=rows[0];
 const value=await verifyAdjudicationRecords({decision:d,attestation:db.rows('SELECT * FROM unknown_attestations WHERE id=?',d.attestation)[0],step:db.rows('SELECT * FROM account_steps WHERE job=? AND ordinal=?',task,ordinal)[0],call:db.rows('SELECT * FROM execution_calls WHERE job=? AND ordinal=?',task+'_'+ordinal,d.call)[0],inbox:db.rows<{delivery:string}>('SELECT delivery FROM coordinator_inbox WHERE task=?',task)[0]?.delivery},context=>sealed.get(context),account,task,ordinal,evidence);if(!adjudicationGuard(db,value))conflict();return value;
}
/** Synchronous TOCTOU guard used inside the drain transaction after authenticated
 * decryption. A request cannot supply this verified object through the RPC parser. */
export function adjudicationGuard(db:SqlDatabase,v:VerifiedAdjudication):boolean {
 const d=db.rows('SELECT * FROM unknown_adjudications WHERE id=?',v.decision)[0],a=db.rows('SELECT * FROM unknown_attestations WHERE id=?',v.attestation)[0],s=db.rows('SELECT * FROM account_steps WHERE job=? AND ordinal=?',v.task,v.step)[0],c=db.rows('SELECT * FROM execution_calls WHERE job=? AND ordinal=?',v.job,v.ordinal)[0];return !!d&&!!a&&!!s&&!!c&&canonical([d,a,s,c].map(r=>({...r})))===v.guard;
}
