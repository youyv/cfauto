/* Capture/replay code-bound operator tool gates. No build, deploy, auth loading,
 * business mutation or release approval. Commands are fixed, never operator input. */
const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');
const {collectSourceInputs,hashInputs}=require('./build-info.cjs');
const {canonical,hash,privateSave}=require('./cutover-window.cjs');
const {privateDirectory}=require('./maintenance-client.cjs');
const {readPrivateBytes}=require('./cutover-evidence.cjs');
const {FULL_COMMAND,validationFiles,readTestSuites,collectTestScope,assertFullTestOutput}=require('./test-scope.cjs');
const COMMANDS=Object.freeze({type:Object.freeze(['node_modules/typescript/bin/tsc','--noEmit']),verify:Object.freeze(['verify.js']),full:FULL_COMMAND});
const DEPENDENCIES=Object.freeze(['node_modules/typescript/bin/tsc','node_modules/typescript/package.json','node_modules/vitest/vitest.mjs','node_modules/vitest/package.json','node_modules/esbuild/package.json']);
const fail=c=>{throw Error(c);};
async function collectToolGateInputs(root){
 root=path.resolve(root);const files=new Map(),tests=[];
 async function add(file){const full=path.join(root,file),stat=await fs.lstat(full);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>32*1024*1024)fail('TOOL_GATE_UNSAFE_INPUT');const bytes=await fs.readFile(full);files.set(file,{file,bytes:bytes.length,sha256:hash(bytes)});}
 async function walk(dir){for(const file of validationFiles(root,dir)){await add(file);if(/^test\/.*[.]test[.]ts$/.test(file))tests.push(file);}}
 for(const i of collectSourceInputs(root))await add(i.path);for(const dir of ['scripts','test'])await walk(dir);
 for(const file of ['verify.js','vitest.config.ts','playwright.config.cjs','wrangler.toml','dist/build-manifest.json','dist/worker.js','src/frontend-bundle.ts'])await add(file);
 const dependencies=[];for(const file of DEPENDENCIES){const bytes=await fs.readFile(path.join(root,file));if(bytes.length>1024*1024)fail('TOOL_GATE_DEPENDENCY_TOO_LARGE');dependencies.push({file,bytes:bytes.length,sha256:hash(bytes)});}
 const manifest=JSON.parse(await fs.readFile(path.join(root,'dist/build-manifest.json'),'utf8')),sourceSha256=hashInputs(collectSourceInputs(root)),worker=files.get('dist/worker.js');if(manifest.build?.sourceSha256!==sourceSha256||manifest.worker?.sha256!==worker.sha256||manifest.worker.bytes!==worker.bytes||typeof manifest.build.buildId!=='string')fail('TOOL_GATE_CANDIDATE_STALE');
 tests.sort();if(canonical(tests)!==canonical(readTestSuites(root).files))fail('TOOL_GATE_TEST_DISCOVERY_INCOMPLETE');
 return {schema:2,root,testScope:collectTestScope(root),candidate:{buildId:manifest.build.buildId,sourceSha256,workerSha256:worker.sha256,workerBytes:worker.bytes},runtime:{node:process.version,execPath:process.execPath,platform:process.platform,arch:process.arch},files:[...files.values()].sort((a,b)=>a.file.localeCompare(b.file)),discoveredTests:tests,dependencies,dependencyScope:'entrypoints_and_package_metadata_not_transitive_hashes'};
}
async function inside(root,directory,existing){root=path.resolve(root);directory=path.resolve(directory);const base=await fs.realpath(path.join(root,'.wrangler')),parent=await fs.realpath(existing?directory:path.dirname(directory)),rel=path.relative(base,parent);if(existing&&!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))fail('TOOL_GATE_PATH_ESCAPE');return directory;}
async function replayToolGates({root=path.resolve(__dirname,'..'),directory}){
 root=path.resolve(root);directory=await inside(root,directory,true);const references=[];
 async function bytes(file,max=20*1024*1024){const b=await readPrivateBytes(path.join(directory,file),max);references.push({file:path.relative(root,path.join(directory,file)),sha256:hash(b)});return b;}
 const beforeBytes=await bytes('inputs-before.json'),afterBytes=await bytes('inputs-after.json'),before=JSON.parse(beforeBytes),after=JSON.parse(afterBytes);
 if(!beforeBytes.equals(Buffer.from(canonical(before)))||!afterBytes.equals(Buffer.from(canonical(after)))||!beforeBytes.equals(afterBytes)||canonical(before)!==canonical(await collectToolGateInputs(root)))fail('TOOL_GATE_INPUTS_CHANGED');
 const intent=JSON.parse(await bytes('intent.json'));if(canonical(intent)!==canonical({schema:1,kind:'operator_tool_gates',root,inputsSha256:hash(beforeBytes),commands:COMMANDS,publicationAllowed:false}))fail('TOOL_GATE_INTENT_CHANGED');
 let previousEnd=0;const processes=[],checks={};
 for(const [kind,args] of Object.entries(COMMANDS)){
  const stem='tools-'+kind,start=JSON.parse(await bytes(stem+'.start.json')),child=JSON.parse(await bytes(stem+'.child.json')),end=JSON.parse(await bytes(stem+'.end.json')),stdout=(await bytes(stem+'.stdout.log')).toString('utf8').replace(/\x1b\[[0-9;]*m/g,'');await bytes(stem+'.stderr.log');
  const startAt=Date.parse(start.startedAt),endAt=Date.parse(end.endedAt);
  if(start.name!==stem||end.name!==stem||start.cwd!==root||canonical(start.args)!==canonical(args)||start.inputsSha256!==hash(beforeBytes)||end.inputsSha256!==hash(beforeBytes)||end.code!==0||end.signal!==null||!Number.isSafeInteger(child.pid)||child.pid<1||!Number.isSafeInteger(child.helperPid)||child.helperPid<1||child.pid!==end.pid||child.helperPid!==start.helperPid||child.helperPid!==end.helperPid||start.startedAt!==child.startedAt||start.startedAt!==end.startedAt||!Number.isFinite(startAt)||!Number.isFinite(endAt)||endAt<startAt||startAt<previousEnd)fail('TOOL_GATE_PROCESS_RECEIPT_INVALID');
  if(kind==='verify'&&!/Errors:\s+0\s+Warnings:\s+0/.test(stdout))fail('TOOL_GATE_VERIFY_FAILED');
  if(kind==='full'){try{checks.full=assertFullTestOutput(stdout,before.discoveredTests.length);}catch{fail('TOOL_GATE_FULL_SCOPE_INVALID');}}
  checks[kind]={...(checks[kind]??{}),code:0};previousEnd=endAt;processes.push({kind,pid:child.pid,helperPid:child.helperPid,startedAt:start.startedAt,endedAt:end.endedAt});
 }
 return {schema:1,scope:'code_bound_operator_tool_gates',candidate:before.candidate,inputsSha256:hash(beforeBytes),checks,processes,references,currentProcessIdentityRecheckRequired:true,buildRerun:false,browserExecuted:false,publicationAllowed:false};
}
async function runToolGates({root=path.resolve(__dirname,'..'),out}){
 root=path.resolve(root);out=await inside(root,out,false);const snapshot=Buffer.from(canonical(await collectToolGateInputs(root))),inputsSha256=hash(snapshot);await privateDirectory(out);await privateSave(out,'inputs-before.json',snapshot);await privateSave(out,'intent.json',{schema:1,kind:'operator_tool_gates',root,inputsSha256,commands:COMMANDS,publicationAllowed:false});
 try{
  for(const [kind,args] of Object.entries(COMMANDS)){
   if(canonical(await collectToolGateInputs(root))!==snapshot.toString('utf8'))fail('TOOL_GATE_INPUTS_CHANGED');
   const name='tools-'+kind,startedAt=new Date().toISOString(),helperPid=process.pid;
   await privateSave(out,name+'.start.json',{name,args,cwd:root,startedAt,helperPid,inputsSha256});
   for(const ext of ['stdout.log','stderr.log'])await privateSave(out,name+'.'+ext,Buffer.alloc(0));
   const stdout=await fs.open(path.join(out,name+'.stdout.log'),'a'),stderr=await fs.open(path.join(out,name+'.stderr.log'),'a');let result;
   try{result=await new Promise((resolve,reject)=>{let child;try{child=cp.spawn(process.execPath,args,{cwd:root,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',BROWSER:'none'},windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]});}catch{reject(Error('TOOL_GATE_SPAWN_FAILED'));return;}const saved=Number.isSafeInteger(child.pid)?privateSave(out,name+'.child.json',{pid:child.pid,helperPid,startedAt}):Promise.reject(Error('TOOL_GATE_SPAWN_FAILED'));saved.catch(()=>{});let spawnFailed=false;child.on('error',()=>{spawnFailed=true;});child.on('close',async(code,signal)=>{try{await saved;await privateSave(out,name+'.end.json',{name,pid:child.pid,helperPid,code,signal,startedAt,endedAt:new Date().toISOString(),inputsSha256});if(spawnFailed)reject(Error('TOOL_GATE_SPAWN_FAILED'));else resolve({code,signal});}catch{reject(Error('TOOL_GATE_RECEIPT_WRITE_FAILED'));}});});}finally{await stdout.sync();await stderr.sync();await stdout.close();await stderr.close();}
   if(result.code!==0||result.signal!==null)fail('TOOL_GATE_COMMAND_FAILED');
  }
  const after=Buffer.from(canonical(await collectToolGateInputs(root)));await privateSave(out,'inputs-after.json',after);if(!snapshot.equals(after))fail('TOOL_GATE_INPUTS_CHANGED');const report=await replayToolGates({root,directory:out});await privateSave(out,'report.json',report);return report;
 }catch(e){await privateSave(out,'failure.json',{at:new Date().toISOString(),error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'TOOL_GATE_FAILED',publicationAllowed:false,automaticRetry:false});throw e;}
}
module.exports={COMMANDS,DEPENDENCIES,collectToolGateInputs,replayToolGates,runToolGates};
