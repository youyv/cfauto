/* Alternate read-only transport for the ONE existing isolated acceptance host.
 * TLS verification stays enabled; no retries, redirects, DNS or resource changes.
 * Credentials stay in stdin/private files, never command arguments. */
const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');
const {privateDirectory,assertPrivate}=require('./maintenance-client.cjs');
const {privateSave}=require('./cutover-window.cjs');
const HOST='cfauto-accept-47142c9e5f538c32.mak.kdns.fr';
function requestSpec(url,init={}){
 const u=new URL(url);if(u.protocol!=='https:'||u.hostname!==HOST||u.port||u.username||u.password||u.hash)throw Error('TRANSPORT_TARGET_DENIED');
 const method=init.method||'GET',headers=new Headers(init.headers);if([...headers.keys()].some(k=>!['content-type','accept'].includes(k)))throw Error('TRANSPORT_HEADER_DENIED');
 let body=null;if(method==='GET'&&u.pathname==='/app.js'&&(!u.search||/^\?v=[a-f0-9]{8,64}$/.test(u.search))){if(init.body!=null)throw Error('TRANSPORT_BODY_DENIED');}
 else if(method==='POST'&&u.pathname==='/api/reliability/maintenance'&&!u.search){
  if(typeof init.body!=='string'||Buffer.byteLength(init.body)>8192)throw Error('TRANSPORT_BODY_DENIED');
  let x;try{x=JSON.parse(init.body);}catch{throw Error('TRANSPORT_BODY_DENIED');}
  if(!['status','initial_identity'].includes(x.command?.action)||x.command.expected!==null||Object.keys(x.command.args||{}).length||x.target?.account!=='fb86300faed47e7052b380db19fe844d'||x.target.worker!=='cfauto-accept-47142c9e5f538c32'||x.target.namespace!=='93710833ee1c40dd88a3a3a5a526453f')throw Error('TRANSPORT_ACTION_DENIED');body=Buffer.from(init.body);
 }else throw Error('TRANSPORT_ACTION_DENIED');
 if(init.redirect&&init.redirect!=='manual')throw Error('TRANSPORT_REDIRECT_DENIED');return {url:u.href,method,headers:[...headers],body};
}
function parseReply(stdout,rawHeaders,bytes,maxBytes=65536){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>2097152)throw Error('TRANSPORT_LIMIT_INVALID');
 if(rawHeaders.length>65536||bytes.length>maxBytes)throw Error('TRANSPORT_RESPONSE_TOO_LARGE');
 const m=stdout.trim().match(/^(\d{3}) (\d+)$/);if(!m||m[2]!=='0')throw Error('TRANSPORT_TLS_OR_STATUS_INVALID');
 const status=Number(m[1]);if(status<200||status>599||status>=300&&status<400)throw Error('TRANSPORT_REDIRECT_OR_STATUS_DENIED');
 const blocks=rawHeaders.toString('latin1').split(/\r?\n\r?\n/).filter(x=>x.trim()),final=blocks.pop();
 if(!final||!new RegExp('^HTTP/\\S+ '+status+'(?: |\\r?\\n|$)').test(final))throw Error('TRANSPORT_HEADER_STATUS_MISMATCH');
 const headers=new Headers();for(const line of final.split(/\r?\n/).slice(1)){const at=line.indexOf(':');if(at<1)throw Error('TRANSPORT_HEADERS_INVALID');headers.append(line.slice(0,at),line.slice(at+1).trim());}
 if(headers.has('content-encoding')&&headers.get('content-encoding')!=='identity')throw Error('TRANSPORT_ENCODING_DENIED');return new Response([204,205,304].includes(status)?null:bytes,{status,headers});
}
function runCurl(args,config,signal,spawn=cp.spawn){return new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(Error('TRANSPORT_ABORTED'));
 const child=spawn('C:/Windows/System32/curl.exe',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',size=0,settled=false;
 const finish=(err,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);err?reject(err):resolve(value);};
 const abort=()=>{child.kill();finish(Error('TRANSPORT_ABORTED_OUTCOME_UNCERTAIN'));};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 child.stdout.on('data',b=>{size+=b.length;if(size>4096){child.kill();finish(Error('TRANSPORT_OUTPUT_LIMIT'));}else stdout+=b.toString();});child.stderr.on('data',()=>{});
 child.on('error',()=>finish(Error('TRANSPORT_SPAWN_FAILED')));child.on('close',code=>{const error=code===0?null:Object.assign(Error('TRANSPORT_FAILED_OUTCOME_UNCERTAIN'),{curlExitCode:code});finish(error,stdout);});child.stdin.on('error',()=>{});child.stdin.end(config);
});}
async function createIsolatedReadTransport({out,run=runCurl,nativeFetch=fetch}){
 await privateDirectory(out);let sequence=0;
 return async function transport(url,init={}){
  const u=new URL(url);if(u.hostname==='api.cloudflare.com'&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&!u.hash&&(init.method||'GET')==='GET'&&u.pathname.startsWith('/client/v4/accounts/fb86300faed47e7052b380db19fe844d/'))return nativeFetch(url,{...init,redirect:'manual'});
  const s=requestSpec(url,init);if(init.signal?.aborted)throw Error('TRANSPORT_ABORTED');const dir=path.join(out,String(++sequence).padStart(4,'0'));await privateDirectory(dir);
  const bodyFile=path.join(dir,'request.bin'),headerFile=path.join(dir,'headers.bin'),responseFile=path.join(dir,'response.bin');if(s.body)await privateSave(dir,'request.bin',s.body);
  await privateSave(dir,'intent.json',{url:s.url,method:s.method,automaticRetry:false,tlsVerifiedByCurl:true,credentialsInArguments:false});
  const quote=v=>JSON.stringify(v);let config='url = '+quote(s.url)+'\nrequest = '+quote(s.method)+'\n';for(const [k,v] of s.headers)config+='header = '+quote(k+': '+v)+'\n';if(s.body)config+='data-binary = '+quote('@'+bodyFile)+'\n';
  const args=['--disable','--ipv6','--silent','--show-error','--proto','=https','--max-time','25','--connect-timeout','10','--max-filesize','65536','--dump-header',headerFile,'--output',responseFile,'--write-out','%{http_code} %{ssl_verify_result}','--config','-'];
  try{const stdout=await run(args,config,init.signal);for(const file of [headerFile,responseFile]){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('TRANSPORT_RESPONSE_TOO_LARGE');if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(file,'file');await assertPrivate(file);}
   if(init.signal?.aborted)throw Error('TRANSPORT_ABORTED');const response=parseReply(stdout,await fs.readFile(headerFile),await fs.readFile(responseFile));await privateSave(dir,'result.json',{status:response.status,tlsVerificationResult:0,automaticRetry:false});return response;
  }catch(e){await privateSave(dir,'failure.json',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'TRANSPORT_FAILED',...(Number.isSafeInteger(e.curlExitCode)?{curlExitCode:e.curlExitCode}:{}),automaticRetry:false});throw e;}
 };
}
module.exports={HOST,requestSpec,parseReply,runCurl,createIsolatedReadTransport};
