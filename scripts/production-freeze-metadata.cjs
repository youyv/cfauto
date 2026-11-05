/* First production freeze upload metadata only. No network, file writes, approval,
 * secret rotation, Cron change, source pin, data import, or activation capability.
 * Returned metadata contains NEW secrets: persist it only in a private journaled
 * request package after release gates pass. Never print it or regenerate on resume. */
const path=require('node:path'),Module=require('node:module');
const {randomBytes}=require('node:crypto');
const {TARGET,PROTECTED_WORKER,assertLegacyProduction}=require('./production-control-plane.cjs');
const {canonical}=require('./cutover-window.cjs');
const LEGACY=Object.freeze({sourceSha256:'1c0d2c746295e3126322606c7968b191568f0a0a8bf819073975bc6d4651a918',version:'dbfa1570-c444-48b8-85f5-b6a439885c6e',deployment:'0bc0ec2d-9de5-4152-8ff5-117ddad3be36'});
const ISOLATED_KV='93710833ee1c40dd88a3a3a5a526453f';
const SLOTS=Object.freeze(['RELIABILITY_CREDENTIAL_KEYS','RELIABILITY_EVIDENCE_SECRET','RELIABILITY_IDEMPOTENCY_SECRET','RELIABILITY_MAINTENANCE_KEYS','RELIABILITY_RPC_SECRET','RELIABILITY_SNAPSHOT_KEYS']);
const OPERATORS=Object.freeze({inspect:Object.freeze(['inspect']),maintenance:Object.freeze(['inspect','maintain','drain']),migration:Object.freeze(['inspect','migrate']),activation:Object.freeze(['inspect','activate']),archive:Object.freeze(['inspect','archive'])});
const fail=code=>{throw Error(code);};
let validate;
function productionValidator(){if(!validate){const root=path.resolve(__dirname,'..'),output=require('esbuild').buildSync({entryPoints:[path.join(root,'src/reliability/production-config.ts')],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'}),compiled=new Module(path.join(__dirname,'.production-freeze-validator.cjs'),module);compiled.filename=path.join(__dirname,'.production-freeze-validator.cjs');compiled.paths=module.paths;compiled._compile(output.outputFiles[0].text,compiled.filename);validate=compiled.exports.productionConfig;}return validate;}
function plainBindings(){return {CFAUTO_STORAGE_MODE:'authority',RELIABILITY_MANAGER_ACCOUNT:TARGET.account,RELIABILITY_MANAGER_WORKER:TARGET.worker,RELIABILITY_CONFIG_NAMESPACE:TARGET.namespace,RELIABILITY_PROTECTED_RESOURCES:canonical({workers:[{account:TARGET.account,worker:PROTECTED_WORKER}],namespaces:[{account:TARGET.account,namespace:ISOLATED_KV}]})};}
function validateSecrets(bindings){
 if(!bindings||Object.getPrototypeOf(bindings)!==Object.prototype||Object.keys(bindings).sort().join(',')!==SLOTS.join(',')||Object.values(bindings).some(x=>typeof x!=='string'))fail('FREEZE_SECRET_SLOTS_INVALID');
 try{const config=productionValidator()({...plainBindings(),...bindings});
  const operators=config.maintenance?.operators;
  if(!operators||Object.keys(operators).sort().join(',')!==Object.keys(OPERATORS).sort().join(','))fail('FREEZE_OPERATOR_SCOPE_INVALID');
  for(const [name,permissions] of Object.entries(OPERATORS))if(canonical(operators[name].permissions)!==canonical(permissions))fail('FREEZE_OPERATOR_SCOPE_INVALID');
  // This first installation accepts only one new independent key per ring. Old
  // keys/rotations belong to a different, explicitly verified maintenance flow.
  for(const ring of [config.credentials,config.snapshots])if(ring.currentId!=='production_v1'||Object.keys(ring.keys).join(',')!=='production_v1')fail('FREEZE_KEY_RING_INVALID');
 }catch{fail('FREEZE_SECRETS_INVALID');}
 return {...bindings};
}
function newProductionSecretBindings(){
 const key=()=>randomBytes(32).toString('hex'),ring=()=>canonical({currentId:'production_v1',keys:{production_v1:key()}});
 const bindings={RELIABILITY_RPC_SECRET:key(),RELIABILITY_IDEMPOTENCY_SECRET:key(),RELIABILITY_EVIDENCE_SECRET:key(),RELIABILITY_CREDENTIAL_KEYS:ring(),RELIABILITY_SNAPSHOT_KEYS:ring(),RELIABILITY_MAINTENANCE_KEYS:canonical({operators:Object.fromEntries(Object.entries(OPERATORS).map(([id,permissions])=>[id,{permissions,secret:key()}]))})};
 return validateSecrets(bindings);
}
function prepareFreezeMetadata({state,secretBindings,operationId}){
 if(typeof operationId!=='string'||!/^prod_freeze_[a-f0-9]{32}$/.test(operationId))fail('FREEZE_OPERATION_ID_INVALID');
 assertLegacyProduction(state,LEGACY);
 const legacyRuntime=state.version.resources?.script_runtime;
 if(!legacyRuntime||canonical({...legacyRuntime,compatibility_flags:legacyRuntime.compatibility_flags??[]})!==canonical({compatibility_date:'2026-07-16',compatibility_flags:[],usage_model:'standard'}))fail('FREEZE_LEGACY_RUNTIME_UNREVIEWED');
 const protectedBindings=state.protected?.settings?.bindings;
 if(!Array.isArray(protectedBindings)||protectedBindings.filter(b=>b.name==='CONFIG_KV').length!==1||!protectedBindings.some(b=>b.name==='CONFIG_KV'&&b.type==='kv_namespace'&&b.namespace_id===ISOLATED_KV))fail('FREEZE_PROTECTED_NAMESPACE_CHANGED');
 const settings=state.settings,allowed=['annotations','bindings','compatibility_date','compatibility_flags','logpush','observability','placement','tags','tail_consumers','usage_model'];
 if(Object.keys(settings).some(k=>!allowed.includes(k)))fail('FREEZE_UNREVIEWED_SETTING');
 // Keep sampling/invocation logging available for subsequent current-window
 // observations; enabling logging is not proof of global execution drainage.
 const o=settings.observability;
 if(o?.enabled!==true||o.head_sampling_rate!==1||o.logs?.enabled!==true||o.logs.head_sampling_rate!==1||o.logs.persist!==true||o.logs.invocation_logs!==true)fail('FREEZE_OBSERVABILITY_UNSUITABLE');
 const bindings=validateSecrets(secretBindings),metadata={main_module:'worker.js',compatibility_date:'2026-07-16',compatibility_flags:['nodejs_als'],migrations:{new_tag:'cfauto-production-v1',new_sqlite_classes:['ProductionCoordinator']},keep_bindings:['secret_text'],bindings:[{type:'kv_namespace',name:'CONFIG_KV',namespace_id:TARGET.namespace},{type:'durable_object_namespace',name:'RELIABILITY_COORDINATOR',class_name:'ProductionCoordinator'},...Object.entries(plainBindings()).map(([name,text])=>({name,type:'plain_text',text})),...Object.entries(bindings).map(([name,text])=>({name,type:'secret_text',text}))]};
 for(const name of ['placement','usage_model','tags','tail_consumers','logpush','observability'])if(Object.hasOwn(settings,name))metadata[name]=structuredClone(settings[name]);
 metadata.annotations={'workers/message':'cfauto-production-freeze:'+operationId};
 return metadata;
}

/* GET-only comparison for the original upload's readback. This does not authorize
 * journal.verified(): the authority identity/maintenance and namespace ownership
 * probes are deliberately separate required gates. Unknown upload => read only. */
function inspectFreezeReadback({before,after,metadata,operationId,artifact}){
 if(!artifact||Object.keys(artifact).sort().join(',')!=='bytes,sha256'||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<1||artifact.bytes>5*1024*1024||!/^[a-f0-9]{64}$/.test(artifact.sha256))fail('FREEZE_ARTIFACT_INVALID');
 const secretBindings=Object.fromEntries((metadata?.bindings??[]).filter(b=>b.type==='secret_text').map(b=>[b.name,b.text]));
 if(canonical(metadata)!==canonical(prepareFreezeMetadata({state:before,secretBindings,operationId})))fail('FREEZE_REQUEST_METADATA_CHANGED');
 if(!after||canonical(after.target)!==canonical(TARGET)||after.stableAcrossRead!==true||after.readOnly!==true||after.releaseAllowed!==false||after.source?.sha256!==artifact.sha256||after.source?.bytes!==artifact.bytes)fail('FREEZE_READBACK_IDENTITY_MISMATCH');
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
 if(!uuid(after.active?.version)||!uuid(after.active?.deployment)||after.active.version===before.active.version||after.active.deployment===before.active.deployment||after.version?.id!==after.active.version)fail('FREEZE_DEPLOYMENT_NOT_OBSERVED');
 if(after.version.annotations?.['workers/message']!==metadata.annotations['workers/message'])fail('FREEZE_OPERATION_ANNOTATION_MISMATCH');
 for(const name of ['schedules','subdomain','domains','routes','protected'])if(canonical(before[name])!==canonical(after[name]))fail('FREEZE_PRESERVED_CONTROL_CHANGED');
 const settings=after.settings;
 if(!settings||canonical(Object.keys(settings).sort())!==canonical(Object.keys(before.settings).sort()))fail('FREEZE_UNREVIEWED_READBACK_SETTING');
 if(canonical(after.version.resources?.script_runtime)!==canonical({compatibility_date:metadata.compatibility_date,compatibility_flags:metadata.compatibility_flags,usage_model:metadata.usage_model,migration_tag:metadata.migrations.new_tag}))fail('FREEZE_VERSION_RUNTIME_MISMATCH');
 if(settings?.compatibility_date!==metadata.compatibility_date||canonical(settings.compatibility_flags)!==canonical(metadata.compatibility_flags))fail('FREEZE_RUNTIME_CHANGED');
 for(const name of ['placement','usage_model','tags','tail_consumers','logpush','observability'])if(canonical(settings[name])!==canonical(metadata[name]))fail('FREEZE_PRESERVED_SETTING_CHANGED');
 const expected=[...metadata.bindings,...before.settings.bindings.filter(b=>b.type==='secret_text')],actual=settings.bindings;
 if(!Array.isArray(actual)||actual.length!==expected.length||new Set(actual.map(b=>b.name)).size!==actual.length)fail('FREEZE_BINDINGS_MISMATCH');
 let namespace;
 for(const e of expected){const a=actual.find(b=>b.name===e.name);if(!a||a.type!==e.type)fail('FREEZE_BINDINGS_MISMATCH');
  if(e.type==='plain_text'&&a.text!==e.text||e.type==='kv_namespace'&&a.namespace_id!==TARGET.namespace)fail('FREEZE_BINDINGS_MISMATCH');
  if(e.type==='durable_object_namespace'){
   if(a.class_name!=='ProductionCoordinator'||a.script_name&&a.script_name!==TARGET.worker||a.environment&&a.environment!=='production'||! /^[a-f0-9]{32}$/.test(a.namespace_id)||a.namespace_id==='aa46aade99934cda8b3d573fb76cec4a')fail('FREEZE_DO_BINDING_MISMATCH');namespace=a.namespace_id;
  }
 }
 if(canonical(after.version.resources?.bindings)!==canonical(actual))fail('FREEZE_VERSION_BINDINGS_MISMATCH');
 return {target:TARGET,operationId,active:{...after.active},source:{bytes:artifact.bytes,sha256:artifact.sha256},coordinatorNamespace:namespace,controlPlaneReadbackMatches:true,authorityMaintenanceProbeRequired:true,durableNamespaceOwnershipProbeRequired:true,freezeProven:false,drainProven:false,releaseAllowed:false};
}
module.exports={LEGACY,SLOTS,OPERATORS,newProductionSecretBindings,prepareFreezeMetadata,inspectFreezeReadback};
