/* One existing isolated Worker's code-only upgrade. NOT a manager publisher.
 * All resources/Secrets are inherited, mutations are single-dispatch journaled,
 * and unknown results require readback of the same operation, never another PUT. */
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {privateDirectory,readPrivateJson,assertPrivate}=require('./maintenance-client.cjs');
const {hash,canonical,privateSave}=require('./cutover-window.cjs');
const {readPrivateBytes}=require('./cutover-evidence.cjs');
const {bounded,validateSettings,verifyRemoteBundle}=require('./execute-remote-acceptance.cjs');
const {exportsOf}=require('./prepare-remote-acceptance.cjs');
const {active}=require('./backup-worker-readonly.cjs');
const {domainList}=require('./attach-isolated-acceptance-domain.cjs');
const {openReleaseJournal}=require('./release-journal.cjs');
const TARGET=Object.freeze({account:'fb86300faed47e7052b380db19fe844d',worker:'cfauto-accept-47142c9e5f538c32',namespace:'93710833ee1c40dd88a3a3a5a526453f',doNamespace:'aa46aade99934cda8b3d573fb76cec4a',hostname:'cfauto-accept-47142c9e5f538c32.mak.kdns.fr'});
const OLD=Object.freeze({version:'1140114c-7d70-4291-aa01-662abd368982',deployment:'bcf20e72-dd25-43fa-a7f7-80465ac10258',sha256:'43f98cda20acb380e25d090ac292eb65b1d64fa21b151b88f892553ced6ff8f7'});
const LOGS=['type-final-2.json','build-final-2.json','verify-final-2.json','credentials-final.json','full-final-2.json','runtime-final.json'];
const TOOLS=['scripts/release-journal.cjs','scripts/update-isolated-acceptance.cjs'];
const fail=c=>{throw Error(c);},equal=(a,b)=>canonical(a)===canonical(b),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
function inside(root,p){const r=path.relative(path.resolve(root),path.resolve(p));if(!r||r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r))fail('PATH_OUTSIDE_ROOT');return path.resolve(p);}
async function regular(root,p){inside(root,p);const s=await fs.lstat(p);if(s.isSymbolicLink()||!s.isFile())fail('UNSAFE_RELEASE_FILE');inside(await fs.realpath(root),await fs.realpath(p));return p;}
async function prepareIsolatedUpgrade({validationDir,toolValidationFile,out,root=path.resolve(__dirname,'..')}){
 root=path.resolve(root);const evidence=path.join(root,'.wrangler');validationDir=inside(evidence,validationDir);out=inside(evidence,out);toolValidationFile=inside(evidence,toolValidationFile);
 const bytes=await fs.readFile(await regular(root,path.join(root,'dist/worker.js')));if(bytes.length>5*1024*1024)fail('INVALID_ARTIFACT');exportsOf(bytes);
 const hashes=JSON.parse(await fs.readFile(await regular(evidence,path.join(validationDir,'artifact-hashes.json')),'utf8'));if(hashes['dist/worker.js']!==hash(bytes)||hash(bytes)===OLD.sha256)fail('VALIDATED_ARTIFACT_MISMATCH');
 const validation=[];for(const file of LOGS){const raw=await fs.readFile(await regular(evidence,path.join(validationDir,file))),value=JSON.parse(raw);if(value.code!==0||file==='build-final-2.json'&&!String(value.stdout).includes(hash(bytes)))fail('LOCAL_GATE_FAILED');validation.push({file,sha256:hash(raw)});}
 const toolLog=await fs.readFile(await regular(evidence,toolValidationFile));if(JSON.parse(toolLog).code!==0)fail('TOOL_GATE_FAILED');
 const toolHashes=[];for(const file of TOOLS)toolHashes.push({file,sha256:hash(await fs.readFile(await regular(root,path.join(root,file))))});
 const archivedActive=active(JSON.parse(await fs.readFile(await regular(evidence,path.join(evidence,'cfauto-accept-47142c9e5f538c32-remote-3/013-response.bin')),'utf8')).result);if(!equal(archivedActive,{version:OLD.version,deployment:OLD.deployment}))fail('ORIGINAL_DEPLOYMENT_EVIDENCE_CHANGED');const originalBytes=await originalModule(await fs.readFile(await regular(evidence,path.join(evidence,'cfauto-accept-47142c9e5f538c32-remote-3/014-response.bin'))));
 const plan={schema:1,purpose:'existing-isolated-code-only-upgrade',id:'upgrade_'+randomUUID().replace(/-/g,''),target:TARGET,expected:{...OLD,sha256:hash(originalBytes)},candidate:{file:'candidate-worker.js',bytes:bytes.length,sha256:hash(bytes)},validationDirectory:path.relative(root,validationDir),validation,toolValidation:{file:path.relative(root,toolValidationFile),sha256:hash(toolLog)},toolHashes,productionDeployment:false,createResources:false,modifySecrets:false,modifyDomainsOrCron:false,automaticMutationRetry:false};
 await privateDirectory(out);await privateSave(out,'candidate-worker.js',bytes);await privateSave(out,'upgrade-plan.json',plan);return plan;
}
async function loadUpgrade({planFile,root=path.resolve(__dirname,'..')}){
 root=path.resolve(root);const evidence=path.join(root,'.wrangler');planFile=await regular(evidence,inside(evidence,planFile));const raw=await readPrivateBytes(planFile,65536),p=JSON.parse(raw.toString('utf8'));
 if(!p||Object.keys(p).sort().join(',')!=='automaticMutationRetry,candidate,createResources,expected,id,modifyDomainsOrCron,modifySecrets,productionDeployment,purpose,schema,target,toolHashes,toolValidation,validation,validationDirectory'||p.schema!==1||p.purpose!=='existing-isolated-code-only-upgrade'||!/^upgrade_[a-f0-9]{32}$/.test(p.id)||!equal(p.target,TARGET)||(!equal({version:p.expected?.version,deployment:p.expected?.deployment},{version:OLD.version,deployment:OLD.deployment})||! /^[a-f0-9]{64}$/.test(p.expected?.sha256))||[p.productionDeployment,p.createResources,p.modifySecrets,p.modifyDomainsOrCron,p.automaticMutationRetry].some(x=>x!==false))fail('INVALID_UPGRADE_PLAN');
 if(p.candidate?.file!=='candidate-worker.js'||p.candidate.bytes>5*1024*1024||! /^[a-f0-9]{64}$/.test(p.candidate.sha256))fail('INVALID_ARTIFACT');
 const bytes=await readPrivateBytes(await regular(evidence,path.join(path.dirname(planFile),p.candidate.file)),5*1024*1024);if(bytes.length!==p.candidate.bytes||hash(bytes)!==p.candidate.sha256)fail('ARTIFACT_CHANGED');exportsOf(bytes);
 const dir=inside(evidence,path.resolve(root,p.validationDirectory));const hashes=JSON.parse(await fs.readFile(await regular(evidence,path.join(dir,'artifact-hashes.json')),'utf8'));if(hashes['dist/worker.js']!==hash(bytes))fail('VALIDATED_ARTIFACT_MISMATCH');
 if(!Array.isArray(p.validation)||p.validation.length!==LOGS.length)fail('INVALID_GATE_LOGS');for(let i=0;i<LOGS.length;i++){const v=p.validation[i],b=await fs.readFile(await regular(evidence,path.join(dir,LOGS[i]))),l=JSON.parse(b);if(v.file!==LOGS[i]||v.sha256!==hash(b)||l.code!==0||LOGS[i]==='build-final-2.json'&&!String(l.stdout).includes(hash(bytes)))fail('LOCAL_GATE_CHANGED');}
 const tv=await fs.readFile(await regular(evidence,inside(evidence,path.resolve(root,p.toolValidation.file))));if(hash(tv)!==p.toolValidation.sha256||JSON.parse(tv).code!==0)fail('TOOL_GATE_CHANGED');
 if(!Array.isArray(p.toolHashes)||p.toolHashes.length!==TOOLS.length)fail('INVALID_TOOL_HASHES');for(let i=0;i<TOOLS.length;i++)if(p.toolHashes[i].file!==TOOLS[i]||p.toolHashes[i].sha256!==hash(await fs.readFile(await regular(root,path.join(root,TOOLS[i])))))fail('RELEASE_TOOL_CHANGED');
 return {root,plan:p,planFile,planSha256:hash(raw),bytes};
}
function apiReader({out,token,transport=fetch,timeoutMs=30000}){
 if(typeof token!=='string'||!token||/[\r\n]/.test(token)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('INVALID_RELEASE_AUTH_OR_TIMEOUT');let seq=0;
 return async(suffix,raw=false)=>{const id=String(++seq).padStart(3,'0');if(!suffix.startsWith('/workers/'))fail('READ_SCOPE_DENIED');await privateSave(out,id+'-request.json',{method:'GET',suffix,at:new Date().toISOString()});const r=await bounded(transport,'https://api.cloudflare.com/client/v4/accounts/'+TARGET.account+suffix,{method:'GET',headers:{Authorization:'Bearer '+token}},timeoutMs);await privateSave(out,id+'-response.bin',r.bytes);await privateSave(out,id+'-transport.json',{httpStatus:r.status,sha256:hash(r.bytes),headers:r.headers});if(r.status!==200)fail('CONTROL_READ_REJECTED');if(raw)return r;let b;try{b=JSON.parse(r.bytes);}catch{fail('INVALID_CONTROL_RESPONSE');}if(b.success!==true)fail('CONTROL_READ_REJECTED');return b;};
}
async function listDoObjects(get){
 const result=[],seen=new Set(),cursors=new Set();let cursor;
 for(let page=0;page<32;page++){
  const b=await get('/workers/durable_objects/namespaces/'+TARGET.doNamespace+'/objects?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  if(!Array.isArray(b.result)||b.result.length>100||(b.result_info?.count!==undefined&&b.result_info.count!==b.result.length))fail('DO_OBJECT_INVENTORY_INCOMPLETE');
  for(const o of b.result){if(!/^[a-f0-9]{64}$/.test(o?.id)||typeof o.hasStoredData!=='boolean'||seen.has(o.id))fail('DO_OBJECT_INVENTORY_CONFLICT');seen.add(o.id);result.push(o);}
  // This enumeration cursor is the last unique DO id, not a telemetry event id.
  // The real API supplies a cursor even for a short, final nonempty page.
  const next=b.result_info?.cursor;if(!b.result.length||next===undefined||next===null||next===''){if(b.result.length===100)fail('DO_OBJECT_INVENTORY_INCOMPLETE');return result.sort((a,b)=>a.id.localeCompare(b.id));}
  if(typeof next!=='string'||next.length>4096||cursors.has(next))fail('DO_OBJECT_CURSOR_CONFLICT');cursors.add(next);cursor=next;
 }
 fail('DO_OBJECT_PAGE_LIMIT');
}
async function readUpgradeState({out,token,transport=fetch,timeoutMs=30000}){
 await privateDirectory(out);const get=apiReader({out,token,transport,timeoutMs}),base='/workers/scripts/'+TARGET.worker,s={};
 for(const [key,suffix] of [['settings','/settings'],['deployments','/deployments'],['schedules','/schedules'],['subdomain','/subdomain']])s[key]=(await get(base+suffix)).result;
 s.active=active(s.deployments);if(!uuid(s.active.deployment))fail('INVALID_DEPLOYMENT');s.version=(await get(base+'/versions/'+s.active.version)).result;s.content=await get(base+'/content/v2',true);
 s.domains=domainList(await get('/workers/domains')).sort((a,b)=>a.id.localeCompare(b.id));
 s.objects=await listDoObjects(get);
 s.manager={};for(const [key,suffix] of [['settings','/settings'],['deployments','/deployments'],['schedules','/schedules'],['subdomain','/subdomain']])s.manager[key]=(await get('/workers/scripts/manager'+suffix)).result;
 await privateSave(out,'state.json',{...s,content:{sha256:hash(s.content.bytes),headers:s.content.headers}});return s;
}
function validateUpgradeState(s){
 validateSettings(s.settings,TARGET.worker,TARGET.namespace);
 const d=s.settings.bindings.find(b=>b.name==='RELIABILITY_COORDINATOR');if(d.namespace_id!==TARGET.doNamespace)fail('DO_NAMESPACE_CHANGED');
 if(!equal(s.schedules,{schedules:[]})||s.subdomain?.enabled!==true||s.subdomain.previews_enabled!==false)fail('ISOLATED_TRAFFIC_POLICY_CHANGED');
 const domains=s.domains.filter(d=>d.service===TARGET.worker);if(domains.length!==1||domains[0].hostname!==TARGET.hostname||domains[0].zone_id!=='07c10ed4e8c8abfe10e4acf4e90bd3d3'||domains[0].previews_enabled!==false||domains[0].enabled===false||!['','production'].includes(domains[0].environment))fail('ISOLATED_DOMAIN_CHANGED');
 if(s.settings.logpush!==false||!equal(s.settings.tail_consumers,[])||!equal(s.settings.placement,{})||!equal(s.settings.tags,[])||s.settings.usage_model!=='standard')fail('UNSUPPORTED_REMOTE_SETTINGS');
 if(s.settings.observability?.enabled!==true||s.settings.observability.head_sampling_rate!==1)fail('OBSERVABILITY_CHANGED');
 if(s.version?.id!==s.active.version||s.version.resources?.script_runtime?.migration_tag!=='cfauto-accept-v1'||!equal(s.version.resources?.bindings,s.settings.bindings)||!s.objects.some(o=>o.id==='f4df1c53933c71a9d6efe533a509668ea149f6004746b9e726cac80ce6b8ab52'&&o.hasStoredData===true))fail('REMOTE_STORAGE_IDENTITY_CHANGED');
}
function upgradeMetadata(settings,id){
 return {main_module:'worker.js',compatibility_date:settings.compatibility_date,compatibility_flags:settings.compatibility_flags,bindings:settings.bindings.filter(b=>b.type!=='secret_text').map(b=>({name:b.name,type:'inherit'})),keep_bindings:['secret_text'],logpush:settings.logpush,tail_consumers:settings.tail_consumers,observability:settings.observability,annotations:{'workers/message':'cfauto-isolated-upgrade:'+id}};
}
function preservedSettings(s){const {annotations,...rest}=s;return rest;}
function verifyPreservation(before,after,id){validateUpgradeState(after);if(!equal(preservedSettings(before.settings),preservedSettings(after.settings))||!equal(before.schedules,after.schedules)||!equal(before.subdomain,after.subdomain)||!equal(before.domains,after.domains)||!equal(before.manager,after.manager)||!equal(before.version.resources.script_runtime,after.version.resources.script_runtime)||!equal(before.objects,after.objects))fail('PRESERVED_RESOURCE_CHANGED');if(after.version.annotations?.['workers/message']!=='cfauto-isolated-upgrade:'+id)fail('OPERATION_ANNOTATION_MISMATCH');if(after.active.version===before.active.version||after.active.deployment===before.active.deployment)fail('UPGRADE_NOT_OBSERVED');}
async function executeIsolatedUpgrade({planFile,out,token,root=path.resolve(__dirname,'..'),transport=fetch,timeoutMs=30000}){
 const c=await loadUpgrade({planFile,root});out=inside(path.join(c.root,'.wrangler'),out);await privateDirectory(out);const journal=await openReleaseJournal(path.join(c.root,'.wrangler','release-journal-v1'));let dispatched=false;
 try{
  // Same plan in any output directory encounters the same persistent operation.
  const prior=journal.inspect(c.plan.id).operation;if(prior)fail('ORIGINAL_OPERATION_RECONCILIATION_REQUIRED');
  const before=await readUpgradeState({out:path.join(out,'before'),token,transport,timeoutMs});validateUpgradeState(before);if(!equal(before.active,{version:OLD.version,deployment:OLD.deployment}))fail('OLD_DEPLOYMENT_CHANGED');
  const priorBytes=await fs.readFile(await regular(path.join(c.root,'.wrangler'),path.join(c.root,'.wrangler/cfauto-accept-47142c9e5f538c32-remote-3/014-response.bin')));
  // Saved multipart/raw original is independently checked against the planned digest.
  await verifyRemoteBundle(before.content,await originalModule(priorBytes));if(hash(await originalModule(priorBytes))!==c.plan.expected.sha256)fail('OLD_ARTIFACT_MISMATCH');
  const profile=await readPrivateJson(path.join(c.root,'.wrangler/cfauto-accept-47142c9e5f538c32-domain/maintenance-profile.json'));if(profile.endpoint!=='https://'+TARGET.hostname+'/api/reliability/maintenance'||!equal(profile.target,{account:TARGET.account,worker:TARGET.worker,namespace:TARGET.namespace})||profile.operator!=='acceptance')fail('ISOLATED_PROFILE_MISMATCH');
  const preProbe=path.join(out,'before-status');await require('./maintenance-client.cjs').maintenanceClient({profile,command:{id:c.plan.id+'_before',action:'status',args:{},expected:null},out:preProbe,transport,timeoutMs});const status=JSON.parse(await fs.readFile(await regular(path.join(c.root,'.wrangler'),path.join(preProbe,'response.bin')),'utf8'));if(status.value?.generation!==null||status.value?.maintenance!==1||!Number.isSafeInteger(status.value.epoch))fail('ISOLATED_AUTHORITY_NOT_EMPTY_MAINTENANCE');
  const verifyDir=path.join(out,'before-send');await privateDirectory(verifyDir);const finalRead=apiReader({out:verifyDir,token,transport,timeoutMs});if(!equal(active((await finalRead('/workers/scripts/'+TARGET.worker+'/deployments')).result),before.active)||!equal((await finalRead('/workers/scripts/'+TARGET.worker+'/settings')).result,before.settings))fail('TARGET_CHANGED_BEFORE_SEND');
  const metadata=upgradeMetadata(before.settings,c.plan.id),form=new FormData();form.append('metadata',JSON.stringify(metadata));form.append('worker.js',new Blob([c.bytes],{type:'application/javascript+module'}),'worker.js');
  const url='https://api.cloudflare.com/client/v4/accounts/'+TARGET.account+'/workers/scripts/'+TARGET.worker,request=new Request(url,{method:'PUT',body:form}),body=Buffer.from(await request.arrayBuffer()),contentType=request.headers.get('content-type');
  await privateSave(out,'request-body.bin',body);await privateSave(out,'metadata.json',metadata);
  const intent={schema:1,id:c.plan.id,planFile:c.planFile,planSha256:c.planSha256,account:TARGET.account,worker:TARGET.worker,method:'PUT',url,contentType,bodySha256:hash(body),candidateSha256:hash(c.bytes),beforeStateSha256:hash(await readPrivateBytes(path.join(out,'before/state.json'))),automaticRetry:false};await privateSave(out,'intent.json',intent);
  journal.reserve({id:c.plan.id,account:TARGET.account,worker:TARGET.worker,kind:'isolated_worker_update',intentSha256:hash(canonical(intent))});journal.dispatch(c.plan.id);dispatched=true;
  let r;try{r=await bounded(transport,url,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':contentType},body},timeoutMs);}catch(e){const failure={error:['REQUEST_DEADLINE','REDIRECT_DENIED','RESPONSE_TOO_LARGE'].includes(e.message)?e.message:'TRANSPORT_OUTCOME_UNCERTAIN',automaticRetry:false};await privateSave(out,'write-uncertain.json',failure);journal.record(c.plan.id,'uncertain',hash(canonical(failure)));fail('UPGRADE_OUTCOME_UNCERTAIN');}
  await privateSave(out,'write-response.bin',r.bytes);await privateSave(out,'write-transport.json',{httpStatus:r.status,sha256:hash(r.bytes),headers:r.headers});let b;try{b=JSON.parse(r.bytes);}catch{}
  if(r.status!==200||b?.success!==true){journal.record(c.plan.id,'uncertain',hash(r.bytes));fail('UPGRADE_RESPONSE_REQUIRES_RECONCILIATION');}journal.record(c.plan.id,'acknowledged',hash(r.bytes));
  const after=await readUpgradeState({out:path.join(out,'after'),token,transport,timeoutMs});await verifyRemoteBundle(after.content,c.bytes);verifyPreservation(before,after,c.plan.id);
  const report=upgradeReport(c,after);await privateSave(out,'upgrade-report.json',report);journal.verified(c.plan.id,hash(canonical(report)));return report;
 }catch(e){const safe=/^[A-Z0-9_]+$/.test(e.message)?e.message:'ISOLATED_UPGRADE_FAILED';await privateSave(out,'failure.json',{error:safe,dispatched,automaticMutationRetry:false,productionDeployment:false});throw Error(safe);}finally{journal.close();}
}
async function originalModule(bytes){
 // Existing evidence was captured from /content/v2 with a multipart header saved
 // separately; extract only the sole module, never evaluate the old source.
 const text=bytes.toString('utf8');if(!text.startsWith('--'))return bytes;const boundary=text.slice(2,text.indexOf('\r\n'));if(!boundary||boundary.length>200)fail('INVALID_OLD_CONTENT');const form=await new Response(bytes,{headers:{'content-type':'multipart/form-data; boundary='+boundary}}).formData();const entries=[...form];if(entries.length!==1||entries[0][0]!=='worker.js'||typeof entries[0][1]==='string')fail('INVALID_OLD_CONTENT');return Buffer.from(await entries[0][1].arrayBuffer());
}
async function reconcileIsolatedUpgrade({planFile,runDir,out,token,root=path.resolve(__dirname,'..'),transport=fetch,timeoutMs=30000}){
 const c=await loadUpgrade({planFile,root}),evidence=path.join(c.root,'.wrangler');runDir=inside(evidence,runDir);out=inside(evidence,out);await privateDirectory(out);
 const intent=await readPrivateJson(path.join(runDir,'intent.json')),beforeBytes=await readPrivateBytes(path.join(runDir,'before/state.json'),20*1024*1024),requestBytes=await readPrivateBytes(path.join(runDir,'request-body.bin'));
 if(intent.id!==c.plan.id||intent.planSha256!==c.planSha256||intent.account!==TARGET.account||intent.worker!==TARGET.worker||intent.bodySha256!==hash(requestBytes)||intent.beforeStateSha256!==hash(beforeBytes)||intent.candidateSha256!==hash(c.bytes))fail('ORIGINAL_UPGRADE_EVIDENCE_MISMATCH');
 const journal=await openReleaseJournal(path.join(c.root,'.wrangler','release-journal-v1'));
 try{const row=journal.inspect(c.plan.id).operation;if(!row||row.intent_sha!==hash(canonical(intent))||!['dispatching','acknowledged','uncertain','verified'].includes(row.state))fail('ORIGINAL_UPGRADE_JOURNAL_MISMATCH');
  const before=JSON.parse(beforeBytes),after=await readUpgradeState({out:path.join(out,'readback'),token,transport,timeoutMs});await verifyRemoteBundle(after.content,c.bytes);verifyPreservation(before,after,c.plan.id);
  const report=upgradeReport(c,after);await privateSave(out,'upgrade-report.json',report);journal.verified(c.plan.id,hash(canonical(report)));return report;
 }catch(e){await privateSave(out,'failure.json',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'RECONCILIATION_UNPROVEN',readOnly:true,automaticMutationRetry:false,originalGateRetained:true});throw e;}finally{journal.close();}
}
function upgradeReport(c,after){return {schema:1,id:c.plan.id,version:after.active.version,deployment:after.active.deployment,artifactSha256:hash(c.bytes),sourceReadback:true,bindingsPreserved:true,doNamespacePreserved:true,doObjectsPreserved:true,managerControlPlaneUnchanged:true,domainsAndCronPreserved:true,productionDeployment:false,createdResources:false,secretsModified:false,automaticMutationRetry:false,applicationProbesStillRequired:true};}
module.exports={listDoObjects,reconcileIsolatedUpgrade,TARGET,OLD,prepareIsolatedUpgrade,loadUpgrade,readUpgradeState,validateUpgradeState,upgradeMetadata,verifyPreservation,executeIsolatedUpgrade,originalModule};
