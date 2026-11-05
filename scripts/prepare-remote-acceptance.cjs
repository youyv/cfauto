/* Prepare an isolated remote acceptance candidate. This module has NO network,
 * provision, deploy, Secret installation, activation or cleanup operation. */
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {privateDirectory}=require('./maintenance-client.cjs');
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=c=>{throw Error(c);};
const ACCOUNT='fb86300faed47e7052b380db19fe844d',MANAGER='manager',NAMESPACE='4c1c769926a740c996b42bbba137f824';
const LOGS=['type-final-2.json','build-final-2.json','verify-final-2.json','credentials-final.json','full-final-2.json','runtime-final.json'];
function inside(root,p){const absolute=path.resolve(p),relative=path.relative(path.resolve(root),absolute);if(!relative||relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))fail('PATH_OUTSIDE_ROOT');return absolute;}
function exportsOf(bytes){const ts=require('typescript'),tree=ts.createSourceFile('candidate.js',new TextDecoder('utf-8',{fatal:true}).decode(bytes),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);if(tree.parseDiagnostics.length)fail('INVALID_BUNDLE');const names=[];for(const n of tree.statements){if(ts.isExportAssignment(n)&&!n.isExportEquals)names.push('default');if(ts.isExportDeclaration(n)&&n.exportClause&&ts.isNamedExports(n.exportClause))for(const e of n.exportClause.elements)names.push(e.name.text);if(ts.isClassDeclaration(n)&&n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)&&n.name)names.push(n.name.text);}if(names.sort().join(',')!=='ProductionCoordinator,default')fail('UNEXPECTED_BUNDLE_EXPORTS');return names;}
async function prepareRemoteAcceptance({worker,validationDir,out,root=path.resolve(__dirname,'..')}){
 if(typeof worker!=='string'||!/^cfauto-accept-[a-f0-9]{16}$/.test(worker))fail('INVALID_ISOLATED_WORKER');
 root=path.resolve(root);validationDir=inside(path.join(root,'.wrangler'),validationDir);out=inside(path.join(root,'.wrangler'),out);
 const artifact=path.join(root,'dist','worker.js'),stat=await fs.lstat(artifact);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>5*1024*1024)fail('INVALID_BUNDLE');
 const bytes=await fs.readFile(artifact),sha256=digest(bytes),exports=exportsOf(bytes),hashes=JSON.parse(await fs.readFile(path.join(validationDir,'artifact-hashes.json'),'utf8'));
 if(hashes['dist/worker.js']!==sha256)fail('VALIDATED_ARTIFACT_MISMATCH');
 const validation=[];for(const name of LOGS){const raw=await fs.readFile(path.join(validationDir,name)),log=JSON.parse(raw);if(log.code!==0)fail('LOCAL_GATE_FAILED');if(name==='build-final-2.json'&&!String(log.stdout).includes(sha256))fail('BUILD_LOG_MISMATCH');validation.push({file:name,sha256:digest(raw),code:0});}
 if(digest(await fs.readFile(artifact))!==sha256)fail('ARTIFACT_CHANGED');
 const manifest={schema:1,purpose:'isolated-remote-acceptance',preparedAt:new Date().toISOString(),productionDeploymentAllowed:false,remotePublicationAllowed:false,
  target:{account:ACCOUNT,worker,namespace:null,mustCreateFreshWorker:true,mustCreateFreshNamespace:true},
  protectedProduction:{account:ACCOUNT,worker:MANAGER,namespace:NAMESPACE},
  artifact:{file:'candidate-worker.js',sha256,bytes:bytes.length,exports},validationDirectory:path.relative(root,validationDir).split(path.sep).join('/'),validation,
  runtime:{compatibility_date:'2026-07-16',compatibility_flags:['nodejs_als'],class_name:'ProductionCoordinator',binding:'RELIABILITY_COORDINATOR',sqlite:true},
  requiredSecretSlots:['ACCESS_CODE','RELIABILITY_RPC_SECRET','RELIABILITY_IDEMPOTENCY_SECRET','RELIABILITY_EVIDENCE_SECRET','RELIABILITY_CREDENTIAL_KEYS','RELIABILITY_SNAPSHOT_KEYS','RELIABILITY_MAINTENANCE_KEYS'],
  secretPolicy:{generateIndependentRandomKeys:true,reuseProductionSecrets:false,maintenancePermissions:['inspect'],persistOnlyWithPrivateACL:true},
  runtimePolicy:{storageMode:'authority',initialGeneration:null,maintenance:true,cron:[],customRoutes:[],customDomains:[],versionURLs:false,workersDevForAuthenticatedProbeOnly:true},
  allowedMaintenanceActions:['status','audit','audit_list'],
  checks:['private_signature_rejection','wrong_target_rejection','inspect_only_role_denial','original_status_ack_replay','audit_record_persistence','actual_DO_binding_and_export','empty_authority_refuses_business_write'],
  retainWorkerNamespaceAndEvidence:true,initialLegacyCutover:false,
  unresolved:['Fresh resource absence/provisioning must be verified before any remote publication','Resolve only newly created namespace ID; never bind the production CONFIG_KV','Install independent keys and exact protected-production targets','Use only the copied validated production bundle; never a local fixture','Remote publication/execution workflow remains a separate gated step','This plan is not a deployable Wrangler configuration or a release approval']};
 await privateDirectory(out);
 async function save(name,value){const file=path.join(out,name);await fs.writeFile(file,Buffer.isBuffer(value)?value:JSON.stringify(value,null,2),{flag:'wx',mode:0o600});if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(file,'file');}
 await save('candidate-worker.js',bytes);await save('acceptance-plan.json',manifest);if(digest(await fs.readFile(path.join(out,'candidate-worker.js')))!==sha256)fail('SAVED_ARTIFACT_MISMATCH');
 return {directory:out,worker,artifactSha256:sha256,localGateLogs:validation.length,remotePublicationAllowed:false,productionDeploymentAllowed:false};
}
module.exports={prepareRemoteAcceptance,exportsOf};
if(require.main===module)(async()=>{const args=process.argv.slice(2),o={};if(args.length!==6)fail('USAGE_WORKER_VALIDATION_OUT');for(let i=0;i<args.length;i+=2){if(!['--worker','--validation-dir','--out'].includes(args[i])||o[args[i]])fail('INVALID_OPTIONS');o[args[i]]=args[i+1];}console.log(JSON.stringify(await prepareRemoteAcceptance({worker:o['--worker'],validationDir:o['--validation-dir'],out:o['--out']})));})().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'ACCEPTANCE_PREPARATION_FAILED');process.exitCode=1;});
