/* Fixed-host HTTP/1.1 with a reusable TLS connection. HTTP requests are never
 * automatically replayed. Connection attempts may choose another CURRENT DNS
 * address only before an authenticated socket is handed to the HTTP client. */
const fs=require('node:fs/promises'),path=require('node:path'),tls=require('node:tls'),dns=require('node:dns/promises'),{isIP}=require('node:net'),{createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
const {privateDirectory}=require('./maintenance-client.cjs');
const {privateSave,hash,canonical}=require('./cutover-window.cjs');
const {TARGET}=require('./production-control-plane.cjs');
const {HOST,requestSpec}=require('./isolated-read-transport.cjs');
const {applicationSpec}=require('./isolated-application-transport.cjs');
const fail=c=>{throw Error(c);};
function scope(mode,url,init){
 if(mode==='production')return require('./production-http-transport.cjs').productionRequestSpec(url,init);
 if(mode!=='isolated')fail('NATIVE_HTTP_MODE_DENIED');
 return new URL(url).pathname==='/api/reliability/maintenance'?{...requestSpec(url,init),limit:65536}:applicationSpec(url,init);
}
async function validateRoutes(host,routes,resolveAddresses){
 if(!Array.isArray(routes)||routes.length<1||routes.length>4)fail('PRODUCTION_HTTP_ROUTE_INVALID');routes=JSON.parse(JSON.stringify(routes));const checks=[];
 for(const r of routes){if(Object.keys(r).sort().join(',')!=='address,family'||![4,6].includes(r.family)||isIP(r.address)!==r.family)fail('PRODUCTION_HTTP_ADDRESS_FAMILY_INVALID');const addresses=await(resolveAddresses?resolveAddresses(host,r.family):r.family===4?dns.resolve4(host):dns.resolve6(host));if(!Array.isArray(addresses)||!addresses.includes(r.address))fail('PRODUCTION_HTTP_EDGE_NOT_IN_CURRENT_DNS');checks.push({family:r.family,addresses});}return {routes,checks};
}
function secureConnector({host,routes,out,onConnection,tlsConnect=tls.connect,connectTimeoutMs=7000}){
 let nextConnection=0;
 return (options,callback)=>{
  if(options.hostname!==host||Number(options.port||443)!==443){callback(Error('NATIVE_TLS_TARGET_DENIED'),null);return;}
  let ordinal=0,completed=false;const connection=++nextConnection;
  const connect=()=>{if(ordinal>=routes.length){callback(Error('NATIVE_TLS_CONNECTION_FAILED'),null);return;}const route=routes[ordinal++],startedAt=new Date().toISOString();let failed=false;
   const socket=tlsConnect({host:route.address,port:443,servername:host,ALPNProtocols:['http/1.1'],minVersion:'TLSv1.2',rejectUnauthorized:true,checkServerIdentity:(_ignored,cert)=>tls.checkServerIdentity(host,cert)});
   const timer=setTimeout(()=>socket.destroy(Error('NATIVE_TLS_TIMEOUT')),connectTimeoutMs);
   socket.once('error',async e=>{clearTimeout(timer);if(failed||completed)return;failed=true;try{await privateSave(out,'connection-'+connection+'-attempt-'+ordinal+'-failure.json',{route,startedAt,endedAt:new Date().toISOString(),code:typeof e.code==='string'?e.code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'TLS_CONNECTION_ERROR',httpRequestSent:false});}catch{callback(Error('NATIVE_TLS_EVIDENCE_FAILED'),null);return;}if(/^CERT_|^ERR_TLS_CERT|^UNABLE_TO_VERIFY|^DEPTH_ZERO/.test(e.code??'')){completed=true;callback(Error('NATIVE_TLS_AUTHENTICATION_FAILED'),null);return;}connect();});
   socket.once('secureConnect',async()=>{clearTimeout(timer);if(failed||completed)return;const cert=socket.getPeerCertificate(),nameError=tls.checkServerIdentity(host,cert);if(socket.authorized!==true||nameError){completed=true;socket.destroy();callback(Error('NATIVE_TLS_AUTHENTICATION_FAILED'),null);return;}completed=true;
    const evidence={id:connection,host,route,startedAt,connectedAt:new Date().toISOString(),authorized:true,hostnameVerified:true,protocol:socket.getProtocol(),alpn:socket.alpnProtocol||'http/1.1',fingerprint:cert.fingerprint256,noHttpBytesBeforeAuthorization:true};
    try{await privateSave(out,'connection-'+connection+'.json',evidence);onConnection(evidence);callback(null,socket);}catch{socket.destroy();callback(Error('NATIVE_TLS_EVIDENCE_FAILED'),null);}
   });
  };connect();
 };
}
function responseHeaders(input){const out=new Headers();for(const [key,value]of Object.entries(input??{}))for(const v of Array.isArray(value)?value:[value])if(v!==undefined)out.append(key,String(v));return out;}
function decodeEntity(wire,headers,max,allowGzip){
 const h=responseHeaders(headers),encoding=h.get('content-encoding')??'identity';let bytes=wire;
 if(encoding==='gzip'&&allowGzip){try{bytes=require('node:zlib').gunzipSync(wire,{maxOutputLength:max});}catch{fail('NATIVE_HTTP_GZIP_INVALID');}}
 else if(encoding!=='identity')fail('NATIVE_HTTP_ENCODING_DENIED');
 if(bytes.length>max)fail('NATIVE_HTTP_RESPONSE_LIMIT');h.delete('content-encoding');h.delete('transfer-encoding');h.delete('content-length');h.set('content-length',String(bytes.length));return {bytes,headers:h,encoding};
}

async function createNativeHttpTransport({out,mode='production',routes=[{family:4,address:'172.67.173.250'},{family:6,address:'2606:4700:3035::6815:1eea'}],resolveAddresses,nativeFetch=fetch,AgentClass,requestImpl,tlsConnect}){
 if(!['production','isolated'].includes(mode))fail('NATIVE_HTTP_MODE_DENIED');const host=mode==='production'?TARGET.hostname:HOST,verified=await validateRoutes(host,routes,resolveAddresses);await privateDirectory(out);
 await privateSave(out,'routing.json',{mode,host,routes:verified.routes,currentDns:verified.checks,implementation:'node_tls_undici_http1_keepalive',hostnameVerification:true,certificateVerification:true,httpRequestRetry:false,dnsRecordsModified:false});
 const wr=createRequire(require.resolve('wrangler/package.json')),lib=wr('undici'),Agent=AgentClass??lib.Agent,request=requestImpl??lib.request;let lastConnection=null,sequence=0;
 const agent=new Agent({connections:1,pipelining:1,keepAliveTimeout:10000,keepAliveMaxTimeout:60000,connect:secureConnector({host,routes:verified.routes,out,onConnection:value=>{lastConnection=value;},...(tlsConnect?{tlsConnect}:{})})});
 const transport=async(url,init={})=>{
  const u=new URL(url),method=init.method||'GET';
  if(mode==='production'&&u.protocol==='https:'&&u.hostname==='api.cloudflare.com'&&!u.port&&!u.username&&!u.password&&!u.hash&&method==='GET'&&(u.pathname.startsWith('/client/v4/accounts/'+TARGET.account+'/')||u.pathname==='/client/v4/zones/'+TARGET.zone+'/workers/routes'))return nativeFetch(url,{...init,redirect:'manual'});
  const spec=scope(mode,url,init),dir=path.join(out,'request-'+String(++sequence).padStart(5,'0'));await privateDirectory(dir);if(spec.body)await privateSave(dir,'request.bin',spec.body);
  await privateSave(dir,'intent.json',{url:spec.url,method:spec.method,bodySha256:spec.body?hash(spec.body):null,headersSha256:hash(canonical(spec.headers)),httpRequestRetry:false,at:new Date().toISOString()});
  const headers=Object.fromEntries(spec.headers),allowGzip=u.pathname==='/app.js';headers['accept-encoding']=allowGzip?'gzip':'identity';const max=spec.limit??2097152;let response;
  try{response=await request(spec.url,{dispatcher:agent,method:spec.method,headers,...(spec.body?{body:spec.body}:{}),signal:init.signal,maxRedirections:0,idempotent:false,headersTimeout:25000,bodyTimeout:25000});const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>max)fail('NATIVE_HTTP_RESPONSE_LIMIT');chunks.push(Buffer.from(chunk));}const wire=Buffer.concat(chunks);await privateSave(dir,'wire-body.bin',wire);await privateSave(dir,'wire-headers.json',{status:response.statusCode,headers:response.headers});const decoded=decodeEntity(wire,response.headers,max,allowGzip),bytes=decoded.bytes,h=decoded.headers;
   if(!lastConnection?.authorized||lastConnection.host!==host)fail('NATIVE_HTTP_TLS_EVIDENCE_MISSING');
   await privateSave(dir,'response.bin',bytes);await privateSave(dir,'result.json',{status:response.statusCode,headers:[...h],setCookie:h.getSetCookie(),sha256:hash(bytes),bytes:bytes.length,wireSha256:hash(wire),wireBytes:wire.length,encoding:decoded.encoding,tlsConnection:lastConnection.id,tlsVerificationResult:0,httpRequestRetry:false});
   const result=new Response([204,205,304].includes(response.statusCode)?null:bytes,{status:response.statusCode,headers:h});Object.defineProperty(result,'nativeEvidence',{value:{schema:1,request:path.join(dir,'intent.json'),wireBody:path.join(dir,'wire-body.bin'),wireHeaders:path.join(dir,'wire-headers.json'),result:path.join(dir,'result.json'),connection:path.join(out,'connection-'+lastConnection.id+'.json')}});return result;
  }catch(e){try{response?.body?.destroy();}catch{}await privateSave(dir,'failure.json',{error:/^[A-Z0-9_]+$/.test(e.message)?e.message:'NATIVE_HTTP_REQUEST_FAILED',code:typeof e.code==='string'?e.code:null,httpRequestRetry:false});if(['NATIVE_HTTP_RESPONSE_LIMIT','NATIVE_HTTP_ENCODING_DENIED','NATIVE_HTTP_GZIP_INVALID','NATIVE_HTTP_TLS_EVIDENCE_MISSING'].includes(e.message))throw e;throw Error('TRANSPORT_FAILED_OUTCOME_UNCERTAIN');}
 };
 transport.close=()=>agent.destroy();return transport;
}
module.exports={scope,validateRoutes,secureConnector,responseHeaders,decodeEntity,createNativeHttpTransport};
