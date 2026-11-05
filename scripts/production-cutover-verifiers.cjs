/* Trusted fixed-production verifiers. No network, approvals from booleans, key\n * generation, or mutation. Global old-invocation termination is NOT claimed. */
const path=require('node:path'),Module=require('node:module');
const {TARGET}=require('./production-control-plane.cjs');
const {canonical,hash}=require('./cutover-window.cjs');
const {localInitialCodecs}=require('./initial-source-codecs.cjs');
const {nonBusinessKind}=require('./verify-cutover-backup.cjs');
const fail=c=>{throw Error(c);},same=(a,b)=>canonical(a)===canonical(b);
const USER_DECISION='没有解除排空缺口在cf Workers本项目里你可以想想，只要新版项目可以继承原本项目的kv数据，凭据解密后可以正常迁移就没有问题';
function verifyDataPolicy(p){
 const fixed={schema:1,kind:'user_approved_data_preserving_cutover',session:'prod_release_9601f01378b34c4ebed54ca8dbf6a2fc',source:'latest_user_message',quote:USER_DECISION,globalExecutionFenceRequired:false,globalExecutionFenceProven:false,preserveLegacyKv:true,preserveLegacySecretBindings:true,credentialKeySource:'retained_ACCESS_CODE',completePostFreezeBackupsRequired:true,allCredentialDecryptionRequired:true,completeImportValidationRequired:true,preAndPostKvComparisonRequired:true,maintenanceAndCronSuppressionRequired:true,atomicActivationRequired:true,currentCandidateGatesRequired:true,onlineAcceptanceRequired:true};
 if(!p||!same(Object.keys(p).sort(),[...Object.keys(fixed),'at'].sort())||Object.entries(fixed).some(([k,v])=>!same(p[k],v))||typeof p.at!=='string'||!Number.isFinite(Date.parse(p.at)))fail('PRODUCTION_DATA_POLICY_INVALID');return {policySha256:hash(canonical(p)),globalExecutionFenceProven:false};
}
function verifyAuthorityStatus(value,expected,{emptyBlockers=true}={}){
 if(!value||Object.entries(expected).some(([k,v])=>!same(value[k],v))||value.scope!=='authority_managed_tasks'||value.legacyDrainProven!==false||!value.blockers||Object.values(value.blockers).some(x=>!Number.isSafeInteger(x)||x<0||emptyBlockers&&x!==0))fail('PRODUCTION_AUTHORITY_STATUS_MISMATCH');return value;
}
function verifyEmptyIdentity(value){
 if(!value||!same(value.target,{account:TARGET.account,worker:TARGET.worker,namespace:TARGET.namespace})||value.generation!==null||value.epoch!==0||value.maintenance!==1||value.sourceAnchorConfigured!==false||value.anchor!==null||value.scope!=='initial_source_identity'||value.activationPerformed!==false||typeof value.installation!=='string'||!value.installation)fail('PRODUCTION_EMPTY_IDENTITY_MISMATCH');return value;
}
function preparePinMetadata(before,pin,operationId){
 if(!/^prod_phase_[a-f0-9]{40}$/.test(operationId)||before.target?.worker!==TARGET.worker||before.source?.sha256!==pin.evidence.freezeArtifact||before.active?.version!==pin.evidence.freezeVersion||before.active?.deployment!==pin.evidence.freezeDeployment||before.schedules?.schedules?.length!==0)fail('PRODUCTION_PIN_BASE_MISMATCH');
 const s=before.settings;if(s.bindings.some(b=>b.name==='RELIABILITY_INITIAL_CUTOVER_PIN')||!s.bindings.some(b=>b.name==='RELIABILITY_COORDINATOR'&&b.type==='durable_object_namespace')||!s.bindings.some(b=>b.name==='CONFIG_KV'&&b.namespace_id===TARGET.namespace))fail('PRODUCTION_PIN_BINDING_MISMATCH');
 const metadata={main_module:'worker.js',compatibility_date:s.compatibility_date,compatibility_flags:s.compatibility_flags,bindings:[...s.bindings.filter(b=>b.type!=='secret_text').map(b=>({name:b.name,type:'inherit'})),{name:'RELIABILITY_INITIAL_CUTOVER_PIN',type:'plain_text',text:canonical(pin)}],keep_bindings:['secret_text'],annotations:{'workers/message':'cfauto-production-pin:'+operationId}};
 for(const k of ['placement','usage_model','tags','tail_consumers','logpush','observability'])if(Object.hasOwn(s,k))metadata[k]=structuredClone(s[k]);return metadata;
}
function sortedBindings(x){return [...x].sort((a,b)=>a.name.localeCompare(b.name));}
function verifyPinReadback({before,after,pin,operationId,artifact}){
 preparePinMetadata(before,pin,operationId);
 if(!same(after.target,TARGET)||!after.stableAcrossRead||after.source.bytes!==artifact.bytes||after.source.sha256!==artifact.sha256||after.active.version===before.active.version||after.active.deployment===before.active.deployment||after.version.id!==after.active.version||after.version.annotations?.['workers/message']!=='cfauto-production-pin:'+operationId)fail('PRODUCTION_PIN_READBACK_MISMATCH');
 for(const k of ['schedules','subdomain','domains','routes','protected'])if(!same(before[k],after[k]))fail('PRODUCTION_PIN_PRESERVATION_MISMATCH');
 const expected=[...before.settings.bindings,{name:'RELIABILITY_INITIAL_CUTOVER_PIN',type:'plain_text',text:canonical(pin)}];if(!same(sortedBindings(expected),sortedBindings(after.settings.bindings))||!same(after.settings.bindings,after.version.resources.bindings))fail('PRODUCTION_PIN_BINDINGS_CHANGED');
 const rest=s=>{const {annotations,bindings,...r}=s;return r;};if(!same(rest(before.settings),rest(after.settings))||!same(before.version.resources.script_runtime,after.version.resources.script_runtime))fail('PRODUCTION_PIN_RUNTIME_CHANGED');return {active:after.active,coordinatorNamespace:after.settings.bindings.find(b=>b.name==='RELIABILITY_COORDINATOR').namespace_id,pinSha256:hash(canonical(pin)),originalBindingsPreserved:true};
}
function compareRetainedKv(first,second){
 const c=localInitialCodecs(),maps=[first,second].map(m=>new Map(m.entries.map(e=>[e.name,e]))),differences=[];
 for(const m of [first,second])if(m.account!==TARGET.account||m.worker!==TARGET.worker||m.namespace!==TARGET.namespace||m.entries.some(e=>nonBusinessKind(e)==='unclassified'))fail('PRODUCTION_KV_SCOPE_OR_CLASSIFICATION');
 for(const key of [...new Set([...maps[0].keys(),...maps[1].keys()])].sort()){const a=maps[0].get(key),b=maps[1].get(key),strip=x=>x?(({file,...rest})=>rest)(x):null;if(!same(strip(a),strip(b)))differences.push({keyDigest:hash(key),domain:c.legacyBusinessDomain(key),change:!a?'added':!b?'removed':'changed'});}
 return {allLegacyValuesUnchanged:differences.length===0,businessValuesUnchanged:differences.every(d=>d.domain===null),differences,globalExecutionFenceProven:false};
}
let credentialCode;
function currentCredentialCode(){if(!credentialCode){const root=path.resolve(__dirname,'..'),output=require('esbuild').buildSync({entryPoints:[path.join(root,'src/reliability/credential-accounts.ts')],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'}),compiled=new Module(path.join(__dirname,'.production-credential-verifier.cjs'),module);compiled.filename=path.join(__dirname,'.production-credential-verifier.cjs');compiled.paths=module.paths;compiled._compile(output.outputFiles[0].text,compiled.filename);credentialCode=compiled.exports;}return credentialCode;}
let viewCode;
function currentViewCode(){if(!viewCode){const root=path.resolve(__dirname,'..'),source=path.join(root,'src/reliability/authority-views.ts'),text=require('node:fs').readFileSync(source,'utf8')+'\nexport {journal as projectLegacyJournal};',output=require('esbuild').buildSync({stdin:{contents:text,sourcefile:source,resolveDir:path.dirname(source),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'}),m=new Module(path.join(__dirname,'.production-view-verifier.cjs'),module);m.filename=path.join(__dirname,'.production-view-verifier.cjs');m.paths=module.paths;m._compile(output.outputFiles[0].text,m.filename);viewCode=m.exports;}return viewCode;}

function verifyBuild(bytes,candidate){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('PRODUCTION_BUILD_UTF8_INVALID');}const matches=[...text.matchAll(/window\.APP_BUILD_INFO=([^;]+);/g)];if(matches.length!==1)fail('PRODUCTION_BUILD_MARKER_INVALID');const value=localInitialCodecs().parseStrictBackupJson(Buffer.from(matches[0][1]));if(value.buildId!==candidate.buildId||value.sourceSha256!==candidate.sourceSha256)fail('PRODUCTION_APPLICATION_BUILD_MISMATCH');return {buildId:value.buildId,sourceSha256:value.sourceSha256};}
async function verifyMigratedViews({source,exported,masked,views,init,journal,ring,status}){
 const c=localInitialCodecs(),old=source.data.records.find(r=>r.domain==='accounts').value;
 if(exported?.format!=='cfauto.accounts'||exported.version!==2||exported.source?.generation!==status.generation||exported.source?.epoch!==status.epoch||exported.source?.revision!==1||!Array.isArray(exported.accounts)||exported.accounts.length!==old.length)fail('PRODUCTION_ACCOUNT_EXPORT_MISMATCH');
 const clean=a=>{const {globalKey,apiToken,credentialRevision,...rest}=a;return rest;};
 let credentialCount=0;
 for(let i=0;i<old.length;i++){const a=old[i],b=exported.accounts[i];if(!same(clean(a),clean(b))||b.credentialRevision!==(a.credentialRevision??1))fail('PRODUCTION_ACCOUNT_METADATA_CHANGED');for(const k of ['globalKey','apiToken']){if(!!a[k]!==!!b[k]||b[k]&&!b[k].startsWith('v2:'+ring.currentId+':'))fail('PRODUCTION_CREDENTIAL_MIGRATION_INCOMPLETE');if(b[k])credentialCount++;}}
 if(!same(exported.keyIds,credentialCount?[ring.currentId]:[]))fail('PRODUCTION_CREDENTIAL_KEY_ID_MISMATCH');
 const plain=await currentCredentialCode().readCredentialAccounts(exported.accounts,ring),safe=plain.map(a=>({...a,globalKey:a.globalKey?'***':'',apiToken:a.apiToken?'***':''}));
 if(!same(masked,safe))fail('PRODUCTION_MASKED_VIEW_MISMATCH');
 const input=structuredClone(source.data);input.records.find(r=>r.domain==='accounts').value=exported.accounts;
 const expected=await c.prepareGenerationData(input,ring,{credentials:'migrate',unprefixed:'encrypted'}),byDomain=new Map(expected.records.map(r=>[r.domain,r]));
 const compared=[];
 for(const [domain,view]of Object.entries(views)){
  const record=byDomain.get(domain);if(!record||view.generation!==status.generation||view.epoch!==status.epoch||view.revision!==record.revision)fail('PRODUCTION_VIEW_IDENTITY_MISMATCH');
  if(!same(view.value,domain==='accounts'?safe:record.value)||domain==='autoConfig'&&!same(view.runtime,expected.runtime))fail('PRODUCTION_CONFIG_OR_RUNTIME_MISMATCH');compared.push(domain);
 }
 for(const r of expected.records){if(r.domain==='deployJournal'){if(!same(journal,currentViewCode().projectLegacyJournal(r.value)))fail('PRODUCTION_JOURNAL_MISMATCH');compared.push(r.domain);}else if(r.domain==='upstream:ech'&&r.value===null)compared.push(r.domain);else if(!compared.includes(r.domain))fail('PRODUCTION_DOMAIN_NOT_VERIFIED');}
 if(!same(init.accounts,safe)||!same(init.autoConfig,byDomain.get('autoConfig').value)||!same(init.runtime,expected.runtime)||init.reliability?.generation!==status.generation||init.reliability?.epoch!==status.epoch||init.reliability?.maintenance!==!!status.maintenance||init.reliability?.protocol!==1)fail('PRODUCTION_INIT_VIEW_MISMATCH');
 for(const t of Object.keys(c.TEMPLATES)){if(!same(init.vars?.[t],byDomain.get('vars:'+t).value)||!same(init.deployConfigs?.[t],byDomain.get('deploy:'+t).value??{mode:'latest',currentSha:null,deployTime:null}))fail('PRODUCTION_INIT_TEMPLATE_MISMATCH');}
 return {accounts:old.length,credentials:credentialCount,allCredentialsAuthenticated:true,originalAccountMetadataPreserved:true,domainsVerified:compared.sort(),runtimeVerified:true,maskedViewsVerified:true,normalizations:expected.normalizations,expected};
}
module.exports={USER_DECISION,verifyDataPolicy,verifyAuthorityStatus,verifyEmptyIdentity,preparePinMetadata,verifyPinReadback,compareRetainedKv,verifyBuild,verifyMigratedViews};
