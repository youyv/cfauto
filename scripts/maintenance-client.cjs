/* Explicit, single-attempt maintenance client. No deploy, provision, bootstrap,
 * unknown-write retry, cleanup or legacy cutover capability. */
const fs=require('node:fs/promises');
const path=require('node:path');
const Module=require('node:module');
const {createHash,randomUUID}=require('node:crypto');
const fail=code=>{throw new Error(code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let protocol;
function localProtocol(){if(!protocol){const root=path.resolve(__dirname,'..'),output=require('esbuild').buildSync({entryPoints:[path.join(root,'src/reliability/maintenance-protocol.ts')],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});const compiled=new Module(path.join(root,'scripts','.maintenance-protocol.cjs'),module);compiled.filename=path.join(root,'scripts','.maintenance-protocol.cjs');compiled.paths=module.paths;compiled._compile(output.outputFiles[0].text,compiled.filename);protocol=compiled.exports;}return protocol;}
async function assertPrivate(filename){
 const stat=await fs.lstat(filename);if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))fail('UNSAFE_LOCAL_PATH');
 if(process.platform==='win32'){
  await require('./private-path.cjs').windowsPrivatePath(filename);
 }else if((stat.mode&0o077)!==0||stat.uid!==process.getuid())fail('PRIVATE_PERMISSIONS_REQUIRED');
}
async function readPrivateJson(filename,max=16384){filename=path.resolve(filename);await assertPrivate(filename);await assertPrivate(path.dirname(filename));const before=await fs.lstat(filename);if(before.size>max||!before.isFile())fail('INVALID_LOCAL_FILE');const bytes=await fs.readFile(filename);await assertPrivate(filename);const after=await fs.lstat(filename);if(bytes.length>max||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('LOCAL_FILE_CHANGED');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_LOCAL_JSON');}}
async function privateDirectory(out){out=path.resolve(out);await fs.mkdir(out,{mode:0o700});if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(out,'directory');await assertPrivate(out);return out;}
function profileValue(profile){if(!profile||Object.keys(profile).sort().join(',')!=='endpoint,operator,secret,target')fail('INVALID_PROFILE');const endpoint=new URL(profile.endpoint);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/api/reliability/maintenance'||endpoint.search||endpoint.hash||endpoint.href!==profile.endpoint)fail('INVALID_ENDPOINT');return profile;}
async function maintenanceClient({profile,command,out,transport=fetch,timeoutMs=30000}){
 // Clone locally before any await. Do not execute code from profile or evidence.
 profile=profileValue(JSON.parse(JSON.stringify(profile)));command=localProtocol().maintenanceCommand(command);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('INVALID_TIMEOUT');
 const message={version:1,target:profile.target,operator:profile.operator,at:Date.now(),nonce:randomUUID(),command};
 const signed=await localProtocol().signMaintenance(message,profile.secret);const body=JSON.stringify(signed);
 out=await privateDirectory(out);const save=(name,value)=>fs.writeFile(path.join(out,name),typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
 await save('intent.json',{target:profile.target,endpoint:profile.endpoint,operator:profile.operator,command,requestSha256:hash(body),startedAt:new Date().toISOString(),automaticRetry:false});
 const controller=new AbortController();let timer,reader;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('REQUEST_DEADLINE'));},timeoutMs);});
 try{
  const pending=Promise.resolve().then(()=>transport(profile.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body,redirect:'manual',signal:controller.signal}));void pending.then(response=>{if(controller.signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
  const response=await Promise.race([pending,deadline]);if(response.redirected||response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});fail('REDIRECT_DENIED');}
  reader=response.body?.getReader();const chunks=[];let size=0;if(reader)for(;;){const {value,done}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;if(size>65536)fail('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}
  const bytes=Buffer.concat(chunks);await save('response.bin',bytes);let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_RESPONSE');}
  const fields=result&&typeof result==='object'?Object.keys(result).sort().join(','):'';
  if(response.status===200?fields!=='value':fields!=='error'||!['INVALID','CONFLICT','MAINTENANCE','NOT_READY'].includes(result.error))fail('INVALID_RESPONSE');
  const summary={commandId:command.id,action:command.action,httpStatus:response.status,responseSha256:hash(bytes),receivedBytes:size,acknowledged:response.status===200,error:response.status===200?null:result.error,automaticRetry:false};await save('summary.json',summary);return summary;
 }catch(error){const safe=['REQUEST_DEADLINE','REDIRECT_DENIED','RESPONSE_TOO_LARGE','INVALID_RESPONSE'].includes(error.message)?error.message:'REQUEST_FAILED_OUTCOME_UNCERTAIN';await save('failure.json',{commandId:command.id,error:safe,automaticRetry:false,instruction:'Preserve command ID and inspect durable server receipt; never retry an unknown external write.'});throw new Error(safe);}
 finally{clearTimeout(timer);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
}
module.exports={maintenanceClient,readPrivateJson,assertPrivate,privateDirectory};
if(require.main===module)(async()=>{const args=process.argv.slice(2),options={};if(args.length!==6)fail('USAGE_PROFILE_INTENT_OUT');for(let i=0;i<args.length;i+=2){if(!['--profile','--intent','--out'].includes(args[i])||Object.hasOwn(options,args[i]))fail('INVALID_OPTIONS');options[args[i]]=args[i+1];}const profile=await readPrivateJson(options['--profile']),command=await readPrivateJson(options['--intent']);const summary=await maintenanceClient({profile,command,out:options['--out']});console.log(JSON.stringify(summary,null,2));if(!summary.acknowledged)process.exitCode=1;})().catch(error=>{const safe=/^[A-Z0-9_]+$/.test(error.message)?error.message:'MAINTENANCE_CLIENT_FAILED';console.error('Maintenance client: '+safe);process.exitCode=1;});
