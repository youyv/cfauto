/* Offline replay of the ONE synthetic isolated application's captured acceptance.
 * Reads raw request/response bytes; does not trust report booleans or execute any
 * downloaded/app/evidence code. No fetch, browser, login, refusal resend or writes. */
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {readPrivateBytes}=require('./cutover-evidence.cjs');
const {canonical,hash}=require('./cutover-window.cjs');
const {HOST,parseReply}=require('./isolated-read-transport.cjs');
const {GENERATION}=require('./isolated-application-transport.cjs');
const {localInitialCodecs}=require('./initial-source-codecs.cjs');
const fail=c=>{throw Error(c);},digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ROWS=Object.freeze([
 ['login','POST','/api/login'],['app-bootstrap','GET',null],['accounts-export','GET','/api/accounts/export'],['accounts-masked','GET','/api/accounts'],['init-data','GET','/api/init_data?types=cmliu'],['vars','GET','/api/settings?type=cmliu'],['deploy','GET','/api/deploy_config?type=cmliu'],['favorites','GET','/api/favorites?type=cmliu'],['upstream','GET','/api/upstream?type=cmliu'],['journal','GET','/api/deploy_journal'],['maintenance-refusal','POST','/api/reliability/config'],['vars-after-refusal','GET','/api/settings?type=cmliu']
].map(Object.freeze));
let readAccounts;
function credentialReader(){if(!readAccounts){const root=path.resolve(__dirname,'..'),output=require('esbuild').buildSync({entryPoints:[path.join(root,'src/reliability/credential-accounts.ts')],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'}),m=new Module(path.join(__dirname,'.isolated-credential-replay.cjs'),module);m.filename=path.join(__dirname,'.isolated-credential-replay.cjs');m.paths=module.paths;m._compile(output.outputFiles[0].text,m.filename);readAccounts=m.exports.readCredentialAccounts;}return readAccounts;}
function json(bytes){try{return localInitialCodecs().parseStrictBackupJson(bytes);}catch{fail('APP_REPLAY_JSON_INVALID');}}
async function replayIsolatedApplicationEvidence({root=path.resolve(__dirname,'..'),directory,fixtureFile,secretFile,expected}){
 root=path.resolve(root);expected=JSON.parse(canonical(expected));
 if(!expected||Object.keys(expected).sort().join(',')!=='buildId,sourceSha256,upgradeId,version,workerSha256'||!digest(expected.sourceSha256)||!digest(expected.workerSha256)||typeof expected.buildId!=='string'||!expected.buildId||expected.buildId.length>128||!/^chain_up_[a-f0-9]{32}$/.test(expected.upgradeId)||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expected.version))fail('APP_REPLAY_EXPECTATION_INVALID');
 const base=await fs.realpath(path.join(root,'.wrangler')),references=[];
 async function inside(file){file=path.resolve(file);const real=await fs.realpath(file),rel=path.relative(base,real),logical=path.relative(path.join(root,'.wrangler'),file);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||logical==='..'||logical.startsWith('..'+path.sep)||path.isAbsolute(logical)||(await fs.lstat(file)).isSymbolicLink())fail('APP_REPLAY_PATH_DENIED');return file;}
 directory=await inside(directory);
 async function read(file,max=65536){file=await inside(file);const bytes=await readPrivateBytes(file,max);references.push({file:path.relative(root,file),sha256:hash(bytes)});return bytes;}
 const source=json(await read(fixtureFile)),secrets=json(await read(secretFile));
 if(source.accountId!=='e'.repeat(32)||!digest(source.tokenSha256)||source.sourceKind!=='synthetic_nonfunctional_credentials'||source.noExternalBusinessRequestAllowed!==true||typeof secrets.bindings?.ACCESS_CODE!=='string'||!secrets.bindings.ACCESS_CODE||typeof secrets.bindings.RELIABILITY_CREDENTIAL_KEYS!=='string')fail('APP_REPLAY_SYNTHETIC_FIXTURE_INVALID');
 const report=json(await read(path.join(directory,'report.json'))),target={account:'fb86300faed47e7052b380db19fe844d',worker:'cfauto-accept-47142c9e5f538c32',namespace:'93710833ee1c40dd88a3a3a5a526453f'};
 if(report.schema!==1||canonical(report.target)!==canonical(target)||report.upgradeId!==expected.upgradeId||report.version!==expected.version||report.artifactSha256!==expected.workerSha256||report.generation!==GENERATION||report.epoch!==1)fail('APP_REPLAY_REPORT_IDENTITY_MISMATCH');
 const transport=await inside(path.join(directory,'http-transport')),entries=(await fs.readdir(transport)).sort(),required=ROWS.map((_,i)=>String(i+1).padStart(4,'0'));if(canonical(entries)!==canonical(required))fail('APP_REPLAY_TRANSPORT_INVENTORY_MISMATCH');
 const values={};
 for(let i=0;i<ROWS.length;i++){
  const [name,method,suffix]=ROWS[i],dir=await inside(path.join(transport,required[i])),limit=name==='app-bootstrap'?2097152:65536,url='https://'+HOST+(suffix??'/app.js?v='+expected.workerSha256.slice(0,8)),intent=json(await read(path.join(dir,'intent.json'))),result=json(await read(path.join(dir,'result.json')));
  if(canonical(intent)!==canonical({url,method,responseLimit:limit,syntheticAcceptanceOnly:true,automaticRetry:false}))fail('APP_REPLAY_REQUEST_SCOPE_MISMATCH');
  const status=name==='maintenance-refusal'?503:200;if(canonical(result)!==canonical({status,tlsVerificationResult:0,automaticRetry:false}))fail('APP_REPLAY_TRANSPORT_RESULT_MISMATCH');
  const bytes=await read(path.join(dir,'response.bin'),limit),headers=await read(path.join(dir,'headers.bin')),response=parseReply(status+' 0',headers,bytes,limit);
  let nativeMeta=null;try{await fs.lstat(path.join(dir,'native-transport.json'));nativeMeta=json(await read(path.join(dir,'native-transport.json')));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(nativeMeta){
   if(nativeMeta.schema!==1||nativeMeta.implementation!=='node_tls_undici_http1'||nativeMeta.curlUsed!==false||!nativeMeta.evidence)fail('APP_REPLAY_NATIVE_PROVENANCE_INVALID');const p=nativeMeta.evidence;
   const req=json(await read(p.request)),wire=await read(p.wireBody,limit),wireHeaders=json(await read(p.wireHeaders)),received=json(await read(p.result)),connection=json(await read(p.connection));
   if(req.url!==url||req.method!==method||req.httpRequestRetry!==false||connection.host!==HOST||connection.authorized!==true||connection.hostnameVerified!==true||!['TLSv1.2','TLSv1.3'].includes(connection.protocol)||received.tlsConnection!==connection.id||received.status!==status||received.tlsVerificationResult!==0||received.httpRequestRetry!==false||wireHeaders.status!==status||received.wireSha256!==hash(wire)||received.wireBytes!==wire.length)fail('APP_REPLAY_NATIVE_TLS_OR_REQUEST_MISMATCH');
   const decoded=require('./native-http-transport.cjs').decodeEntity(wire,wireHeaders.headers,limit,name==='app-bootstrap');if(!decoded.bytes.equals(bytes)||received.sha256!==hash(bytes)||received.bytes!==bytes.length||received.encoding!==decoded.encoding||canonical([...decoded.headers].sort())!==canonical([...response.headers].sort())||canonical(decoded.headers.getSetCookie())!==canonical(response.headers.getSetCookie()))fail('APP_REPLAY_NATIVE_ENTITY_MISMATCH');
   if(method==='GET'&&req.bodySha256!==null)fail('APP_REPLAY_NATIVE_REQUEST_BODY_MISMATCH');
  }
  if(method==='POST'){
   const body=await read(path.join(dir,'request.bin')),wanted=name==='login'?{code:secrets.bindings.ACCESS_CODE}:{key:'refusal2_'+expected.upgradeId,generation:GENERATION,epoch:1,revision:1,selector:{kind:'variables',template:'cmliu'},value:[{key:'UNIT_MARKER',value:'must-not-write'}]};
   if(canonical(json(body))!==canonical(wanted))fail('APP_REPLAY_POST_BODY_MISMATCH');if(nativeMeta&&json(await read(nativeMeta.evidence.request)).bodySha256!==hash(body))fail('APP_REPLAY_NATIVE_REQUEST_BODY_MISMATCH');
  }else{try{await fs.lstat(path.join(dir,'request.bin'));fail('APP_REPLAY_UNEXPECTED_GET_BODY');}catch(e){if(e.code!=='ENOENT')throw e;}}
  if(name==='login'){
   const summary=json(await read(path.join(directory,'login-summary.json'))),cookies=response.headers.getSetCookie();
   if(canonical(summary)!==canonical({status:200,sha256:hash(bytes),cookies:cookies.length})||cookies.length!==2||!cookies.some(c=>c.startsWith('__Host-auth='))||!cookies.some(c=>c.startsWith('__Host-csrf='))||json(bytes).success!==true)fail('APP_REPLAY_LOGIN_INVALID');
   continue;
  }
  const named=await read(path.join(directory,name+'.bin'),limit);if(!named.equals(bytes))fail('APP_REPLAY_NAMED_RESPONSE_MISMATCH');
  if(name!=='maintenance-refusal'){
   const meta=json(await read(path.join(directory,name+'-http.json'))),wanted=name==='app-bootstrap'?{status:200,sha256:hash(bytes)}:{status:200,sha256:hash(bytes),generation:GENERATION,epoch:'1',protocol:'1'};
   if(canonical(meta)!==canonical(wanted))fail('APP_REPLAY_NAMED_METADATA_MISMATCH');
   if(name!=='app-bootstrap'&&(response.headers.get('x-config-generation')!==GENERATION||response.headers.get('x-config-epoch')!=='1'||response.headers.get('x-reliability-protocol')!=='1'))fail('APP_REPLAY_AUTHORITY_HEADER_MISMATCH');
  }
  if(name==='app-bootstrap'){
   let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('APP_REPLAY_BUILD_UTF8_INVALID');}const matches=[...text.matchAll(/window\.APP_BUILD_INFO=([^;]+);/g)];if(matches.length!==1)fail('APP_REPLAY_BUILD_MARKER_INVALID');const build=json(Buffer.from(matches[0][1]));if(build.buildId!==expected.buildId||build.sourceSha256!==expected.sourceSha256)fail('APP_REPLAY_BUILD_MISMATCH');
  }else values[name]=json(bytes);
 }
 const exported=values['accounts-export'];if(exported.format!=='cfauto.accounts'||exported.version!==2||!Array.isArray(exported.accounts)||exported.accounts.length!==1||exported.accounts[0].accountId!==source.accountId||typeof exported.accounts[0].apiToken!=='string'||!exported.accounts[0].apiToken.startsWith('v2:'))fail('APP_REPLAY_EXPORT_INVALID');
 try{const decoded=await credentialReader()(exported.accounts,json(Buffer.from(secrets.bindings.RELIABILITY_CREDENTIAL_KEYS)));if(decoded.length!==1||hash(decoded[0].apiToken)!==source.tokenSha256)fail('APP_REPLAY_CREDENTIAL_MISMATCH');}catch{fail('APP_REPLAY_CREDENTIAL_AUTHENTICATION_FAILED');}
 const masked=values['accounts-masked'],init=values['init-data'];if(!Array.isArray(masked)||masked.length!==1||masked[0].accountId!==source.accountId||masked[0].apiToken!=='***'||masked[0].globalKey!==''||init.accounts?.length!==1||init.accounts[0].apiToken!=='***'||init.accounts[0].globalKey!==''||init.accounts[0].accountId!==source.accountId)fail('APP_REPLAY_MASK_INVALID');
 if(init.runtime?.value?.lastCheck!==123||init.runtime.value.lastGc!==100||init.autoConfig?.enabled!==false||init.reliability?.maintenance!==true)fail('APP_REPLAY_RUNTIME_INVALID');
 if(canonical(values.vars)!==canonical([{key:'UNIT_MARKER',value:'isolated-source-fixture'}])||canonical(values['vars-after-refusal'])!==canonical(values.vars))fail('APP_REPLAY_VARIABLES_OR_REFUSAL_CHANGED');
 if(values.deploy.mode!=='fixed'||values.deploy.currentSha!=='abcdef1'||values.favorites.length!==1||values.favorites[0].sha!=='abcdef1'||values.upstream.branch!=='main'||values.upstream.path!=='_worker.js'||!Array.isArray(values.journal)||values.journal.length!==0)fail('APP_REPLAY_CONFIGURATION_INVALID');
 if(values['maintenance-refusal'].error!=='MAINTENANCE')fail('APP_REPLAY_MAINTENANCE_NOT_OBSERVED');
 return {schema:1,scope:'historical_isolated_application_observations_only',target,expected,generation:GENERATION,epoch:1,rawHttpObservations:ROWS.length,credentialAuthenticated:true,maskedViewsVerified:true,configurationAndRuntimeVerified:true,maintenanceRefusalAndUnchangedReadVerified:true,buildIdentityVerified:true,references,syntheticCredentialsOnly:true,networkCalls:0,currentProductionControlVerified:false,freezeProven:false,drainProven:false,publicationAllowed:false};
}
module.exports={ROWS,replayIsolatedApplicationEvidence};
