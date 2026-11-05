/* Successive CODE-ONLY upgrades of the one activated isolated acceptance target.
 * A verified predecessor is authenticated by the existing durable release journal.
 * This is NOT a manager publisher and never creates resources, installs secrets,
 * changes data/maintenance/Cron/domains, or retries a dispatched mutation. */
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {TARGET,readUpgradeState,upgradeMetadata,verifyPreservation,originalModule}=require('./update-isolated-acceptance.cjs');
const {FIXED,PIN,PROFILE,validateActiveState,validateAuthority}=require('./upgrade-active-isolated.cjs');
const {privateDirectory,readPrivateJson,maintenanceClient,assertPrivate}=require('./maintenance-client.cjs');
const {readPrivateBytes}=require('./cutover-evidence.cjs');
const {hash,canonical,privateSave}=require('./cutover-window.cjs');
const {verifyRemoteBundle,bounded}=require('./execute-remote-acceptance.cjs');
const {exportsOf}=require('./prepare-remote-acceptance.cjs');
const {collectSourceInputs,hashInputs}=require('./build-info.cjs');
const {openReleaseJournal}=require('./release-journal.cjs');
const {FULL_COMMAND,collectTestScope,assertFullTestOutput,assertRuntimeOutput}=require('./test-scope.cjs');
const TOOLS=['scripts/test-scope.cjs','scripts/upgrade-chained-isolated.cjs','scripts/attach-isolated-acceptance-domain.cjs','scripts/backup-worker-readonly.cjs','scripts/build-info.cjs','scripts/cutover-evidence.cjs','scripts/cutover-window.cjs','scripts/execute-remote-acceptance.cjs','scripts/maintenance-client.cjs','scripts/prepare-remote-acceptance.cjs','scripts/private-path.cjs','scripts/release-journal.cjs','scripts/update-isolated-acceptance.cjs','scripts/upgrade-active-isolated.cjs'];
const PREDECESSOR_FILES=['report.json','intent.json','before/state.json','before-authority.json','request-body.bin','readback/state.json','readback/006-response.bin'];
const GATE_COMMANDS={build:['build.js'],type:['node_modules/typescript/bin/tsc','--noEmit'],verify:['verify.js'],full:FULL_COMMAND,runtime:['scripts/test-reliability-runtime.cjs']};
// Exact old commands remain readable only for immutable historical evidence.
const LEGACY_GATE_COMMANDS={...GATE_COMMANDS,full:['node_modules/vitest/vitest.mjs','run']};
const fail=c=>{throw Error(c);},equal=(a,b)=>canonical(a)===canonical(b),target={account:TARGET.account,worker:TARGET.worker,namespace:TARGET.namespace};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function inside(root,file){const rel=path.relative(path.resolve(root),path.resolve(file));if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))fail('CHAIN_PATH_DENIED');return path.resolve(file);}
async function regular(root,file){file=inside(root,file);const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink())fail('CHAIN_UNSAFE_FILE');inside(await fs.realpath(root),await fs.realpath(file));return file;}
async function evidence(root,file,limit=20*1024*1024){return readPrivateBytes(await regular(path.join(root,'.wrangler'),file),limit);}
function withoutPin(state,pin){validateActiveState(state,pin);const copy=structuredClone(state);copy.settings.bindings=copy.settings.bindings.filter(b=>b.name!=='RELIABILITY_INITIAL_CUTOVER_PIN');copy.version.resources.bindings=copy.version.resources.bindings.filter(b=>b.name!=='RELIABILITY_INITIAL_CUTOVER_PIN');return copy;}
async function journalPredecessor(root,report,intent,ownId){
 const file=await regular(path.join(root,'.wrangler'),path.join(root,'.wrangler/release-journal-v1/operations.sqlite'));
 await assertPrivate(file);
 const db=new DatabaseSync(file,{readOnly:true});try{
  const row=db.prepare('SELECT * FROM operations WHERE id=?').get(report.id);
  const gate=db.prepare('SELECT operation_id FROM target_gates WHERE account=? AND worker=?').get(TARGET.account,TARGET.worker);
  const head=db.prepare("SELECT o.id FROM transitions t JOIN operations o ON o.id=t.operation_id WHERE o.account=? AND o.worker=? AND t.state='verified' ORDER BY t.sequence DESC LIMIT 1").get(TARGET.account,TARGET.worker);
  if(!row||row.account!==TARGET.account||row.worker!==TARGET.worker||!['active_isolated_worker_update','chained_isolated_worker_update'].includes(row.kind)||row.state!=='verified'||row.intent_sha!==hash(canonical(intent))||row.evidence_sha!==hash(canonical(report)))fail('CHAIN_PREDECESSOR_NOT_VERIFIED');
  if(gate&&gate.operation_id!==ownId)fail('CHAIN_TARGET_HELD');
  if(head?.id!==report.id&&head?.id!==ownId)fail('CHAIN_PREDECESSOR_NOT_HEAD');
  if(row.kind==='chained_isolated_worker_update'&&(!report.predecessor||report.predecessor!==intent.predecessor))fail('CHAIN_PREDECESSOR_LINK_INVALID');
  return {id:row.id,evidenceSha256:row.evidence_sha,intentSha256:row.intent_sha};
 }finally{db.close();}
}
async function predecessor(root,dir,ownId){
 dir=inside(path.join(root,'.wrangler'),dir);const refs=[],data={};
 for(const file of PREDECESSOR_FILES){const raw=await evidence(root,path.join(dir,file));data[file]=raw;refs.push({file:path.relative(root,path.join(dir,file)),sha256:hash(raw)});}
 const report=JSON.parse(data['report.json']),intent=JSON.parse(data['intent.json']),before=JSON.parse(data['before/state.json']),beforeAuthority=JSON.parse(data['before-authority.json']),state=JSON.parse(data['readback/state.json']);
 const pinBytes=await evidence(root,path.join(root,PIN)),pin=JSON.parse(pinBytes);refs.push({file:PIN,sha256:hash(pinBytes)});
 if(report.schema!==1||!uuid(report.version)||!uuid(report.deployment)||!digest(report.artifactSha256)||report.generation!==FIXED.generation||report.epoch!==FIXED.epoch||report.pinId!==FIXED.pinId||['sourceReadback','bindingsPreserved','doNamespaceAndObjectsPreserved','managerControlPlaneUnchanged','domainsAndCronPreserved','authorityIdentityAndBarriersPreserved','credentialAndViewProbesStillRequired'].some(k=>report[k]!==true)||['productionDeployment','createdResources','secretsModified','automaticMutationRetry'].some(k=>report[k]!==false))fail('CHAIN_PREDECESSOR_REPORT_INVALID');
 if(intent.id!==report.id||intent.account!==TARGET.account||intent.worker!==TARGET.worker||intent.method!=='PUT'||intent.url!=='https://api.cloudflare.com/client/v4/accounts/'+TARGET.account+'/workers/scripts/'+TARGET.worker||intent.automaticRetry!==false||intent.candidateSha256!==report.artifactSha256||intent.bodySha256!==hash(data['request-body.bin'])||intent.beforeSha256!==hash(data['before/state.json'])||intent.authoritySha256!==hash(data['before-authority.json']))fail('CHAIN_PREDECESSOR_INTENT_INVALID');
 const journal=await journalPredecessor(root,report,intent,ownId);
 validateAuthority(beforeAuthority.status,beforeAuthority.identity,pin);verifyPreservation(withoutPin(before,pin),withoutPin(state,pin),report.id);
 if(!equal(state.active,{version:report.version,deployment:report.deployment})||state.content.sha256!==hash(data['readback/006-response.bin']))fail('CHAIN_PREDECESSOR_STATE_INVALID');
 const bytes=await originalModule(data['readback/006-response.bin']);if(hash(bytes)!==report.artifactSha256)fail('CHAIN_PREDECESSOR_SOURCE_INVALID');
 return {state,pin,bytes,refs,journal,report};
}
async function gates(root,dir,gateFiles,bytes,checkCurrentSource=false){
 dir=inside(path.join(root,'.wrangler'),dir);if(!gateFiles||Object.keys(gateFiles).sort().join(',')!=='build,full,runtime,type,verify')fail('CHAIN_GATE_MAP_INVALID');
 const refs=[],json=async file=>{const b=await evidence(root,path.join(dir,file));refs.push({file,sha256:hash(b)});return JSON.parse(b);};
 const report=await json('implementation-report.json'),manifest=await json('build-manifest.json'),inputs=await json('source-inputs.json');
 if(!equal(report.candidate,manifest)||manifest.worker?.sha256!==hash(bytes)||manifest.worker.bytes!==bytes.length||report.sourceInputsUnchanged!==true||!digest(manifest.build?.sourceSha256)||typeof manifest.build.buildId!=='string'||report.browserExecuted!==false||report.a5Executed!==false||report.releaseAllowed!==false)fail('CHAIN_CANDIDATE_NOT_VALIDATED');
 if(checkCurrentSource&&!equal(inputs,collectSourceInputs(root).map(i=>({file:i.path,bytes:i.content.length,sha256:hash(i.content)}))))fail('CHAIN_CANDIDATE_SOURCE_DRIFT');
 const modern=report.testScope?.schema===1;
 if(checkCurrentSource&&!modern)fail('CHAIN_CURRENT_TEST_SCOPE_REQUIRED');
 if(modern){if(!equal(report.testScope,collectTestScope(root))||report.checks?.full?.files!==report.testScope.files.length)fail('CHAIN_GATE_SCOPE_INCOMPLETE');}
 else if(!Number.isSafeInteger(report.checks?.full?.files)||report.checks.full.files<121||!Number.isSafeInteger(report.checks.full.tests)||report.checks.full.tests<2449||report.checks.runtime?.realLocalProcessRestarts<33)fail('CHAIN_GATE_SCOPE_INCOMPLETE');
 const logs={},ends={},starts={};
 for(const key of Object.keys(GATE_COMMANDS)){
  const stem=gateFiles[key];if(typeof stem!=='string'||!/^[a-z0-9-]{1,96}$/.test(stem))fail('CHAIN_GATE_FILE_INVALID');
  const start=await json(stem+'.start.json'),end=await json(stem+'.end.json'),raw=await evidence(root,path.join(dir,stem+'.stdout.log'));refs.push({file:stem+'.stdout.log',sha256:hash(raw)});
  if(start.name!==stem||end.name!==stem||path.resolve(start.cwd)!==root||!equal(start.args,(modern?GATE_COMMANDS:LEGACY_GATE_COMMANDS)[key])||end.code!==0||end.signal!==null||end.startedAt!==start.startedAt||!Number.isFinite(Date.parse(end.startedAt))||!Number.isFinite(Date.parse(end.endedAt))||Date.parse(end.endedAt)<Date.parse(end.startedAt)||report.checks[key]?.exitCode!==0)fail('CHAIN_LOCAL_GATE_FAILED');
  logs[key]=raw.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');ends[key]=end;starts[key]=start;
 }
 if(!logs.build.includes(hash(bytes))||!logs.build.includes(manifest.build.buildId)||!logs.verify.match(/Errors:\s+0\s+Warnings:\s+0/)||!logs.full.match(new RegExp('Test Files\\s+'+report.checks.full.files+' passed'))||!logs.full.match(new RegExp('Tests\\s+'+report.checks.full.tests+' passed'))||(!modern&&!logs.runtime.includes('thirty-second and thirty-third real DO process restarts'))||!logs.runtime.includes('Local test evidence (mock data only):'))fail('CHAIN_GATE_OUTPUT_MISMATCH');
 if(modern){let full,runtime;try{full=assertFullTestOutput(logs.full,report.testScope.files.length);runtime=assertRuntimeOutput(logs.runtime);}catch{fail('CHAIN_GATE_SCOPE_INCOMPLETE');}if(full.tests!==report.checks.full.tests||!equal(runtime,{realLocalProcessRestarts:report.checks.runtime?.realLocalProcessRestarts,checkpoints:report.checks.runtime?.checkpoints}))fail('CHAIN_GATE_SCOPE_INCOMPLETE');}
 for(const key of ['full','runtime'])if(Date.parse(starts[key].startedAt)<Date.parse(ends.build.endedAt))fail('CHAIN_GATE_PRECEDES_BUILD');
 return {refs,manifest};
}
async function toolEvidence(root,file){const raw=await evidence(root,file),value=JSON.parse(raw);if(value.code!==0)fail('CHAIN_TOOL_GATE_FAILED');return {file:path.relative(root,file),sha256:hash(raw)};}
async function prepareChainedUpgrade({root=path.resolve(__dirname,'..'),predecessorDir,validationDir,gateFiles,toolGate,out}){
 root=path.resolve(root);out=inside(path.join(root,'.wrangler'),out);const prior=await predecessor(root,predecessorDir);
 const bytes=await evidence(root,path.join(validationDir,'worker.js'),5*1024*1024);exportsOf(bytes);if(hash(bytes)===hash(prior.bytes))fail('CHAIN_NOT_A_CODE_CHANGE');
 const validation=await gates(root,validationDir,gateFiles,bytes,true),tool=await toolEvidence(root,toolGate),tools=[];
 for(const file of TOOLS)tools.push({file,sha256:hash(await fs.readFile(await regular(root,path.join(root,file))))});
 const plan={schema:1,purpose:'chained-activated-isolated-code-only',id:'chain_up_'+randomUUID().replace(/-/g,''),target:TARGET,predecessor:{...prior.journal,dir:path.relative(root,predecessorDir),refs:prior.refs},expected:{version:prior.report.version,deployment:prior.report.deployment,sha256:hash(prior.bytes),generation:FIXED.generation,epoch:FIXED.epoch,pinId:FIXED.pinId,installation:FIXED.installation},candidate:{file:'candidate-worker.js',bytes:bytes.length,sha256:hash(bytes)},validation:{dir:path.relative(root,validationDir),gateFiles,refs:validation.refs},toolGate:tool,tools,productionDeployment:false,createResources:false,modifySecrets:false,modifyData:false,modifyDomainsOrCron:false,automaticMutationRetry:false};
 await privateDirectory(out);await privateSave(out,plan.candidate.file,bytes);await privateSave(out,'plan.json',plan);return plan;
}
async function loadChainedUpgrade({root=path.resolve(__dirname,'..'),planFile}){
 root=path.resolve(root);const raw=await evidence(root,planFile,65536),p=JSON.parse(raw);
 if(!p||Object.keys(p).sort().join(',')!=='automaticMutationRetry,candidate,createResources,expected,id,modifyData,modifyDomainsOrCron,modifySecrets,predecessor,productionDeployment,purpose,schema,target,toolGate,tools,validation'||p.schema!==1||p.purpose!=='chained-activated-isolated-code-only'||!/^chain_up_[a-f0-9]{32}$/.test(p.id)||!equal(p.target,TARGET)||[p.productionDeployment,p.createResources,p.modifySecrets,p.modifyData,p.modifyDomainsOrCron,p.automaticMutationRetry].some(v=>v!==false))fail('INVALID_CHAIN_UPGRADE_PLAN');
 const prior=await predecessor(root,inside(path.join(root,'.wrangler'),path.resolve(root,p.predecessor.dir)),p.id);
 if(!equal(p.predecessor,{...prior.journal,dir:p.predecessor.dir,refs:prior.refs})||!equal(p.expected,{version:prior.report.version,deployment:prior.report.deployment,sha256:hash(prior.bytes),generation:FIXED.generation,epoch:FIXED.epoch,pinId:FIXED.pinId,installation:FIXED.installation}))fail('CHAIN_PREDECESSOR_CHANGED');
 if(p.candidate?.file!=='candidate-worker.js')fail('CHAIN_ARTIFACT_CHANGED');const bytes=await evidence(root,path.join(path.dirname(planFile),p.candidate.file),5*1024*1024);if(p.candidate.bytes!==bytes.length||p.candidate.sha256!==hash(bytes))fail('CHAIN_ARTIFACT_CHANGED');exportsOf(bytes);
 const validation=await gates(root,inside(path.join(root,'.wrangler'),path.resolve(root,p.validation.dir)),p.validation.gateFiles,bytes);if(!equal(validation.refs,p.validation.refs))fail('CHAIN_VALIDATION_CHANGED');
 if(!equal(p.toolGate,await toolEvidence(root,path.resolve(root,p.toolGate.file))))fail('CHAIN_TOOL_GATE_CHANGED');
 if(!Array.isArray(p.tools)||p.tools.length!==TOOLS.length)fail('CHAIN_TOOLS_CHANGED');for(let i=0;i<TOOLS.length;i++)if(p.tools[i].file!==TOOLS[i]||p.tools[i].sha256!==hash(await fs.readFile(await regular(root,path.join(root,TOOLS[i])))))fail('CHAIN_TOOLS_CHANGED');
 return {root,plan:p,planFile:path.resolve(planFile),planSha256:hash(raw),bytes,prior};
}
/** Inspection receipts are idempotent too: use fresh read IDs per attempt, never the mutation ID. */
async function authority(c,out,label,transport,timeoutMs){const profile=await readPrivateJson(path.join(c.root,PROFILE));if(profile.endpoint!=='https://'+TARGET.hostname+'/api/reliability/maintenance'||profile.operator!=='acceptance'||!equal(profile.target,target))fail('CHAIN_UPGRADE_PROFILE_MISMATCH');const result={};for(const [key,action] of [['status','status'],['identity','initial_identity']]){const dir=path.join(out,label+'-'+key),summary=await maintenanceClient({profile,command:{id:'active_inspect_'+randomUUID().replace(/-/g,''),action,args:{},expected:null},out:dir,transport,timeoutMs});if(!summary.acknowledged)fail('CHAIN_UPGRADE_PROBE_REJECTED');/* The shared client creates files inside a private directory. Make each NEW output explicitly protected before strict reread; never change historical input ACLs. */if(process.platform==='win32')for(const name of await fs.readdir(dir)){const file=await regular(dir,path.join(dir,name));try{await require('./private-path.cjs').windowsPrivatePath(file,'check');}catch{await require('./private-path.cjs').windowsPrivatePath(file,'file');}}result[key]=JSON.parse(await evidence(c.root,path.join(dir,'response.bin'))).value;}validateAuthority(result.status,result.identity,c.prior.pin);return result;}
function stable(state){const {content,...rest}=state;return rest;}
function preservation(c,before,after){validateActiveState(after,c.prior.pin);verifyPreservation(withoutPin(before,c.prior.pin),withoutPin(after,c.prior.pin),c.plan.id);}
async function finish(c,before,beforeAuthority,out,token,transport,timeoutMs){const after=await readUpgradeState({out:path.join(out,'readback'),token,transport,timeoutMs});await verifyRemoteBundle(after.content,c.bytes);preservation(c,before,after);const next=await authority(c,out,'after',transport,timeoutMs);if(!equal(next,beforeAuthority))fail('CHAIN_UPGRADE_AUTHORITY_CHANGED');const report={schema:1,id:c.plan.id,predecessor:c.plan.predecessor.id,version:after.active.version,deployment:after.active.deployment,artifactSha256:hash(c.bytes),generation:FIXED.generation,epoch:FIXED.epoch,pinId:FIXED.pinId,sourceReadback:true,bindingsPreserved:true,doNamespaceAndObjectsPreserved:true,managerControlPlaneUnchanged:true,domainsAndCronPreserved:true,authorityIdentityAndBarriersPreserved:true,productionDeployment:false,createdResources:false,secretsModified:false,automaticMutationRetry:false,credentialAndViewProbesStillRequired:true};await privateSave(out,'report.json',report);return report;}
async function executeChainedUpgrade({root=path.resolve(__dirname,'..'),planFile,out,token,transport=fetch,timeoutMs=30000}){
 const c=await loadChainedUpgrade({root,planFile});out=inside(path.join(c.root,'.wrangler'),out);await privateDirectory(out);const journal=await openReleaseJournal(path.join(c.root,'.wrangler/release-journal-v1'));let dispatched=false;
 try{if(journal.inspect(c.plan.id).operation)fail('ORIGINAL_OPERATION_RECONCILIATION_REQUIRED');const before=await readUpgradeState({out:path.join(out,'before'),token,transport,timeoutMs});validateActiveState(before,c.prior.pin);if(!equal(before.active,c.prior.state.active))fail('CHAIN_UPGRADE_OLD_DEPLOYMENT_CHANGED');await verifyRemoteBundle(before.content,c.prior.bytes);if(!equal(stable(before),stable(c.prior.state)))fail('CHAIN_UPGRADE_BASELINE_DRIFT');const beforeAuthority=await authority(c,out,'before',transport,timeoutMs);await privateSave(out,'before-authority.json',beforeAuthority);
 const last=await readUpgradeState({out:path.join(out,'before-send'),token,transport,timeoutMs});if(!equal(stable(last),stable(before)))fail('CHAIN_UPGRADE_CHANGED_BEFORE_SEND');await verifyRemoteBundle(last.content,c.prior.bytes);
 const metadata=upgradeMetadata(before.settings,c.plan.id),form=new FormData();form.append('metadata',JSON.stringify(metadata));form.append('worker.js',new Blob([c.bytes],{type:'application/javascript+module'}),'worker.js');const url='https://api.cloudflare.com/client/v4/accounts/'+TARGET.account+'/workers/scripts/'+TARGET.worker,request=new Request(url,{method:'PUT',body:form}),body=Buffer.from(await request.arrayBuffer()),contentType=request.headers.get('content-type');await privateSave(out,'request-body.bin',body);await privateSave(out,'metadata.json',metadata);
 const intent={schema:1,id:c.plan.id,predecessor:c.plan.predecessor.id,planSha256:c.planSha256,account:TARGET.account,worker:TARGET.worker,method:'PUT',url,bodySha256:hash(body),candidateSha256:hash(c.bytes),beforeSha256:hash(await evidence(c.root,path.join(out,'before/state.json'))),authoritySha256:hash(await evidence(c.root,path.join(out,'before-authority.json'))),automaticRetry:false};await privateSave(out,'intent.json',intent);journal.reserve({id:c.plan.id,account:TARGET.account,worker:TARGET.worker,kind:'chained_isolated_worker_update',intentSha256:hash(canonical(intent))},{id:c.plan.predecessor.id,evidenceSha256:c.plan.predecessor.evidenceSha256});journal.dispatch(c.plan.id);dispatched=true;
 let response;try{response=await bounded(transport,url,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':contentType},body},timeoutMs);}catch{const failure={error:'TRANSPORT_OUTCOME_UNCERTAIN',automaticRetry:false};await privateSave(out,'write-uncertain.json',failure);journal.record(c.plan.id,'uncertain',hash(canonical(failure)));fail('CHAIN_UPGRADE_OUTCOME_UNCERTAIN');}await privateSave(out,'write-response.bin',response.bytes);await privateSave(out,'write-transport.json',{status:response.status,headers:response.headers,sha256:hash(response.bytes)});let result;try{result=JSON.parse(response.bytes);}catch{}if(response.status!==200||result?.success!==true){journal.record(c.plan.id,'uncertain',hash(response.bytes));fail('CHAIN_UPGRADE_RESPONSE_REQUIRES_RECONCILIATION');}journal.record(c.plan.id,'acknowledged',hash(response.bytes));const report=await finish(c,before,beforeAuthority,out,token,transport,timeoutMs);journal.verified(c.plan.id,hash(canonical(report)));return report;
 }catch(e){const error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'CHAIN_ISOLATED_UPGRADE_FAILED';await privateSave(out,'failure.json',{error,dispatched,automaticMutationRetry:false});throw Error(error);}finally{journal.close();}
}
async function reconcileChainedUpgrade({root=path.resolve(__dirname,'..'),planFile,runDir,out,token,transport=fetch,timeoutMs=30000}){
 const c=await loadChainedUpgrade({root,planFile});runDir=inside(path.join(c.root,'.wrangler'),runDir);out=inside(path.join(c.root,'.wrangler'),out);await privateDirectory(out);const intent=JSON.parse(await evidence(c.root,path.join(runDir,'intent.json'))),before=await evidence(c.root,path.join(runDir,'before/state.json')),beforeAuthority=await evidence(c.root,path.join(runDir,'before-authority.json')),body=await evidence(c.root,path.join(runDir,'request-body.bin'));if(intent.predecessor!==c.plan.predecessor.id||intent.id!==c.plan.id||intent.planSha256!==c.planSha256||intent.account!==TARGET.account||intent.worker!==TARGET.worker||intent.bodySha256!==hash(body)||intent.candidateSha256!==hash(c.bytes)||intent.beforeSha256!==hash(before)||intent.authoritySha256!==hash(beforeAuthority))fail('CHAIN_UPGRADE_ORIGINAL_EVIDENCE_CHANGED');const journal=await openReleaseJournal(path.join(c.root,'.wrangler/release-journal-v1'));try{const row=journal.inspect(c.plan.id).operation;if(!row||row.intent_sha!==hash(canonical(intent))||!['dispatching','uncertain','acknowledged','verified'].includes(row.state))fail('CHAIN_UPGRADE_ORIGINAL_JOURNAL_MISMATCH');const report=await finish(c,JSON.parse(before),JSON.parse(beforeAuthority),out,token,transport,timeoutMs);journal.verified(c.plan.id,hash(canonical(report)));return report;}catch(e){await privateSave(out,'failure.json',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'CHAIN_UPGRADE_RECONCILIATION_UNPROVEN',readOnly:true,originalGateRetained:true});throw e;}finally{journal.close();}
}

/* Historical same-package validation replay for production preflight. Reuses the
 * exact upgrade validators but never prepares another isolated upgrade, opens a
 * writable journal, sends HTTP, edits old flags, or promotes this into approval. */
async function replayCurrentCandidateEvidence({root=path.resolve(__dirname,'..'),validationDir,gateFiles,isolatedUpgradeDir,expectedCandidate}){
 root=path.resolve(root);expectedCandidate=JSON.parse(canonical(expectedCandidate));gateFiles=JSON.parse(canonical(gateFiles));
 if(!expectedCandidate||Object.keys(expectedCandidate).sort().join(',')!=='buildId,sourceSha256,workerBytes,workerSha256'||!digest(expectedCandidate.sourceSha256)||!digest(expectedCandidate.workerSha256)||!Number.isSafeInteger(expectedCandidate.workerBytes)||expectedCandidate.workerBytes<1||expectedCandidate.workerBytes>5*1024*1024||typeof expectedCandidate.buildId!=='string'||!expectedCandidate.buildId||expectedCandidate.buildId.length>128)fail('REPLAY_EXPECTED_CANDIDATE_INVALID');
 const bytes=await evidence(root,path.join(validationDir,'worker.js'),5*1024*1024);exportsOf(bytes);
 if(hash(bytes)!==expectedCandidate.workerSha256||bytes.length!==expectedCandidate.workerBytes)fail('REPLAY_CANDIDATE_BYTES_MISMATCH');
 const local=await gates(root,validationDir,gateFiles,bytes,true),actual={buildId:local.manifest.build.buildId,sourceSha256:local.manifest.build.sourceSha256,workerBytes:local.manifest.worker.bytes,workerSha256:local.manifest.worker.sha256};
 if(!equal(actual,expectedCandidate)||hashInputs(collectSourceInputs(root))!==expectedCandidate.sourceSha256)fail('REPLAY_CANDIDATE_IDENTITY_MISMATCH');
 const references=local.refs.map(r=>({file:path.relative(root,path.join(validationDir,r.file)),sha256:r.sha256}));references.push({file:path.relative(root,path.join(validationDir,'worker.js')),sha256:hash(bytes)});
 const processReceipts=[];
 for(const [kind,stem] of Object.entries(gateFiles)){
  const childBytes=await evidence(root,path.join(validationDir,stem+'.child.json')),child=JSON.parse(childBytes),start=JSON.parse(await evidence(root,path.join(validationDir,stem+'.start.json'))),end=JSON.parse(await evidence(root,path.join(validationDir,stem+'.end.json')));
  if(!Number.isSafeInteger(child.pid)||child.pid<1||!Number.isSafeInteger(child.helperPid)||child.helperPid<1||child.pid!==end.pid||child.helperPid!==end.helperPid||child.helperPid!==start.helperPid||child.startedAt!==start.startedAt||child.startedAt!==end.startedAt)fail('REPLAY_PROCESS_RECEIPT_MISMATCH');
  references.push({file:path.relative(root,path.join(validationDir,stem+'.child.json')),sha256:hash(childBytes)});processReceipts.push({kind,pid:child.pid,helperPid:child.helperPid,startedAt:child.startedAt,endedAt:end.endedAt,code:end.code});
 }
 const prior=await predecessor(root,isolatedUpgradeDir);
 if(!prior.bytes.equals(bytes))fail('REPLAY_ISOLATED_NOT_SAME_CANDIDATE');
 const current=await fs.readFile(await regular(root,path.join(root,'dist/worker.js')));
 if(!current.equals(bytes)||hashInputs(collectSourceInputs(root))!==expectedCandidate.sourceSha256)fail('REPLAY_CURRENT_SOURCE_OR_ARTIFACT_CHANGED');
 return {schema:1,scope:'historical_same_candidate_gate_and_isolated_upload_replay',candidate:actual,localGatesReplayed:Object.keys(GATE_COMMANDS),processReceipts,isolated:{id:prior.report.id,version:prior.report.version,deployment:prior.report.deployment,generation:prior.report.generation,epoch:prior.report.epoch,journalHeadVerified:true,journalEvidenceSha256:prior.journal.evidenceSha256},references:[...references,...prior.refs,{file:'dist/worker.js',sha256:hash(current)}],currentProcessIdentityRecheckRequired:true,onlineCredentialAndViewEvidenceReplayed:false,currentProductionControlVerified:false,freezeProven:false,drainProven:false,publicationAllowed:false};
}
module.exports={TOOLS,PREDECESSOR_FILES,GATE_COMMANDS,prepareChainedUpgrade,loadChainedUpgrade,executeChainedUpgrade,reconcileChainedUpgrade,replayCurrentCandidateEvidence};
