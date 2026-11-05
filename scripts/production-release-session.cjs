/* Durable production workflow ordering, NOT an approval authority or transport.
 * Stage-specific trusted verifiers must independently validate original evidence
 * before calling release-journal.verified(). No such shortcut is exposed here.
 * No network, retries, key generation, migration, cleanup or production activation. */
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {TARGET}=require('./production-control-plane.cjs');
const {LEGACY}=require('./production-freeze-metadata.cjs');
const {privateDirectory,assertPrivate}=require('./maintenance-client.cjs');
const {readPrivateBytes}=require('./cutover-evidence.cjs');
const {hash,canonical,privateSave}=require('./cutover-window.cjs');
const {openReleaseJournal}=require('./release-journal.cjs');
const PHASES=Object.freeze(['preflight','freeze_worker','disable_cron','legacy_drain','source_backup','source_package','install_pin','initial_cutover','maintenance_acceptance','resume_authority','restore_cron','online_acceptance']);
const fail=c=>{throw Error(c);},digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function candidateValue(c){if(!c||Object.keys(c).sort().join(',')!=='buildId,sourceSha256,workerBytes,workerSha256'||!digest(c.sourceSha256)||!digest(c.workerSha256)||!Number.isSafeInteger(c.workerBytes)||c.workerBytes<1||c.workerBytes>5*1024*1024||typeof c.buildId!=='string'||c.buildId.length>128||! /^[a-zA-Z0-9.-]+$/.test(c.buildId)||!c.buildId.endsWith('.'+c.sourceSha256.slice(0,12)))fail('SESSION_CANDIDATE_INVALID');return {...c};}
function manifestValue(m){if(!m||Object.keys(m).sort().join(',')!=='candidate,id,kind,legacy,phases,publicationAllowed,schema,target'||m.schema!==1||m.kind!=='production_cutover_session'||! /^prod_release_[a-f0-9]{32}$/.test(m.id)||canonical(m.target)!==canonical(TARGET)||canonical(m.legacy)!==canonical(LEGACY)||canonical(m.phases)!==canonical(PHASES)||m.publicationAllowed!==false)fail('SESSION_MANIFEST_INVALID');return {...m,candidate:candidateValue(m.candidate)};}
async function outputPath(root,directory,existing){root=path.resolve(root);directory=path.resolve(directory);const base=await fs.realpath(path.join(root,'.wrangler')),parent=await fs.realpath(existing?directory:path.dirname(directory)),rel=path.relative(base,parent);if(existing&&rel===''||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||directory===path.join(root,'.wrangler'))fail('SESSION_PATH_ESCAPE');if(existing)await assertPrivate(directory);return directory;}
async function durableSave(directory,name,bytes){await privateSave(directory,name,bytes);const handle=await fs.open(path.join(directory,name),'r+');try{await handle.sync();}finally{await handle.close();}}
async function createProductionSession({root=path.resolve(__dirname,'..'),out,candidate}){
 candidate=candidateValue(candidate);out=await outputPath(root,out,false);await privateDirectory(out);
 const manifest={schema:1,kind:'production_cutover_session',id:'prod_release_'+randomUUID().replace(/-/g,''),target:TARGET,legacy:LEGACY,candidate,phases:PHASES,publicationAllowed:false},bytes=Buffer.from(canonical(manifest));await durableSave(out,'session.json',bytes);
 return {directory:out,id:manifest.id,sessionSha256:hash(bytes),publicationAllowed:false};
}
function candidateAmendmentValue(a,sessionSha256,original){
 if(!a||Object.keys(a).sort().join(',')!=='candidate,kind,originalCandidate,publicationAllowed,reason,replaySha256,schema,sessionSha256'||a.schema!==1||a.kind!=='pre_dispatch_candidate_amendment'||a.sessionSha256!==sessionSha256||canonical(a.originalCandidate)!==canonical(original)||a.publicationAllowed!==false||a.reason!=='preserve_legacy_statistics_alias'||!digest(a.replaySha256))fail('SESSION_CANDIDATE_AMENDMENT_INVALID');
 const candidate=candidateValue(a.candidate);if(candidate.workerSha256===original.workerSha256||candidate.sourceSha256===original.sourceSha256)fail('SESSION_CANDIDATE_AMENDMENT_NOT_A_CHANGE');return {...a,candidate};
}
async function amendProductionCandidate({root=path.resolve(__dirname,'..'),directory,candidate,validationDir,gateFiles,isolatedUpgradeDir}){
 const session=await openProductionSession({root,directory});let state;try{state=await session.inspect();if(state.candidateAmendmentSha256||state.stages.some(s=>s.state!=='unprepared'))fail('SESSION_AMENDMENT_ONLY_BEFORE_ALL_PHASES');}finally{session.close();}
 candidate=candidateValue(candidate);const proof=await require('./upgrade-chained-isolated.cjs').replayCurrentCandidateEvidence({root,validationDir,gateFiles,isolatedUpgradeDir,expectedCandidate:candidate});
 const proofBytes=Buffer.from(canonical(proof)),record=candidateAmendmentValue({schema:1,kind:'pre_dispatch_candidate_amendment',sessionSha256:state.sessionSha256,originalCandidate:state.candidate,candidate,reason:'preserve_legacy_statistics_alias',replaySha256:hash(proofBytes),publicationAllowed:false},state.sessionSha256,state.candidate);
 // This is an append-only, pre-dispatch plan amendment, not an approval. Neither
 // the original manifest nor any phase ID changes. Preflight must replay anew.
 await durableSave(directory,'candidate-amendment-replay.json',proofBytes);const bytes=Buffer.from(canonical(record));await durableSave(directory,'candidate-amendment.json',bytes);return {id:state.id,sessionSha256:state.sessionSha256,candidateAmendmentSha256:hash(bytes),candidate,publicationAllowed:false};
}
async function openProductionSession({root=path.resolve(__dirname,'..'),directory}){
 directory=await outputPath(root,directory,true);const bytes=await readPrivateBytes(path.join(directory,'session.json'),16384);let manifest;try{manifest=manifestValue(JSON.parse(bytes));}catch{fail('SESSION_MANIFEST_INVALID');}if(canonical(manifest)!==bytes.toString('utf8'))fail('SESSION_MANIFEST_NONCANONICAL');const sessionSha256=hash(bytes),amendmentBytes=await optional('candidate-amendment.json'),amendment=amendmentBytes?candidateAmendmentValue(JSON.parse(amendmentBytes),sessionSha256,manifest.candidate):null,candidate=amendment?.candidate??manifest.candidate,amendmentSha256=amendmentBytes?hash(amendmentBytes):null;
 if(amendment&&(canonical(amendment)!==amendmentBytes.toString('utf8')||hash(await readPrivateBytes(path.join(directory,'candidate-amendment-replay.json'),65536))!==amendment.replaySha256))fail('SESSION_AMENDMENT_REPLAY_CHANGED');
 const journal=await openReleaseJournal(path.join(root,'.wrangler','release-journal-v1'));
 const phaseId=phase=>phase==='freeze_worker'?'prod_freeze_'+hash(canonical([manifest.id,phase])).slice(0,32):'prod_phase_'+hash(canonical([manifest.id,phase])).slice(0,40);
 async function unchanged(){if(hash(await readPrivateBytes(path.join(directory,'session.json'),16384))!==sessionSha256)fail('SESSION_MANIFEST_CHANGED');const current=await optional('candidate-amendment.json');if((current?hash(current):null)!==amendmentSha256)fail('SESSION_CANDIDATE_AMENDMENT_CHANGED');if(amendment&&hash(await readPrivateBytes(path.join(directory,'candidate-amendment-replay.json'),65536))!==amendment.replaySha256)fail('SESSION_AMENDMENT_REPLAY_CHANGED');}
 async function optional(name){try{return await readPrivateBytes(path.join(directory,name),65536);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 function expectedIntent(index,inputSha256,predecessor){return {schema:1,sessionSha256,phase:PHASES[index],index,id:phaseId(PHASES[index]),target:TARGET,candidate,...(amendmentSha256?{candidateAmendmentSha256:amendmentSha256}:{}),inputSha256,predecessor};}
 async function inspect(){await unchanged();const stages=[];let pending=false,previous=null;
  for(let index=0;index<PHASES.length;index++){
   const phase=PHASES[index],id=phaseId(phase),saved=await optional(phase+'.intent.json'),row=journal.inspect(id).operation;let intent=null;
   if(saved){try{intent=JSON.parse(saved);}catch{fail('SESSION_INTENT_INVALID');}if(!digest(intent.inputSha256)||!saved.equals(Buffer.from(canonical(expectedIntent(index,intent.inputSha256,previous)))))fail('SESSION_INTENT_CHANGED');}
   if(row&&(!saved||row.account!==TARGET.account||row.worker!==TARGET.worker||row.kind!=='production_'+phase||row.intent_sha!==hash(saved)))fail('SESSION_JOURNAL_INTENT_MISMATCH');
   if(pending&&(row||saved))fail('SESSION_PHASE_ORDER_CORRUPT');
   if(row?.evidence_sha){const evidence=await optional(phase+'.evidence-'+row.evidence_sha+'.bin');if(!evidence||hash(evidence)!==row.evidence_sha)fail('SESSION_EVIDENCE_MISSING_OR_CHANGED');}
   if(row?.state==='verified')previous={id,evidenceSha256:row.evidence_sha};else pending=true;
   stages.push({phase,id,state:row?.state??(saved?'intent_saved':'unprepared'),inputSha256:intent?.inputSha256??null,evidenceSha256:row?.evidence_sha??null});
  }
  const next=stages.find(s=>s.state!=='verified')??null;
  return {id:manifest.id,sessionSha256,candidate:{...candidate},...(amendmentSha256?{candidateAmendmentSha256:amendmentSha256,originalCandidate:{...manifest.candidate}}:{}),stages,next:next?{...next,action:['dispatching','acknowledged','uncertain'].includes(next.state)?'reconcile_original':next.state==='prepared'?'authorize_then_dispatch':'prepare'}:null,allStageRecordsVerified:next===null,publicationAllowed:false};
 }
 async function current(phase){const s=await inspect();if(s.next?.phase!==phase)fail('SESSION_PHASE_NOT_CURRENT');return s;}
 return {
  directory,journalFile:journal.file,inspect,
  async prepare(phase,inputSha256){if(!digest(inputSha256))fail('SESSION_INPUT_DIGEST_INVALID');const s=await current(phase),index=PHASES.indexOf(phase),prior=index?s.stages[index-1]:null,predecessor=prior?{id:prior.id,evidenceSha256:prior.evidenceSha256}:null,intent=expectedIntent(index,inputSha256,predecessor),raw=Buffer.from(canonical(intent));
   const existing=await optional(phase+'.intent.json');if(existing&&!existing.equals(raw))fail('SESSION_PHASE_INPUT_CONFLICT');
   if(!existing)try{await durableSave(directory,phase+'.intent.json',raw);}catch(e){if(e.code!=='EEXIST')throw e;if(!(await optional(phase+'.intent.json'))?.equals(raw))fail('SESSION_PHASE_INPUT_CONFLICT');}
   const row=journal.reserve({account:TARGET.account,worker:TARGET.worker,id:intent.id,kind:'production_'+phase,intentSha256:hash(raw)},predecessor??undefined);
   return {phase,id:row.id,state:row.state,inputSha256,publicationAllowed:false};
  },
  async dispatch(phase){const s=await current(phase);if(s.next.state!=='prepared')fail('SESSION_ORIGINAL_RECONCILIATION_REQUIRED');const row=journal.dispatch(s.next.id);return {phase,id:row.id,state:row.state,publicationAllowed:false};},
  async record(phase,outcome,evidence){if(!['acknowledged','uncertain'].includes(outcome)||!Buffer.isBuffer(evidence)||!evidence.length||evidence.length>65536)fail('SESSION_OUTCOME_INVALID');const s=await current(phase);if(!['dispatching','acknowledged','uncertain'].includes(s.next.state))fail('SESSION_STAGE_NOT_DISPATCHED');const sha=hash(evidence),name=phase+'.evidence-'+sha+'.bin',existing=await optional(name);if(existing&&!existing.equals(evidence))fail('SESSION_EVIDENCE_CONFLICT');if(!existing)try{await durableSave(directory,name,evidence);}catch(e){if(e.code!=='EEXIST')throw e;if(!(await optional(name))?.equals(evidence))fail('SESSION_EVIDENCE_CONFLICT');}const row=journal.record(s.next.id,outcome,sha);return {phase,id:row.id,state:row.state,evidenceSha256:row.evidence_sha,publicationAllowed:false};},
  close(){journal.close();}
 };
}
module.exports={PHASES,createProductionSession,openProductionSession,amendProductionCandidate,candidateAmendmentValue};
