/* Read-only, dry Workers Observability queries. Never a legacy drain certificate. */
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {privateDirectory,assertPrivate,readPrivateJson}=require('./maintenance-client.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Error(code);};
function validate(raw){
 const p=JSON.parse(JSON.stringify(raw));
 if(!p||Object.keys(p).sort().join(',')!=='account,from,maxPages,pageSize,to,worker'||! /^[a-f0-9]{32}$/.test(p.account)||! /^[a-z0-9][a-z0-9-]{0,62}$/.test(p.worker))fail('INVALID_TARGET');
 if(!Number.isSafeInteger(p.from)||!Number.isSafeInteger(p.to)||p.from<0||p.from>=p.to||p.to-p.from>24*60*60*1000)fail('INVALID_TIMEFRAME');
 if(!Number.isSafeInteger(p.maxPages)||p.maxPages<1||p.maxPages>100||!Number.isSafeInteger(p.pageSize)||p.pageSize<1||p.pageSize>1000)fail('INVALID_LIMIT');
 return p;
}
async function collectLegacyTelemetry({target,token,out,transport=fetch,timeoutMs=30000}){
 target=validate(target);if(typeof token!=='string'||!token||/[\r\n]/.test(token))fail('INVALID_AUTH');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('INVALID_TIMEOUT');
 out=await privateDirectory(out);
 const save=async(name,value)=>{await assertPrivate(out);const file=path.join(out,name);await fs.writeFile(file,Buffer.isBuffer(value)?value:JSON.stringify(value,null,2),{flag:'wx',mode:0o600});if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(file,'file');await assertPrivate(file);};
 const queryId=randomUUID(),seen=new Set(),providerIds=new Map(),cursorIds=new Set(),pages=[],pageReportedCounts=[],pageQuerySampling=[];let cursor,finished=false,eventIdCollisionCount=0,missingRequestIdentityCount=0;
 await save('intent.json',{schema:1,target,queryId,dry:true,readOnly:true,startedAt:new Date().toISOString(),automaticRetry:false,drainProven:false});
 try{
 for(let page=0;page<target.maxPages;page++){
  const request={queryId,dry:true,view:'events',timeframe:{from:target.from,to:target.to},limit:target.pageSize,parameters:{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:target.worker}]},...(cursor?{offset:cursor,offsetDirection:'next'}:{})};
  const prefix='page-'+String(page).padStart(4,'0');await save(prefix+'-request.json',request);
  const controller=new AbortController();let timer,reader;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('REQUEST_DEADLINE'));},timeoutMs);});
  try{
   const pending=Promise.resolve().then(()=>transport('https://api.cloudflare.com/client/v4/accounts/'+target.account+'/workers/observability/telemetry/query',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(request),redirect:'manual',signal:controller.signal}));
   void pending.then(r=>{if(controller.signal.aborted)void r.body?.cancel().catch(()=>{});},()=>{});
   const response=await Promise.race([pending,deadline]);if(response.redirected||response.status>=300&&response.status<400)fail('REDIRECT_DENIED');
   reader=response.body?.getReader();const chunks=[];let size=0;if(!reader)fail('INVALID_RESPONSE');
   for(;;){const x=await Promise.race([reader.read(),deadline]);if(x.done)break;size+=x.value.length;if(size>20*1024*1024)fail('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(x.value));}
   const bytes=Buffer.concat(chunks);await save(prefix+'-response.bin',bytes);
   const evidence={page,httpStatus:response.status,bytes:size,sha256:hash(bytes)};pages.push(evidence);await save(prefix+'-transport.json',evidence);
   if(!response.ok)fail('READ_FAILED_HTTP_'+response.status);
   let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_RESPONSE');}
   const result=data?.result,run=result?.run,events=result?.events;
   if(data?.success!==true||run?.status!=='COMPLETED'||run.dry!==true||run.accountId!==target.account||run.timeframe?.from!==target.from||run.timeframe?.to!==target.to||!Array.isArray(events?.events))fail('INVALID_QUERY_RESULT');
   // Head sampling configuration does not disable query-level ABR sampling.
   // A sampled response can end with an empty page while omitting real events.
   const levels=[result.statistics?.abr_level,run.statistics?.abr_level].filter(n=>n!==undefined);
   if(levels.some(n=>!Number.isSafeInteger(n)||n<1)||(levels.length===2&&levels[0]!==levels[1]))fail('INVALID_QUERY_SAMPLING');
   const sampling={level:levels[0]??1,explicit:levels.length>0};pageQuerySampling.push(sampling);
   if(sampling.level>1)fail('QUERY_SAMPLED');
   // Observed API: adding offset changes the query's count (35 -> 0 on
   // the final empty page). This is not a stable total for a frozen snapshot.
   // Retain each count; never use equality with seen IDs as coverage proof.
   if(events.count!==undefined&&(!Number.isSafeInteger(events.count)||events.count<events.events.length))fail('INVALID_EVENT_COUNT');
   pageReportedCounts.push(events.count??null);
   if(events.events.length>target.pageSize)fail('INVALID_PAGE_SIZE');
   for(const event of events.events){
    const id=event?.$metadata?.id,requestId=event?.$metadata?.requestId??null;
    if(typeof id!=='string'||!id||id.length>1024)fail('DUPLICATE_OR_INVALID_EVENT');
    if(Object.hasOwn(event.$metadata,'requestId')&&(typeof event.$metadata.requestId!=='string'||!event.$metadata.requestId||event.$metadata.requestId.length>1024))fail('INVALID_EVENT_REQUEST_ID');
    if(event.$metadata.service!==target.worker||!Number.isSafeInteger(event.timestamp)||event.timestamp<target.from||event.timestamp>target.to)fail('EVENT_OUTSIDE_TARGET');
    // Real API returned the same metadata.id for two distinct invocations in
    // one page. Preserve both; do not silently deduplicate by provider ID.
    // A repeated (id, requestId), or a reused ID without request attribution,
    // is still ambiguous/replayed and fails closed with raw pages retained.
    const key=JSON.stringify([id,requestId]),requests=providerIds.get(id);
    if(seen.has(key)||(requests&&(requestId===null||requests.has(null))))fail('DUPLICATE_OR_INVALID_EVENT');
    if(requests){eventIdCollisionCount++;requests.add(requestId);}else providerIds.set(id,new Set([requestId]));
    if(requestId===null)missingRequestIdentityCount++;seen.add(key);
   }
   if(events.events.length===0){finished=true;break;}
   cursor=events.events.at(-1).$metadata.id;cursorIds.add(cursor);
  }finally{clearTimeout(timer);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
 }
 const summary={schema:3,target,queryId,pages,events:seen.size,eventIdentity:'metadata_id_and_request_id',eventIdCollisionCount,missingRequestIdentityCount,cursorCollisionObserved:[...cursorIds].some(id=>providerIds.get(id).size>1),cursorIdentityGuaranteed:false,reportedCount:null,pageReportedCounts,pageQuerySampling,querySamplingVerified:pageQuerySampling.every(s=>s.explicit&&s.level===1),countSemantics:'per_query_not_snapshot_total',globalCountVerified:false,paginationExhausted:finished,countMatched:false,stoppedByLimit:!finished,nextCursor:finished?null:cursor??null,telemetryCoverageVerified:false,drainProven:false,migrationReady:false,automaticRetry:false};
 await save('summary.json',summary);return summary;
 }catch(error){const safe=/^(READ_FAILED_HTTP_[0-9]{3}|INVALID_[A-Z_]+|REQUEST_DEADLINE|REDIRECT_DENIED|RESPONSE_TOO_LARGE|QUERY_SAMPLED|DUPLICATE_OR_INVALID_EVENT|EVENT_OUTSIDE_TARGET)$/.test(error.message)?error.message:'TELEMETRY_READ_FAILED';await save('failure.json',{error:safe,pages,pageReportedCounts,pageQuerySampling,events:seen.size,eventIdCollisionCount,missingRequestIdentityCount,drainProven:false,migrationReady:false,automaticRetry:false});throw Error(safe);}
}
module.exports={collectLegacyTelemetry,validate};
if(require.main===module)(async()=>{const args=process.argv.slice(2),opts={};if(args.length!==6)fail('USAGE_TARGET_AUTH_OUT');for(let i=0;i<args.length;i+=2){if(!['--target','--auth','--out'].includes(args[i])||opts[args[i]])fail('INVALID_OPTIONS');opts[args[i]]=args[i+1];}const target=await readPrivateJson(opts['--target']),auth=await readPrivateJson(opts['--auth']);if(!auth||Object.keys(auth).join(',')!=='token')fail('INVALID_AUTH');const s=await collectLegacyTelemetry({target,token:auth.token,out:opts['--out']});console.log(JSON.stringify({pages:s.pages.length,events:s.events,paginationExhausted:s.paginationExhausted,countMatched:s.countMatched,globalCountVerified:s.globalCountVerified,countSemantics:s.countSemantics,eventIdCollisionCount:s.eventIdCollisionCount,cursorCollisionObserved:s.cursorCollisionObserved,cursorIdentityGuaranteed:false,querySamplingVerified:s.querySamplingVerified,drainProven:false,migrationReady:false}));})().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'TELEMETRY_READ_FAILED');process.exitCode=1;});
