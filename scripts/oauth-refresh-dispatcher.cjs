/* One-shot network adapter for the installed Wrangler's NORMAL OAuth refresh.
 * Wrangler still constructs the grant, validates response, and writes its own auth.
 * No browser, token fabrication, dependency patch, retry, or production API write. */
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const {privateDirectory,assertPrivate}=require('./maintenance-client.cjs');
const {privateSave}=require('./cutover-window.cjs');
const {runCurl,parseReply}=require('./isolated-read-transport.cjs');
const {stringField}=require('./backup-worker-readonly.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const CLIENT='54d11594-84e4-41aa-b438-e81b8fa78ee7';
async function collectRefresh(body,expectedToken){
 const chunks=[];let size=0;const add=b=>{const bytes=Buffer.from(b);size+=bytes.length;if(size>16384)throw Error('OAUTH_BODY_LIMIT');chunks.push(bytes);};
 if(typeof body==='string'||Buffer.isBuffer(body)||body instanceof Uint8Array)add(body);
 else if(body?.[Symbol.asyncIterator])for await(const chunk of body)add(chunk);else throw Error('OAUTH_BODY_DENIED');
 const bytes=Buffer.concat(chunks),params=new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if([...params.keys()].sort().join(',')!=='client_id,grant_type,refresh_token'||params.get('grant_type')!=='refresh_token'||params.get('client_id')!==CLIENT||!expectedToken||params.get('refresh_token')!==expectedToken)throw Error('OAUTH_GRANT_DENIED');return bytes;
}
function createOAuthRefreshDispatcher({fallback,out,claimDirectory,authFile,expectedAuthSha256,run=runCurl}){
 if(!fallback||typeof fallback.dispatch!=='function'||!/^[a-f0-9]{64}$/.test(expectedAuthSha256))throw Error('OAUTH_DISPATCHER_INVALID');
 let attempted=false;
 return {
  dispatch(options,handler){
   const origin=String(options.origin);if(origin!=='https://dash.cloudflare.com'||options.path!=='/oauth2/token')return fallback.dispatch(options,handler);
   const controller=new AbortController();let ended=false;const fail=e=>{if(!ended){ended=true;handler.onError(e);}};
   try{handler.onConnect(()=>controller.abort(),null);}catch(e){fail(e);return true;}
   (async()=>{
    if(attempted||options.method!=='POST')throw Error('OAUTH_REFRESH_SINGLE_ATTEMPT_REQUIRED');attempted=true;
    const original=await fs.readFile(authFile);if(sha(original)!==expectedAuthSha256)throw Error('OAUTH_INPUT_CHANGED');
    const token=stringField(original.toString('utf8'),'refresh_token'),body=await collectRefresh(options.body,token);
    if(controller.signal.aborted)throw Error('OAUTH_ABORTED_BEFORE_DISPATCH');
    await privateDirectory(out);await privateSave(out,'original-auth.toml',original);await privateSave(out,'request.bin',body);
    try{await privateDirectory(claimDirectory);}catch(e){await assertPrivate(claimDirectory);}
    // Claim is keyed by the existing high-entropy refresh token, not an output
    // directory or timeout. A lost response cannot cause the same grant to resend.
    const claim=path.join(claimDirectory,sha(token)+'.json');await fs.writeFile(claim,JSON.stringify({out,authSha256:expectedAuthSha256,requestSha256:sha(body),dispatchedAt:new Date().toISOString(),automaticRetry:false}),{flag:'wx',mode:0o600});
    if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(claim,'file');
    await privateSave(out,'intent.json',{url:'https://dash.cloudflare.com/oauth2/token',method:'POST',grantType:'refresh_token',originalAuthSha256:expectedAuthSha256,requestSha256:sha(body),automaticRetry:false});
    const headerFile=path.join(out,'headers.bin'),responseFile=path.join(out,'response.bin');
    const config='url = "https://dash.cloudflare.com/oauth2/token"\nrequest = "POST"\nheader = "Content-Type: application/x-www-form-urlencoded"\ndata-binary = '+JSON.stringify('@'+path.join(out,'request.bin'))+'\n';
    const args=['--disable','--ipv6','--silent','--show-error','--proto','=https','--max-time','25','--connect-timeout','10','--max-filesize','65536','--dump-header',headerFile,'--output',responseFile,'--write-out','%{http_code} %{ssl_verify_result}','--config','-'];
    try{
     if(sha(await fs.readFile(authFile))!==expectedAuthSha256)throw Error('OAUTH_INPUT_CHANGED_BEFORE_SEND');
     const status=await run(args,config,controller.signal);for(const file of [headerFile,responseFile]){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('OAUTH_RESPONSE_LIMIT');if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(file,'file');}
     if(sha(await fs.readFile(authFile))!==expectedAuthSha256)throw Error('OAUTH_INPUT_CHANGED_AFTER_RESPONSE');
     const bytes=await fs.readFile(responseFile),response=parseReply(status,await fs.readFile(headerFile),bytes);if(controller.signal.aborted)throw Error('OAUTH_ABORTED_OUTCOME_UNCERTAIN');
     await privateSave(out,'result.json',{status:response.status,responseSha256:sha(bytes),tlsVerificationResult:0,automaticRetry:false,authPersistenceDelegatedToWrangler:true});
     const headers=[];for(const [k,v] of response.headers)headers.push(Buffer.from(k),Buffer.from(v));
     handler.onHeaders(response.status,headers,()=>{},response.statusText);handler.onData(bytes);handler.onComplete([]);ended=true;
    }catch(e){await privateSave(out,'failure.json',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'OAUTH_TRANSPORT_FAILED',...(Number.isSafeInteger(e.curlExitCode)?{curlExitCode:e.curlExitCode}:{}),automaticRetry:false,claimRetained:true});throw e;}
   })().catch(e=>fail(Error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'OAUTH_REFRESH_ADAPTER_FAILED')));return true;
  },
  close(...args){return fallback.close?.(...args);},destroy(...args){return fallback.destroy?.(...args);}
 };
}
module.exports={CLIENT,collectRefresh,createOAuthRefreshDispatcher};
