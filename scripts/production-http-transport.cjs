/* Fixed production HTTP evidence transport. No browser, redirects, retry, login,
 * resource creation or management writes. Cookies/signatures never enter argv. */
const fs=require('node:fs/promises'),path=require('node:path');
const {privateDirectory,assertPrivate}=require('./maintenance-client.cjs');
const {privateSave,hash,canonical}=require('./cutover-window.cjs');
const {runCurl,parseReply}=require('./isolated-read-transport.cjs');
const {TARGET}=require('./production-control-plane.cjs');
const fail=c=>{throw Error(c);};
const ACTIONS=new Set(['status','audit','audit_list','initial_identity','initial_source_begin','initial_source_frame','initial_source_commit','initial_source_inspect','initial_import_begin','initial_import_resume','initial_import_inspect','initial_activate','initial_activation_inspect','set_maintenance','admission_list','drain_begin','drain_advance','drain_inspect','drain_release','archive_accounts','archive_create','archive_inventory','archive_export_begin','archive_export_frame','account_archive']);
const GETS=new Set(['/','/app.js','/app.css','/api/accounts','/api/accounts/export','/api/init_data','/api/settings','/api/deploy_config','/api/favorites','/api/upstream','/api/deploy_journal','/api/auto_config','/api/reliability/config','/api/reliability/recovery','/api/reliability/tasks']);
function productionRequestSpec(url,init={}){
 const u=new URL(url),method=init.method||'GET',h=new Headers(init.headers);if(u.protocol!=='https:'||u.hostname!==TARGET.hostname||u.port||u.username||u.password||u.hash||u.href!==String(url))fail('PRODUCTION_HTTP_TARGET_DENIED');
 if(init.redirect&&init.redirect!=='manual'&&init.redirect!=='error')fail('PRODUCTION_HTTP_REDIRECT_DENIED');
 if([...h.keys()].some(k=>!['content-type','accept','cookie','origin','x-csrf-token','x-reliability-protocol','idempotency-key','x-config-generation','x-config-epoch','x-config-revision'].includes(k)))fail('PRODUCTION_HTTP_HEADER_DENIED');
 let body=null;
 if(method==='GET'){if(init.body!=null||!GETS.has(u.pathname)&&!/^\/api\/reliability\/tasks\/[a-zA-Z0-9_-]{1,100}$/.test(u.pathname))fail('PRODUCTION_HTTP_ACTION_DENIED');}
 else if(method==='POST'&&u.pathname==='/api/reliability/maintenance'&&!u.search){
  if(typeof init.body!=='string'||Buffer.byteLength(init.body)>8192)fail('PRODUCTION_HTTP_BODY_DENIED');let x;try{x=JSON.parse(init.body);}catch{fail('PRODUCTION_HTTP_BODY_DENIED');}
  if(!ACTIONS.has(x.command?.action)||canonical(x.target)!==canonical({account:TARGET.account,worker:TARGET.worker,namespace:TARGET.namespace})||!['inspect','migration','activation','maintenance','archive'].includes(x.operator))fail('PRODUCTION_HTTP_MAINTENANCE_DENIED');
  if(x.command.action==='set_maintenance'&&x.command.args?.enabled!==false)fail('PRODUCTION_HTTP_MAINTENANCE_DENIED');
  if(h.has('cookie')||h.has('x-csrf-token'))fail('PRODUCTION_HTTP_MAINTENANCE_DENIED');body=Buffer.from(init.body);
 }else if(method==='POST'&&!u.search&&['/api/reliability/config','/api/reliability/tasks','/api/fetch_bindings','/api/get_subdomain'].includes(u.pathname)){
  if(typeof init.body!=='string'||Buffer.byteLength(init.body)>120000||!h.has('cookie')||!h.has('x-csrf-token')||h.get('origin')!=='https://'+TARGET.hostname||h.get('content-type')!=='application/json')fail('PRODUCTION_HTTP_BODY_DENIED');if(['/api/fetch_bindings','/api/get_subdomain'].includes(u.pathname)){let x;try{x=JSON.parse(init.body);}catch{fail('PRODUCTION_HTTP_READ_BODY_DENIED');}if(Object.keys(x).sort().join(',')!==(u.pathname==='/api/fetch_bindings'?'accountId,workerName':'accountId')||! /^[a-f0-9]{32}$/.test(x.accountId)||u.pathname==='/api/fetch_bindings'&&! /^[a-z0-9][a-z0-9-]{0,62}$/.test(x.workerName))fail('PRODUCTION_HTTP_READ_BODY_DENIED');}body=Buffer.from(init.body);
 }else fail('PRODUCTION_HTTP_ACTION_DENIED');
 return {url:u.href,method,headers:[...h],body};
}
async function createProductionHttpTransport({out,run,nativeFetch=fetch,routes=[{family:4,address:'172.67.173.250'},{family:6,address:'2606:4700:3035::6815:1eea'}],minimumConnectionGapMs=5000,resolveAddresses,wait=require('node:timers/promises').setTimeout}){
 if(run===undefined)return require('./native-http-transport.cjs').createNativeHttpTransport({out,mode:'production',routes,resolveAddresses,nativeFetch});
 if(!Array.isArray(routes)||!routes.length||routes.length>4||!Number.isSafeInteger(minimumConnectionGapMs)||minimumConnectionGapMs<0||minimumConnectionGapMs>5000)fail('PRODUCTION_HTTP_ROUTE_INVALID');
 routes=JSON.parse(JSON.stringify(routes));const dnsChecks=[];for(const route of routes){if(Object.keys(route).sort().join(',')!=='address,family'||![4,6].includes(route.family)||require('node:net').isIP(route.address)!==route.family)fail('PRODUCTION_HTTP_ADDRESS_FAMILY_INVALID');const addresses=await (resolveAddresses?resolveAddresses(TARGET.hostname,route.family):(route.family===4?require('node:dns/promises').resolve4(TARGET.hostname):require('node:dns/promises').resolve6(TARGET.hostname)));if(!Array.isArray(addresses)||!addresses.includes(route.address))fail('PRODUCTION_HTTP_EDGE_NOT_IN_CURRENT_DNS');dnsChecks.push({family:route.family,addresses});}
 await privateDirectory(out);await privateSave(out,'routing.json',{hostname:TARGET.hostname,routes,currentDns:dnsChecks,minimumConnectionGapMs,tlsHostnameVerification:true,dnsRecordsModified:false,automaticFallback:false});let seq=0,lastConnectionStarted=0;
 return async function transport(url,init={}){
  const u=new URL(url);
  if(u.protocol==='https:'&&u.hostname==='api.cloudflare.com'&&!u.port&&!u.username&&!u.password&&!u.hash&&(init.method||'GET')==='GET'&&(u.pathname.startsWith('/client/v4/accounts/'+TARGET.account+'/')||u.pathname==='/client/v4/zones/'+TARGET.zone+'/workers/routes'))return nativeFetch(url,{...init,redirect:'manual'});
  const s=productionRequestSpec(url,init);if(init.signal?.aborted)fail('TRANSPORT_ABORTED');
  const ordinal=++seq,route=routes[(ordinal-1)%routes.length],addressFamily='ipv'+route.family,resolvedAddress=route.address,dir=path.join(out,String(ordinal).padStart(5,'0'));await privateDirectory(dir);const request=path.join(dir,'request.bin'),headers=path.join(dir,'headers.bin'),response=path.join(dir,'response.bin');
  if(s.body)await privateSave(dir,'request.bin',s.body);
  // Create curl destinations privately before any response bytes are written.
  // This preserves mode 0600 on POSIX regardless of the caller's umask.
  await privateSave(dir,'headers.bin',Buffer.alloc(0));
  await privateSave(dir,'response.bin',Buffer.alloc(0));
  await privateSave(dir,'intent.json',{at:new Date().toISOString(),url:s.url,method:s.method,bodySha256:s.body?hash(s.body):null,headersSha256:hash(canonical(s.headers)),headerNames:s.headers.map(x=>x[0]),automaticRetry:false,tlsVerificationRequired:true,addressFamily,credentialsInArguments:false});
  let config='url = '+JSON.stringify(s.url)+'\nrequest = '+JSON.stringify(s.method)+'\n';for(const [k,v]of s.headers)config+='header = '+JSON.stringify(k+': '+v)+'\n';if(s.body)config+='data-binary = '+JSON.stringify('@'+request)+'\n';
  const args=['--disable','--'+addressFamily,'--http1.1','--silent','--show-error','--proto','=https','--max-time','25','--connect-timeout','10','--resolve',TARGET.hostname+':443:'+(addressFamily==='ipv6'?'['+resolvedAddress+']':resolvedAddress),'--max-filesize','2097152','--dump-header',headers,'--output',response,'--write-out','%{http_code} %{ssl_verify_result}','--config','-'];
  try{await wait(Math.max(0,minimumConnectionGapMs-(Date.now()-lastConnectionStarted)));if(init.signal?.aborted)fail('TRANSPORT_ABORTED');lastConnectionStarted=Date.now();const stdout=await run(args,config,init.signal);for(const f of [headers,response]){const st=await fs.lstat(f);if(!st.isFile()||st.isSymbolicLink()||st.size>2097152)fail('PRODUCTION_HTTP_RESPONSE_LIMIT');await assertPrivate(f);}
   const raw=await fs.readFile(response),reply=parseReply(stdout,await fs.readFile(headers),raw,2097152);if(init.signal?.aborted)fail('TRANSPORT_ABORTED');await privateSave(dir,'result.json',{at:new Date().toISOString(),status:reply.status,tlsVerificationResult:0,responseSha256:hash(raw),automaticRetry:false});return reply;
  }catch(e){await privateSave(dir,'failure.json',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'PRODUCTION_HTTP_FAILED',...(Number.isSafeInteger(e.curlExitCode)?{curlExitCode:e.curlExitCode}:{}),automaticRetry:false});throw e;}
 };
}
module.exports={productionRequestSpec,createProductionHttpTransport};
