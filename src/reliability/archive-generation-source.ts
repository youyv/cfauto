import {expandBusinessSources} from './shared-source';
import {validateAuthorityBasis} from './authority-basis';
import {AuthorityArchive} from './authority-archive';
import {completeGenerationDomains,type GenerationData,type GenerationSource} from './generation-data';
import type {LoadedGenerationSource} from './generation-import';
import {customSourceCode} from './source-artifact';
import {canonical,manifestDigest,sha256,encoded,identifier,revision,ReliabilityError,type ConfigRecord} from './protocol';
function invalid():never{throw new ReliabilityError('INVALID',400);}
function missing():never{throw new ReliabilityError('NOT_READY',503);}
/** Typed projection from a cryptographically verified complete global archive.
 * Downloaded DDL, queue rows and arbitrary properties are NEVER executed or applied.
 * Old generations, queues and snapshots stay in the archive as retained evidence. */
export async function archiveGenerationSource(archive:AuthorityArchive,id:string,resolveCustom?:(generation:string,template:string,digest:string)=>Promise<GenerationSource>):Promise<LoadedGenerationSource>{
 const snapshot=await archive.snapshot(id),manifest=snapshot.manifest;
 if(manifest.role.role!=='global')invalid();
 const table=(name:string,columns?:string[],required=true):Record<string,any>[]=>{
  const spec=manifest.tables.find(t=>t.name===name);if(!spec){if(required)missing();return [];}
  if(columns&&canonical([...spec.columns].sort())!==canonical([...columns].sort()))invalid();
  return snapshot.pages.filter(p=>p.table===name).flatMap(p=>p.rows.map(row=>Object.fromEntries(p.columns.map((key,i)=>[key,row.values[i]]))));
 };
 const metas=table('config_meta',['id','generation','maintenance','epoch']);if(metas.length!==1||metas[0].id!==1||metas[0].generation!==manifest.generation||metas[0].epoch!==manifest.epoch||![0,1].includes(metas[0].maintenance))invalid();
 const generations=table('config_generations',['id','digest','count','state']).filter(g=>g.id===manifest.generation);if(generations.length!==1||generations[0].state!=='active')invalid();
 const records:ConfigRecord[]=table('config_records',['generation','domain','revision','payload']).filter(row=>row.generation===manifest.generation).map(row=>{if(typeof row.domain!=='string'||typeof row.payload!=='string')invalid();revision(row.revision);let value;try{value=JSON.parse(row.payload);}catch{return invalid();}encoded(value);return {domain:row.domain,revision:row.revision,value};});
 if(!records.some(r=>r.domain==='accounts')||new Set(records.map(r=>r.domain)).size!==records.length)invalid();
 const runtimeRows=table('runtime_records',['domain','revision','payload']);if(runtimeRows.length>1||runtimeRows.some(r=>r.domain!=='automation'||typeof r.payload!=='string'))invalid();
 const runtime={revision:0,value:{}};if(runtimeRows.length){revision(runtimeRows[0].revision);runtime.revision=runtimeRows[0].revision;try{runtime.value=JSON.parse(runtimeRows[0].payload);}catch{return invalid();}}
 const policy=table('credential_policy',['generation','observation_until']).filter(row=>row.generation===manifest.generation);if(policy.length!==1)missing();revision(policy[0].observation_until);
 const revocations=table('credential_revocations',['generation','account','revision']).filter(row=>row.generation===manifest.generation).map(row=>({account:row.account,revision:row.revision}));
 const data:GenerationData={schema:1,records:completeGenerationDomains(records),runtime,credentialPolicy:{observationUntil:policy[0].observation_until,revocations}};
 const dispatch=table('dispatch_outbox',undefined,false).filter(row=>row.state!=='terminal').length;
 const admissions=table('business_admissions',undefined,false).filter(row=>row.task===null).length;
 const automation=table('automation_flows',undefined,false).filter(row=>!['complete','planning_failed'].includes(row.state)).length;
 const notices=table('webhook_outbox',undefined,false).filter(row=>!['delivered','rejected'].includes(row.state)).length;
 const root=await archive.rootPacket(id);identifier(manifest.generation);
 const identityRows=table('authority_identity',['id','identity']);if(identityRows.length!==1||identityRows[0].id!==1)invalid();
 const sourceRecordsDigest=await manifestDigest(records);
 const sourceBasis=validateAuthorityBasis({storeIdentity:identityRows[0].identity,generation:manifest.generation,epoch:manifest.epoch,maintenance:metas[0].maintenance,watermark:table('config_outbox',['id','generation','domain','revision','acknowledged']).reduce((max,r)=>Math.max(max,r.id),0),revisions:records.map(r=>({domain:r.domain,revision:r.revision})).sort((a,b)=>a.domain<b.domain?-1:1),runtime:runtimeRows.map(r=>({domain:r.domain,revision:r.revision})),policy,revocations:revocations.sort((a,b)=>a.account<b.account?-1:a.account>b.account?1:a.revision-b.revision)});
 const retainedCustom=async(template:string,digest:string):Promise<GenerationSource>=>{
  // Reconstruct from a proven successful full run, never a partial/unknown intent,
  // arbitrary pinned bytes, or a live object created after this archive.
  const runs=table('deployment_runs',undefined,false).filter(r=>r.generation===manifest.generation&&r.template===template&&r.scope==='full'&&r.status==='succeeded'&&r.finished!==null).sort((a,b)=>b.seq-a.seq);
  let chosen:Record<string,any>|undefined,plan:any;
  for(const r of runs){try{const payload=JSON.parse(r.payload),result=JSON.parse(r.result);if(payload.customSha===digest&&result.advanced===true){chosen=r;plan=payload;break;}}catch{invalid();}}
  if(!chosen){
   const pins=table('generation_source_pins',undefined,false).filter(p=>p.generation===manifest.generation&&p.template===template&&p.digest===digest);if(pins.length!==1)missing();const pin=pins[0];
   const imports=table('generation_imports',undefined,false).filter(r=>r.id===pin.import_id&&r.target===manifest.generation&&r.prepared===pin.preparation&&['verified','activated'].includes(r.state));if(imports.length!==1)missing();
   const opened=await archive.archivedObject(id,{id:pin.preparation,kind:'artifact',account:'migration',generation:manifest.generation}),prepared=opened.value as any;
   if(prepared?.schema!==1||prepared.requestDigest!==imports[0].digest||prepared.sourceIdentity!==pin.source_identity||!Array.isArray(prepared.data?.customSources))missing();
   const sources=prepared.data.customSources.filter((s:any)=>s.artifact?.template===template&&s.artifact?.digest===digest);if(sources.length!==1||canonical(sources[0].provenance)!==pin.provenance)missing();return sources[0]; // Caller rechecks complete artifact shape/hash/provenance.
  }
  if(plan.template!==template||plan.mode!=='fixed'||plan.sha!==null||plan.customSha!==digest||plan.sourceDigest!==digest||plan.sourceIdentity!==''||!plan.targets?.length)missing();
  const target=plan.targets[0],dispatch=table('dispatch_outbox',undefined,false).filter(r=>r.task===chosen!.task&&r.account===target.account);if(dispatch.length!==1||dispatch[0].state!=='terminal')missing();
  const context={id:dispatch[0].snapshot,kind:'task_snapshot' as const,account:target.account,generation:manifest.generation};
  const opened=await archive.archivedObject(id,context),value=opened.value as any;
  if(value?.schema!==1||value.account!==target.account||value.generation!==manifest.generation||value.operation?.operation?.account!==target.account)missing();
  const command=expandBusinessSources(value.operation.operation).commands?.[target.steps[0]],artifact=command?.artifact;
  if(command?.kind!=='manual_upload'||command.template!==template||command.worker!==target.worker||!artifact||canonical(Object.keys(artifact).sort())!==canonical(['code','digest','kind','template'])||artifact.kind!=='custom'||artifact.template!==template||artifact.digest!==digest)missing();
  customSourceCode(artifact.code);if(await sha256(artifact.code)!==digest)missing();
  return {artifact,provenance:{generation:manifest.generation,snapshot:context.id,account:context.account,keyId:opened.keyId,task:chosen.task}};
 };
 return {identity:root.proof,data,sourceBasis,sourceRecordsDigest,blockers:{dispatch,admissions,automation,notices},migrationReady:false,resolveCustom:resolveCustom?(template:string,digest:string)=>resolveCustom(manifest.generation,template,digest):retainedCustom};
}
