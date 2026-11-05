/* Fixed production control-plane evidence for the staged publisher.
 * GET only. A stable read is NOT a freeze, drain, migration or release approval. */
const path=require('node:path'),fs=require('node:fs/promises');
const {privateDirectory}=require('./maintenance-client.cjs');
const {privateSave,canonical,hash}=require('./cutover-window.cjs');
const {bounded}=require('./execute-remote-acceptance.cjs');
const {active}=require('./backup-worker-readonly.cjs');
const {originalModule}=require('./update-isolated-acceptance.cjs');
const {domainList}=require('./attach-isolated-acceptance-domain.cjs');
const TARGET=Object.freeze({account:'fb86300faed47e7052b380db19fe844d',worker:'manager',namespace:'4c1c769926a740c996b42bbba137f824',zone:'07c10ed4e8c8abfe10e4acf4e90bd3d3',hostname:'kv.mak.kdns.fr'});
const PROTECTED_WORKER='cfauto-accept-47142c9e5f538c32';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const fail=c=>{throw Error(c);};
function routes(envelope){const list=envelope.result,info=envelope.result_info;if(!Array.isArray(list)||new Set(list.map(x=>x.id)).size!==list.length||list.some(x=>typeof x.id!=='string'||typeof x.pattern!=='string'||!(x.script===null||typeof x.script==='string')))fail('ROUTE_INVENTORY_INVALID');if(info&&(info.total_count!==list.length||(info.total_pages!==undefined&&info.total_pages!==1)))fail('ROUTE_INVENTORY_INCOMPLETE');return [...list].sort((a,b)=>a.id.localeCompare(b.id));}
async function readProductionControlPlane({root=path.resolve(__dirname,'..'),out,token,transport=fetch,timeoutMs=30000}){
 root=path.resolve(root);out=path.resolve(out);const rel=path.relative(path.join(root,'.wrangler'),out);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||typeof token!=='string'||!token)fail('PRODUCTION_READ_INPUT_INVALID');
 const realBase=await fs.realpath(path.join(root,'.wrangler')),realParent=await fs.realpath(path.dirname(out)),parentRel=path.relative(realBase,realParent);if(parentRel==='..'||parentRel.startsWith('..'+path.sep)||path.isAbsolute(parentRel))fail('PRODUCTION_READ_PATH_ESCAPE');
 await privateDirectory(out);let sequence=0;const account='/accounts/'+TARGET.account,script=account+'/workers/scripts/'+TARGET.worker;
 async function get(suffix,raw=false){const name=String(++sequence).padStart(3,'0'),url='https://api.cloudflare.com/client/v4'+suffix;
  await privateSave(out,name+'-request.json',{method:'GET',url,readOnly:true,at:new Date().toISOString()});
  const r=await bounded(transport,url,{method:'GET',headers:{Authorization:'Bearer '+token}},timeoutMs);await privateSave(out,name+'-response.bin',r.bytes);await privateSave(out,name+'-transport.json',{status:r.status,sha256:hash(r.bytes),headers:r.headers});
  if(r.status!==200)fail('PRODUCTION_READ_HTTP_FAILED');if(raw)return r;let json;try{json=JSON.parse(r.bytes);}catch{fail('PRODUCTION_READ_JSON_INVALID');}
  if(json.success!==true||!Object.hasOwn(json,'result')||(json.errors!=null&&(!Array.isArray(json.errors)||json.errors.length)))fail('PRODUCTION_READ_API_REJECTED');return json;
 }
 async function controls(){const value={};for(const [key,suffix] of [['settings','/settings'],['deployments','/deployments'],['schedules','/schedules'],['subdomain','/subdomain']])value[key]=(await get(script+suffix)).result;
  value.active=active(value.deployments);if(!uuid(value.active.version)||!uuid(value.active.deployment))fail('PRODUCTION_ACTIVE_INVALID');
  value.domains=domainList(await get(account+'/workers/domains')).sort((a,b)=>a.id.localeCompare(b.id));
  // The zone routes endpoint is a non-cursor list. Any supplied pagination metadata
  // must corroborate a single complete page; no partial page is promoted to full.
  value.routes=routes(await get('/zones/'+TARGET.zone+'/workers/routes'));
  value.protected={};for(const [key,suffix] of [['settings','/settings'],['deployments','/deployments'],['schedules','/schedules'],['subdomain','/subdomain']])value.protected[key]=(await get(account+'/workers/scripts/'+PROTECTED_WORKER+suffix)).result;return value;
 }
 try{const before=await controls(),version=(await get(script+'/versions/'+before.active.version)).result;if(version.id!==before.active.version)fail('PRODUCTION_VERSION_MISMATCH');const content=await get(script+'/content/v2',true),source=await originalModule(content.bytes);const namespace=(await get(account+'/storage/kv/namespaces/'+TARGET.namespace)).result;if(namespace.id!==TARGET.namespace)fail('PRODUCTION_NAMESPACE_MISMATCH');const after=await controls();
  if(canonical(before)!==canonical(after))fail('PRODUCTION_CONTROL_CHANGED_DURING_READ');
  const state={schema:1,target:TARGET,at:new Date().toISOString(),...after,version,namespace,source:{bytes:source.length,sha256:hash(source),responseSha256:hash(content.bytes)},stableAcrossRead:true,routingScope:{zones:[TARGET.zone],accountWideRoutesVerified:false},readOnly:true,freezeProven:false,drainProven:false,migrationReady:false,releaseAllowed:false};await privateSave(out,'worker.js',source);await privateSave(out,'state.json',state);return state;
 }catch(e){await privateSave(out,'failure.json',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'PRODUCTION_READ_FAILED',readOnly:true,releaseAllowed:false});throw e;}
}
function assertLegacyProduction(state,{sourceSha256,version,deployment}){
 if(canonical(state.target)!==canonical(TARGET)||state.stableAcrossRead!==true||state.readOnly!==true||state.releaseAllowed!==false||state.source.sha256!==sourceSha256||state.active.version!==version||state.active.deployment!==deployment)fail('LEGACY_PRODUCTION_IDENTITY_MISMATCH');
 const s=state.settings;if(s.compatibility_date!=='2026-07-16'||canonical(s.compatibility_flags)!=='[]')fail('LEGACY_RUNTIME_UNREVIEWED');
 if(!Array.isArray(s.bindings)||s.bindings.length!==3||new Set(s.bindings.map(b=>b.name)).size!==3)fail('LEGACY_BINDINGS_UNREVIEWED');
 for(const name of ['ACCESS_CODE','GITHUB_TOKEN'])if(!s.bindings.some(b=>b.name===name&&b.type==='secret_text'))fail('LEGACY_SECRET_UNREVIEWED');
 if(!s.bindings.some(b=>b.name==='CONFIG_KV'&&b.type==='kv_namespace'&&b.namespace_id===TARGET.namespace))fail('LEGACY_CONFIG_NAMESPACE_MISMATCH');
 if(state.schedules?.schedules?.length!==1||state.schedules.schedules[0].cron!=='*/5 * * * *'||state.subdomain?.enabled!==false||state.subdomain?.previews_enabled!==false)fail('LEGACY_TRIGGERS_UNREVIEWED');
 const own=state.domains.filter(d=>d.service===TARGET.worker);if(own.length!==1||own[0].hostname!==TARGET.hostname||own[0].zone_id!==TARGET.zone||own[0].previews_enabled!==false)fail('LEGACY_DOMAINS_UNREVIEWED');
 if(canonical(state.version.resources?.bindings)!==canonical(s.bindings))fail('LEGACY_VERSION_BINDINGS_MISMATCH');return {target:TARGET,version,deployment,sourceSha256,legacyShapeVerified:true,freezeProven:false,drainProven:false,releaseAllowed:false};
}
module.exports={TARGET,PROTECTED_WORKER,routes,readProductionControlPlane,assertLegacyProduction};
