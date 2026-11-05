/* Only the existing synthetic acceptance application's read/login/refusal probes.
 * No production target, provider write, resource creation, migration or activation. */
const fs=require('node:fs/promises'),path=require('node:path');
const {HOST,runCurl,parseReply}=require('./isolated-read-transport.cjs');
const {privateDirectory,assertPrivate}=require('./maintenance-client.cjs');
const {privateSave}=require('./cutover-window.cjs');
const GENERATION='initial_fee278d9d26748f3ba278dab9c010dcb';
const GETS=['/api/accounts/export','/api/accounts','/api/init_data?types=cmliu','/api/settings?type=cmliu','/api/deploy_config?type=cmliu','/api/favorites?type=cmliu','/api/upstream?type=cmliu','/api/deploy_journal'];
function applicationSpec(url,init={}){
 const u=new URL(url);if(u.protocol!=='https:'||u.hostname!==HOST||u.username||u.password||u.port||u.hash)throw Error('APP_TARGET_DENIED');
 if(init.redirect&&init.redirect!=='manual')throw Error('APP_REDIRECT_DENIED');
 const headers=new Headers(init.headers),method=init.method||'GET';if([...headers.keys()].some(k=>!['content-type','cookie','origin','x-csrf-token','x-reliability-protocol'].includes(k)))throw Error('APP_HEADER_DENIED');
 if(headers.has('origin')&&headers.get('origin')!==u.origin)throw Error('APP_ORIGIN_DENIED');
 if(method==='GET'&&(GETS.includes(u.pathname+u.search)||(u.pathname==='/app.js'&&/^\?v=[a-f0-9]{8,64}$/.test(u.search)))){if(init.body!=null)throw Error('APP_BODY_DENIED');return {url:u.href,method,headers:[...headers],body:null,limit:u.pathname==='/app.js'?2097152:65536};}
 if(method!=='POST'||u.search||typeof init.body!=='string'||Buffer.byteLength(init.body)>8192)throw Error('APP_ACTION_DENIED');
 let x;try{x=JSON.parse(init.body);}catch{throw Error('APP_BODY_DENIED');}
 if(u.pathname==='/api/login'){
  if(!x||Object.keys(x).join(',')!=='code'||typeof x.code!=='string'||!x.code||x.code.length>4096)throw Error('APP_LOGIN_DENIED');
 }else if(u.pathname==='/api/reliability/config'){
  if(!x||Object.keys(x).sort().join(',')!=='epoch,generation,key,revision,selector,value'||!/^refusal2_chain_up_[a-f0-9]{32}$/.test(x.key)||x.generation!==GENERATION||x.epoch!==1||x.revision!==1||JSON.stringify(x.selector)!==JSON.stringify({kind:'variables',template:'cmliu'})||JSON.stringify(x.value)!==JSON.stringify([{key:'UNIT_MARKER',value:'must-not-write'}]))throw Error('APP_REFUSAL_PROBE_DENIED');
 }else throw Error('APP_ACTION_DENIED');
 return {url:u.href,method,headers:[...headers],body:Buffer.from(init.body),limit:65536};
}
async function createIsolatedApplicationTransport({out,run=runCurl}){
 await privateDirectory(out);let sequence=0;
 return async(url,init={})=>{
  const s=applicationSpec(url,init);if(init.signal?.aborted)throw Error('APP_ABORTED');const dir=path.join(out,String(++sequence).padStart(4,'0'));await privateDirectory(dir);
  const bodyFile=path.join(dir,'request.bin'),headerFile=path.join(dir,'headers.bin'),responseFile=path.join(dir,'response.bin');if(s.body)await privateSave(dir,'request.bin',s.body);
  // Create curl destinations privately before any response bytes are written.
  // This preserves mode 0600 on POSIX regardless of the caller's umask.
  await privateSave(dir,'headers.bin',Buffer.alloc(0));
  await privateSave(dir,'response.bin',Buffer.alloc(0));
  await privateSave(dir,'intent.json',{url:s.url,method:s.method,responseLimit:s.limit,syntheticAcceptanceOnly:true,automaticRetry:false});
  let config='url = '+JSON.stringify(s.url)+'\nrequest = '+JSON.stringify(s.method)+'\n';for(const [k,v] of s.headers)config+='header = '+JSON.stringify(k+': '+v)+'\n';if(s.body)config+='data-binary = '+JSON.stringify('@'+bodyFile)+'\n';
  const args=['--disable','--ipv6','--silent','--show-error','--proto','=https','--max-time','25','--connect-timeout','10','--max-filesize',String(s.limit),'--dump-header',headerFile,'--output',responseFile,'--write-out','%{http_code} %{ssl_verify_result}','--config','-'];
  try{const stdout=await run(args,config,init.signal);for(const [file,limit] of [[headerFile,65536],[responseFile,s.limit]]){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw Error('APP_RESPONSE_LIMIT');await assertPrivate(file);}
   if(init.signal?.aborted)throw Error('APP_ABORTED');const response=parseReply(stdout,await fs.readFile(headerFile),await fs.readFile(responseFile),s.limit);await privateSave(dir,'result.json',{status:response.status,tlsVerificationResult:0,automaticRetry:false});return response;
  }catch(e){await privateSave(dir,'failure.json',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'APP_TRANSPORT_FAILED',...(Number.isSafeInteger(e.curlExitCode)?{curlExitCode:e.curlExitCode}:{}),automaticRetry:false});throw e;}
 };
}
module.exports={applicationSpec,createIsolatedApplicationTransport,GENERATION,GETS};
