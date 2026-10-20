import {BusinessAdmission} from './business-admission';
import {shape} from './business-command';
import type {SqlDatabase} from './config-store';
import {DeploymentLedger} from './deployment-ledger';
import {canonical,identifier,sha256,ReliabilityError,type Json} from './protocol';
import {TaskDispatch} from './task-dispatch';
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
/** Installation-owned task reads, including Cron. No taskId grants access and no
 * snapshot, executable intent, permit, credential or raw provider body is exposed. */
export class TaskCatalog {
 private readonly secret:Uint8Array;
 constructor(private readonly db:SqlDatabase,private readonly dispatch:TaskDispatch,private readonly admission:Pick<BusinessAdmission<any>,'ownerForCatalog'>,secret:Uint8Array,private readonly automationOwner='manager') {if(secret.length<32)invalid();this.secret=secret.slice();}
 private async mac(scope:string,position:number):Promise<string>{const key=await crypto.subtle.importKey('raw',this.secret as Uint8Array<ArrayBuffer>,{name:'HMAC',hash:'SHA-256'},false,['sign']);const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(canonical(['cfauto-task-catalog-v1',scope,position])));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
 private owned(id:string,owner:string,scope:string):boolean{return this.db.rows('SELECT id FROM dispatch_tasks t WHERE id=? AND (EXISTS (SELECT 1 FROM business_admissions b WHERE b.task=t.id AND b.owner=?) OR (?=1 AND EXISTS (SELECT 1 FROM automation_lanes a WHERE a.task=t.id)))',id,owner,Number(scope===this.automationOwner)).length===1;}
 private snapshot(id:string):Record<string,Json>{
  const targets=this.dispatch.inspect(id).map(target=>{
   const row=this.db.rows<{steps:string}>('SELECT steps FROM dispatch_outbox WHERE task=? AND account=?',id,target.account)[0];
   const steps=(JSON.parse(row.steps) as string[]).map((kind,ordinal)=>{
    const state=this.db.rows<{state:string}>('SELECT state FROM business_step_state WHERE task=? AND account=? AND ordinal=?',id,target.account,ordinal)[0]?.state??'pending';
    const payload=this.db.rows<{payload:string}>('SELECT payload FROM business_facts WHERE task=? AND account=? AND ordinal=? AND state=? ORDER BY seq DESC LIMIT 1',id,target.account,ordinal,state)[0]?.payload;
    const fact=payload?JSON.parse(payload):null,result=fact?.result;
    // Facts were validated at ingress. Re-project only explicitly safe fields.
    const safe:Record<string,Json>={};
    if(result&&typeof result==='object'){
     if(typeof result.worker==='string'&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(result.worker))safe.worker=result.worker;
        if(['PROVIDER_REJECTED','RESOURCE_CONFLICT','PROVIDER_STATE_ABSENT','NO_MUTATION_RECORDED','ROTATION_NOT_APPLIED'].includes(result.code))safe.code=result.code;
     if(result.code==='OPERATOR_CLOSED_UNCONFIRMED'){if(state!=='failed'||typeof result.adjudication!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(result.adjudication))throw new ReliabilityError('NOT_READY',503);safe.code=result.code;safe.adjudication=result.adjudication;safe.settlement='operator_attested';safe.machineVerified=false;safe.externalSuccessClaimed=false;}
     for(const field of ['scriptVerified','bindingsVerified','bindingsAccepted','domainsVerified','subdomainVerified','confirmed'])if(result[field]===true)safe[field]=true;
     if(['deleted','retained_shared'].includes(result.disposition))safe.disposition=result.disposition;
    }
    return {ordinal,kind,state,result:Object.keys(safe).length?safe:null};
   });
   return {...target,cancellationRequested:this.dispatch.cancelRequested(id,target.account),steps};
  });
  const allTerminal=targets.length>0&&targets.every(t=>t.state==='terminal'),unknown=targets.some(t=>t.steps.some(s=>s.state==='unknown'));
  const success=targets.some(t=>t.outcome==='succeeded'||t.steps.some(s=>s.state==='verified'));
  const failed=targets.some(t=>['failed','partial_failed'].includes(t.outcome??''));
  const state=unknown?'needs_review':allTerminal?(targets.every(t=>t.outcome==='succeeded')?'succeeded':failed?(success?'partial_failed':'failed'):(success?'partial_cancelled':'cancelled')):targets.some(t=>t.state!=='pending')?'running':'queued';
  const automation=this.db.rows<{cycle:string;template:string;state:string;notice:string|null}>('SELECT cycle,template,state,notice FROM automation_lanes WHERE task=?',id)[0];
  // Notification delivery is independent of terminal deployment success. Never
  // expose sealed webhook URL/payload or turn unknown delivery into success.
  const notification=automation?(automation.state==='notification_unknown'?'unknown':automation.state==='notification_rejected'?'rejected':automation.state==='notification_unsupported'?'unsupported':allTerminal&&['failed','partial_failed','cancelled','partial_cancelled'].includes(state)?'not_sent':automation.state==='succeeded'?(automation.notice?'delivered':'not_requested'):'pending'):null;
  const humanSettlements=targets.reduce((n,target)=>n+target.steps.filter(step=>step.result?.code==='OPERATOR_CLOSED_UNCONFIRMED').length,0);
  return {id,state,terminal:allTerminal,...(humanSettlements?{humanSettlements}:{}),trigger:automation?'automation':'manual',...(automation?{cycle:automation.cycle,template:automation.template,automationState:automation.state,notification}:{}),targets:targets as unknown as Json,deployments:new DeploymentLedger(this.db).inspectTask(id)};
 }
 async inspect(scope:string,id:string):Promise<Json>{identifier(scope);identifier(id);const owner=await this.admission.ownerForCatalog(scope);const value=this.db.transaction(()=>{if(!this.owned(id,owner,scope))throw new ReliabilityError('NOT_READY',404);return this.snapshot(id);});return {...value,revision:await sha256(canonical(value))};}
 async list(scope:string,input:unknown):Promise<Json>{
  identifier(scope);shape(input,'limit,cursor');const limit=input.limit,cursor=input.cursor;
  if(!Number.isSafeInteger(limit)||limit<1||limit>50||(cursor!==null&&typeof cursor!=='string'))return invalid();
  let before=Number.MAX_SAFE_INTEGER;
  if(cursor!==null){const match=/^v2\.([1-9][0-9]{0,15})\.([a-f0-9]{64})$/.exec(cursor);if(!match||!Number.isSafeInteger(Number(match[1]))||match[2]!==await this.mac(scope,Number(match[1])))return invalid();before=Number(match[1]);}
  const owner=await this.admission.ownerForCatalog(scope);
  const rows=this.db.transaction(()=>this.db.rows<{position:number;id:string}>('SELECT t.rowid AS position,t.id FROM dispatch_tasks t WHERE t.rowid<? AND (EXISTS (SELECT 1 FROM business_admissions b WHERE b.task=t.id AND b.owner=?) OR (?=1 AND EXISTS (SELECT 1 FROM automation_lanes a WHERE a.task=t.id))) ORDER BY t.rowid DESC LIMIT ?',before,owner,Number(scope===this.automationOwner),limit+1).map(row=>({...row,value:this.snapshot(row.id)})));
  const page=rows.slice(0,limit),last=page.at(-1)?.position;
  return {items:page.map(row=>row.value),cursor:rows.length>limit&&last!==undefined?'v2.'+last+'.'+await this.mac(scope,last):null};
 }
}
