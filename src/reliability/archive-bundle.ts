import {verifyAdjudicationRecords} from './adjudication-fact';
import {AuthorityArchive} from './authority-archive';
import {archiveGenerationSource} from './archive-generation-source';
import {validateAuthorityBasis} from './authority-basis';
import {drainRequest} from './account-drain';
import {accountId} from './business-command';
import {canonical,identifier,sha256,ReliabilityError} from './protocol';
export interface BundleArchiveSource {archive:AuthorityArchive;id:string}
type Snapshot=Awaited<ReturnType<AuthorityArchive['snapshot']>>;
const reject=():never=>{throw new ReliabilityError('CONFLICT',409);};
function parse(raw:unknown):any {if(typeof raw!=='string')return reject();try{return JSON.parse(raw);}catch{return reject();}}
function rows(snapshot:Snapshot,name:string,required=true):Record<string,any>[] {
 const spec=snapshot.manifest.tables.find(t=>t.name===name);if(!spec){if(required)reject();return [];}
 return snapshot.pages.filter(p=>p.table===name).flatMap(p=>p.rows.map(r=>Object.fromEntries(p.columns.map((c,i)=>[c,r.values[i]]))));
}
function one(values:Record<string,any>[]):Record<string,any>{if(values.length!==1)reject();return values[0];}
function globalQuiet(snapshot:Snapshot):void {
 const checks:[string,(r:Record<string,any>)=>boolean][]=[
 ['dispatch_outbox',r=>r.state!=='terminal'],['business_admissions',r=>r.task===null],['deployment_runs',r=>r.finished===null],['business_step_state',r=>r.state==='unknown'],
 ['automation_flows',r=>!['complete','planning_failed'].includes(r.state)],['webhook_outbox',r=>!['delivered','rejected'].includes(r.state)],['dispatch_cancellations',r=>r.acknowledged!==1],['dispatch_wakeups',r=>r.acknowledged!==1]];
 for(const [table,blocked] of checks)if(rows(snapshot,table,table==='dispatch_outbox').some(blocked))reject();
}
async function accountQuiet(snapshot:Snapshot,source:BundleArchiveSource):Promise<number> {
 const jobs=rows(snapshot,'account_jobs'),steps=rows(snapshot,'account_steps'),receipts=rows(snapshot,'account_receipts'),inbox=rows(snapshot,'coordinator_inbox'),acks=rows(snapshot,'coordinator_receipts'),progress=rows(snapshot,'coordinator_progress');
 if(jobs.some(j=>!['succeeded','failed','partial_failed','cancelled','partial_cancelled'].includes(j.state))||steps.some(s=>!['verified','failed','skipped'].includes(s.state))||acks.some(r=>r.acknowledged!==1)||progress.some(r=>r.acknowledged!==1))reject();
 const mutations=rows(snapshot,'execution_calls',false).filter(c=>c.mutation===1&&c.state!=='done'),decisions=rows(snapshot,'unknown_adjudications',false),attestations=rows(snapshot,'unknown_attestations',false);
 for(const call of mutations){const d=one(decisions.filter(d=>call.job===d.job+'_'+d.step&&call.ordinal===d.call));await verifyAdjudicationRecords({decision:d,attestation:one(attestations.filter(a=>a.id===d.attestation)),step:one(steps.filter(s=>s.job===d.job&&s.ordinal===d.step)),call,inbox:one(inbox.filter(i=>i.task===d.job)).delivery},async context=>(await source.archive.archivedObject(source.id,context)).value,snapshot.manifest.role.role==='account'?snapshot.manifest.role.account:reject(),d.job,d.step,d.evidence);}
 for(const job of jobs){if(!inbox.some(r=>r.task===job.id)||!acks.some(r=>r.task===job.id))reject();const p=one(progress.filter(r=>r.task===job.id)),seq=receipts.filter(r=>r.job===job.id).reduce((n,r)=>Math.max(n,r.seq),0);if(p.version!==seq||p.cancel_requested!==job.cancel_requested)reject();}
 return mutations.length;
}

function crossObjectReceipts(global:Snapshot,part:Snapshot,account:string):void {
 const dispatch=rows(global,'dispatch_outbox').filter(r=>r.account===account),jobs=rows(part,'account_jobs'),inbox=rows(part,'coordinator_inbox'),receipts=rows(part,'coordinator_receipts');
 const ids=(values:Record<string,any>[],key:string)=>values.map(r=>r[key]).sort();
 if(canonical(ids(dispatch,'task'))!==canonical(ids(jobs,'id'))||canonical(ids(dispatch,'task'))!==canonical(ids(inbox,'task'))||canonical(ids(dispatch,'task'))!==canonical(ids(receipts,'task')))reject();
 for(const d of dispatch){const job=one(jobs.filter(j=>j.id===d.task)),delivery=parse(one(inbox.filter(r=>r.task===d.task)).delivery),receipt=parse(one(receipts.filter(r=>r.task===d.task)).payload);
  if(delivery.task!==d.task||delivery.account!==account||delivery.token!==d.token||delivery.snapshot!==d.snapshot||delivery.digest!==d.digest||canonical(delivery.steps)!==canonical(parse(d.steps))||job.digest!==d.digest||job.snapshot!==d.snapshot||job.state!==d.outcome||receipt.outcome!==d.outcome||receipt.evidence!==d.evidence)reject();
  const permit={task:delivery.task,account:delivery.account,token:delivery.token,snapshot:delivery.snapshot,generation:delivery.generation,credentialRevision:delivery.credentialRevision};
  if(canonical(receipt.permit)!==canonical(permit))reject();
 }
}
async function reference(source:BundleArchiveSource,snapshot:Snapshot){const root=await source.archive.rootPacket(source.id);return {id:source.id,root:root.object.id,digest:root.object.digest,proof:root.proof,keyId:root.object.key_id,pages:snapshot.manifest.pages.length,capturedAt:snapshot.manifest.capturedAt};}
/** Internal read-only assembler over authenticated complete archives. Callers supply
 * archive stores, never plaintext snapshots or downloaded SQL. No RPC, operation
 * grants, queue restoration, live unsealing or activation is performed here.
 * A historical consistent capture is NOT proof of CURRENT drain or legacy cutover.
 * The maintenance orchestrator must separately persist/authorize collection and
 * revalidate live authority/fences before any use as an activation prerequisite. */
export async function verifyArchiveBundle(global:BundleArchiveSource,drainId:string,accountSources:BundleArchiveSource[]){
 identifier(global.id);identifier(drainId);if(!Array.isArray(accountSources)||accountSources.length>10000)reject();
 // Copy the reference list before the first await; a caller cannot swap a part
 // halfway through verification. Each AuthorityArchive enforces immutable IDs.
 const sources=accountSources.map(s=>{identifier(s.id);return {archive:s.archive,id:s.id};}),globalSource={archive:global.archive,id:global.id};
 const snapshot=await globalSource.archive.snapshot(globalSource.id),m=snapshot.manifest;
 if(m.role.role!=='global'||m.maintenance!==true)reject();
 const source=await archiveGenerationSource(globalSource.archive,globalSource.id),basis=validateAuthorityBasis(source.sourceBasis);
 const drain=one(rows(snapshot,'authority_drains').filter(r=>r.id===drainId));
 const request=drainRequest({id:drain.id,generation:drain.generation,epoch:drain.epoch,challenge:drain.challenge});
 if(drain.state!=='ready'||drain.generation!==m.generation||drain.epoch!==m.epoch||canonical(validateAuthorityBasis(parse(drain.basis)))!==canonical(basis))reject();
 const directory=one(rows(snapshot,'config_records').filter(r=>r.generation===m.generation&&r.domain==='accounts')),value=parse(directory.payload);if(!Array.isArray(value))reject();
 const accounts=[...new Set<string>([...value.map((a:any)=>a?.accountId),...rows(snapshot,'dispatch_outbox').map(r=>r.account),...rows(snapshot,'account_archive_registry',false).map(r=>r.account)])];accounts.forEach(accountId);accounts.sort();
 if(canonical(accounts)!==canonical(parse(drain.accounts))||sources.length!==accounts.length)reject();
 const reports=rows(snapshot,'authority_drain_accounts').filter(r=>r.drain===drainId).sort((a,b)=>a.account<b.account?-1:a.account>b.account?1:0);
 if(canonical(reports.map(r=>r.account))!==canonical(accounts)||reports.some(r=>r.released!==0))reject();globalQuiet(snapshot);
 const parts=[];const seen=new Set<string>();
 for(const ref of sources){
  const part=await ref.archive.snapshot(ref.id),pm=part.manifest;if(pm.role.role!=='account'||pm.installation!==m.installation||pm.generation!==m.generation||pm.epoch!==m.epoch)reject();
  const account=pm.role.role==='account'?pm.role.account:reject();if(!accounts.includes(account)||seen.has(account))reject();seen.add(account);
  const report=parse(one(reports.filter(r=>r.account===account)).payload),fence=one(rows(part,'account_drain_fences').filter(r=>r.id===drainId));
  if(canonical(Object.keys(report).sort())!==canonical(['account','blockers','challenge','epoch','generation','id','ready','schema',...(Object.hasOwn(report,'humanSettlements')?['humanSettlements']:[])].sort())||report.schema!==1||report.account!==account||report.ready!==true||canonical(drainRequest({id:report.id,generation:report.generation,epoch:report.epoch,challenge:report.challenge}))!==canonical(request))reject();
  if(!report.blockers||typeof report.blockers!=='object'||Object.keys(report.blockers).sort().join(',')!=='jobs,missingInbox,missingReceipts,mutations,progress,receipts,running,staleProgress,steps'||Object.values(report.blockers).some(n=>n!==0))reject();
  if(fence.state!=='sealed'||canonical(drainRequest({id:fence.id,generation:fence.generation,epoch:fence.epoch,challenge:fence.challenge}))!==canonical(request)||canonical(parse(fence.payload))!==canonical(report))reject();
  const humanSettlements=await accountQuiet(part,ref);if((report.humanSettlements??0)!==humanSettlements)reject();crossObjectReceipts(snapshot,part,account);parts.push({account,...await reference(ref,part),...(humanSettlements?{humanSettlements}: {})});
 }
 parts.sort((a,b)=>a.account<b.account?-1:1);
 const manifest={format:'cfauto.authority-bundle' as const,version:1 as const,installation:m.installation,generation:m.generation,epoch:m.epoch,basis,drain:request,inventoryDigest:await sha256(canonical(accounts)),global:await reference(globalSource,snapshot),accounts:parts,scope:'authority_managed_capture' as const,migrationReady:false as const,legacyDrainProven:false as const,liveDrainProven:false as const};
 return {manifest,digest:await sha256(canonical(manifest))};
}
