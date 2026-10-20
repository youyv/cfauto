/* Read-only current-window observations. No deployment, KV write, approval flag,
 * provider-terminal fabrication or mutation retry. Nonpaged time partitions avoid
 * depending on the provider's reused event IDs as pagination cursors. */
const fs=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {privateDirectory}=require('./maintenance-client.cjs');
const {bounded}=require('./execute-remote-acceptance.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex'),fail=c=>{throw Error(c);};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function windowTarget(raw,maxSpan=24*60*60*1000){const p=JSON.parse(canonical(raw));if(!p||Object.keys(p).sort().join(',')!=='account,from,to,worker'||! /^[a-f0-9]{32}$/.test(p.account)||! /^[a-z0-9][a-z0-9-]{0,62}$/.test(p.worker)||!Number.isSafeInteger(p.from)||!Number.isSafeInteger(p.to)||p.from<0||p.to-p.from<1000||p.to-p.from>maxSpan)fail('INVALID_WINDOW_TARGET');return p;}
async function privateSave(out,name,value){const f=path.join(out,name);await fs.writeFile(f,Buffer.isBuffer(value)?value:JSON.stringify(value,null,2),{flag:'wx',mode:0o600});if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(f,'file');}
function decodePage(bytes,target,from,to,limit){let b;try{b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_QUERY_JSON');}const r=b?.result,run=r?.run,list=r?.events?.events;
 if(b.success!==true||run?.status!=='COMPLETED'||run.dry!==true||run.accountId!==target.account||run.timeframe?.from!==from||run.timeframe?.to!==to||!Array.isArray(list)||list.length>limit)fail('INVALID_QUERY_RESULT');
 const levels=[r.statistics?.abr_level,run.statistics?.abr_level].filter(x=>x!==undefined);if(!levels.length)fail('QUERY_SAMPLING_UNPROVEN');if(levels.some(x=>!Number.isSafeInteger(x)||x<1)||new Set(levels).size!==1)fail('INVALID_QUERY_SAMPLING');const count=r.events.count;if(!Number.isSafeInteger(count)||count<list.length)fail('INVALID_QUERY_COUNT');
 const seen=new Set();for(const e of list){const m=e?.$metadata;if(!m||m.service!==target.worker||typeof m.id!=='string'||!m.id||m.id.length>1024||!Number.isSafeInteger(e.timestamp)||e.timestamp<from||e.timestamp>to)fail('EVENT_OUTSIDE_WINDOW');if(m.requestId!==undefined&&(typeof m.requestId!=='string'||!m.requestId||m.requestId.length>1024))fail('INVALID_REQUEST_ID');const id=canonical([m.id,m.requestId??null]);if(seen.has(id))fail('DUPLICATE_QUERY_EVENT');seen.add(id);}
 return {events:list,count,abr:levels[0],refine:levels[0]!==1||count!==list.length||list.length===limit};
}
async function collectCutoverWindow({target,token,out,transport=fetch,timeoutMs=30000,maxQueries=256,pageSize=1000}){
 target=windowTarget(target);if(typeof token!=='string'||!token||/[\r\n]/.test(token))fail('INVALID_AUTH');if(!Number.isSafeInteger(maxQueries)||maxQueries<1||maxQueries>512||!Number.isSafeInteger(pageSize)||pageSize<2||pageSize>1000)fail('INVALID_QUERY_LIMIT');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail('INVALID_TIMEOUT');
 out=await privateDirectory(out);await privateSave(out,'intent.json',{schema:1,target,readOnly:true,method:'nonpaged_time_partition',maxQueries,pageSize,automaticMutationRetry:false,startedAt:new Date().toISOString()});
 const queue=[{from:target.from,to:target.to,parent:null}],accepted=[],queries=[],events=[],seen=new Set();
 try{while(queue.length){if(queries.length>=maxQueries)fail('QUERY_BUDGET_EXHAUSTED');const part=queue.shift(),ordinal=queries.length,id=String(ordinal).padStart(4,'0'),body={queryId:randomUUID(),dry:true,view:'events',timeframe:{from:part.from,to:part.to},limit:pageSize,parameters:{filters:[{key:'$metadata.service',operation:'eq',type:'string',value:target.worker}]}};
  await privateSave(out,'query-'+id+'-request.json',body);const startedAt=Date.now();let response;try{response=await bounded(transport,'https://api.cloudflare.com/client/v4/accounts/'+target.account+'/workers/observability/telemetry/query',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)},timeoutMs);}catch(e){fail(['REQUEST_DEADLINE','REDIRECT_DENIED','RESPONSE_TOO_LARGE'].includes(e.message)?e.message:'QUERY_TRANSPORT_FAILED');}
  await privateSave(out,'query-'+id+'-response.bin',response.bytes);const record={ordinal,...part,startedAt,finishedAt:Date.now(),httpStatus:response.status,sha256:hash(response.bytes),file:'query-'+id+'-response.bin'};queries.push(record);await privateSave(out,'query-'+id+'-transport.json',record);if(response.status!==200)fail('QUERY_HTTP_REJECTED');const page=decodePage(response.bytes,target,part.from,part.to,pageSize);
  if(page.refine){if(part.to-part.from<2)fail('QUERY_WINDOW_TOO_DENSE');const middle=Math.floor((part.from+part.to)/2);queue.unshift({from:part.from,to:middle,parent:ordinal},{from:middle+1,to:part.to,parent:ordinal});continue;}
  for(const e of page.events){const identity=canonical([e.$metadata.id,e.$metadata.requestId??null]);if(seen.has(identity))fail('DUPLICATE_WINDOW_EVENT');seen.add(identity);events.push(e);}
  accepted.push({...record,events:page.events.length,reportedCount:page.count,abr:page.abr});
 }
 accepted.sort((a,b)=>a.from-b.from);if(!accepted.length||accepted[0].from!==target.from||accepted.at(-1).to!==target.to||accepted.some((x,i)=>i>0&&x.from!==accepted[i-1].to+1))fail('WINDOW_COVERAGE_GAP');
 const result={schema:1,target,queries,accepted,events:events.length,nonpagedReportedCoverage:true,explicitUnsampledQueries:true,providerLogCompletenessProven:false,globalExecutionFenceProven:false,drainProven:false,automaticMutationRetry:false};await privateSave(out,'summary.json',result);return {summary:result,events};
 }catch(e){const safe=['REQUEST_DEADLINE','REDIRECT_DENIED','RESPONSE_TOO_LARGE','QUERY_SAMPLING_UNPROVEN','INVALID_QUERY_JSON','INVALID_QUERY_RESULT','INVALID_QUERY_SAMPLING','INVALID_QUERY_COUNT','EVENT_OUTSIDE_WINDOW','INVALID_REQUEST_ID','DUPLICATE_QUERY_EVENT','QUERY_BUDGET_EXHAUSTED','QUERY_TRANSPORT_FAILED','QUERY_HTTP_REJECTED','QUERY_WINDOW_TOO_DENSE','DUPLICATE_WINDOW_EVENT','WINDOW_COVERAGE_GAP'].includes(e.message)?e.message:'CUTOVER_WINDOW_FAILED';await privateSave(out,'failure.json',{error:safe,queries,accepted,drainProven:false});throw Error(safe);}
}
// This registry implements the user's exact, historical risk decision. It is NOT
// an extensible force/accept list and supplies no invented outcome or end time.
const historicalExceptions=Object.freeze([
 {requestId:'9de2db14317f29c934db27284c849e5d',traceId:'9ae5424a0c3475f554c1ca85e71ac88e',taskId:'req_d6b5646c0ec94bdca4b88cd5',timestamp:1791056447662},
 {requestId:'8f35373f7a0af430f9dd3943553ca0e7',traceId:'67fd9634b56bffcda4da01f4c67fe6c8',taskId:'req_7ae470ea53c9476c80ffec7f',timestamp:1791095147659},
].map(Object.freeze));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const identity=e=>canonical([e.$metadata.id,e.$metadata.requestId??null]);
function historicalException(target,version,records){
 if(target.account!=='00000000000000000000000000000000'||target.worker!=='manager'||version!=='11111111-1111-4111-8111-111111111111'||records.length!==1)return null;
 const e=records[0],m=e.$metadata,w=e.$workers,s=e.source;
 if(m.type!=='cf-worker'||m.message!=='cron started'||m.level!=='info'||w.eventType!=='scheduled'||w.event?.cron!=='*/5 * * * *'||w.truncated!==false||s?.msg!=='cron started'||s.source!=='cron'||s.ts!==new Date(e.timestamp).toISOString())return null;
 return historicalExceptions.find(x=>x.requestId===m.requestId&&x.traceId===m.traceId&&x.taskId===s.taskId&&x.timestamp===e.timestamp)??null;
}
/** This may cover the entire retained old-version lifetime. Absence of observed
 * pending calls is not proof of complete logs, finished external I/O or a fence.
 * quietFrom is an explicit observation boundary, never an inferred grace period. */
function analyzeCutoverWindow({target,events,legacyVersion,freezeVersion=null,freezeAt=null,quietFrom=null,knownUnknowns=[]}){
 target=windowTarget(target,7*24*60*60*1000);const {from,to}=target;
 if(!Array.isArray(events)||!uuid(legacyVersion)||!Array.isArray(knownUnknowns)||knownUnknowns.some(x=>typeof x!=='string'||!x||x.length>128)||new Set(knownUnknowns).size!==knownUnknowns.length)fail('INVALID_WINDOW_ANALYSIS');
 const frozen=freezeVersion!==null;
 if(frozen?(!uuid(freezeVersion)||freezeVersion===legacyVersion||!Number.isSafeInteger(freezeAt)||freezeAt<from||freezeAt>to||!Number.isSafeInteger(quietFrom)||quietFrom<freezeAt||quietFrom>to):(freezeAt!==null||quietFrom!==null))fail('INVALID_WINDOW_ANALYSIS');
 const requests=new Map(),seen=new Set(),issues=knownUnknowns.map(operationId=>({code:'KNOWN_UNKNOWN_WRITE',operationId})),acceptedHistoricalExceptions=[];
 let currentEvents=0,quietActivity=false;
 for(const e of events){
  const m=e?.$metadata,w=e?.$workers;
  if(!Number.isSafeInteger(e?.timestamp)||e.timestamp<from||e.timestamp>to||m?.service!==target.worker||(m.account!==undefined&&m.account!==target.account))fail('EVENT_OUTSIDE_WINDOW');
  if(typeof m?.id!=='string'||!m.id||typeof m.requestId!=='string'||!m.requestId||!uuid(w?.scriptVersion?.id)){issues.push({code:'MISSING_INVOCATION_IDENTITY',eventId:typeof m?.id==='string'?m.id:null});continue;}
  const key=identity(e);if(seen.has(key))fail('DUPLICATE_WINDOW_EVENT');seen.add(key);
  const version=w.scriptVersion.id;
  if(w.truncated!==false)issues.push({code:'TRUNCATED_OR_UNPROVEN_LOG',requestId:m.requestId});
  if(version!==legacyVersion&&version!==freezeVersion)issues.push({code:'UNEXPECTED_SCRIPT_VERSION',requestId:m.requestId,version});
  if(!['scheduled','fetch'].includes(w.eventType)||!['cf-worker','cf-worker-event'].includes(m.type))issues.push({code:'UNEXPECTED_EVENT_TYPE',requestId:m.requestId});
  if(version===freezeVersion)currentEvents++;
  let r=requests.get(m.requestId);
  if(!r){r={requestId:m.requestId,version,eventType:w.eventType,traceId:m.traceId,records:[],terminals:[],errors:0,entries:[],taskIds:new Set()};requests.set(m.requestId,r);}
  if(r.version!==version||r.eventType!==w.eventType||r.traceId!==m.traceId)issues.push({code:'CONFLICTING_INVOCATION_IDENTITY',requestId:m.requestId});
  r.records.push(e);
  if(m.type==='cf-worker-event')r.terminals.push({timestamp:e.timestamp,outcome:w.outcome??null,wallTimeMs:w.wallTimeMs??null,cpuTimeMs:w.cpuTimeMs??null});
  if(['error','fatal'].includes(String(m.level).toLowerCase()))r.errors++;
  if(m.type==='cf-worker'&&['cron started','http entry'].includes(m.message)){
   if(e.source?.msg!==m.message||!/^req_[a-f0-9]{24}$/.test(e.source?.taskId??''))issues.push({code:'INVALID_ENTRY_TRACE',requestId:m.requestId});
   r.entries.push(e.timestamp);
  }
  if(e.source?.taskId!==undefined)r.taskIds.add(e.source.taskId);
 }
 const invocations=[];
 for(const r of requests.values()){
  if(r.taskIds.size>1)issues.push({code:'CONFLICTING_INVOCATION_IDENTITY',requestId:r.requestId});
  if(r.version!==legacyVersion){if(r.errors)issues.push({code:'FREEZE_ERROR_OBSERVED',requestId:r.requestId});continue;}
  const exception=historicalException(target,r.version,r.records);
  const good=r.terminals.length===1&&r.terminals[0].outcome==='ok'&&Number.isFinite(r.terminals[0].wallTimeMs)&&r.terminals[0].wallTimeMs>=0&&Number.isFinite(r.terminals[0].cpuTimeMs)&&r.terminals[0].cpuTimeMs>=0;
  if(exception)acceptedHistoricalExceptions.push({...exception,decision:'user_accepted_historical_missing_terminal',terminalObserved:false});
  else if(!good)issues.push({code:r.terminals.length===0?'OBSERVED_INVOCATION_UNRESOLVED':'LEGACY_TERMINAL_NOT_OK',requestId:r.requestId});
  if(r.errors)issues.push({code:'LEGACY_ERROR_OBSERVED',requestId:r.requestId});
  if(frozen&&r.records.some(e=>e.timestamp>=quietFrom)){quietActivity=true;issues.push({code:'LEGACY_ACTIVITY_IN_QUIET_WINDOW',requestId:r.requestId});}
  invocations.push({requestId:r.requestId,eventTypes:[r.eventType],events:r.records.length,terminals:r.terminals,errors:r.errors,entryCount:r.entries.length,startedAfterFreeze:frozen&&r.entries.some(at=>at>freezeAt),historicalException:exception!==null});
 }
 return {schema:2,scope:'observed_supplied_window_only',target,freezeAt,quietFrom,legacyVersion,freezeVersion,legacyInvocations:invocations,currentVersionEvents:currentEvents,acceptedHistoricalExceptions,issues,noObservedLegacyPendingOrErrors:issues.length===0,quietWindowObserved:frozen&&!quietActivity,providerLogCompletenessProven:false,globalExecutionFenceProven:false,drainProven:false};
}
module.exports={collectCutoverWindow,analyzeCutoverWindow,windowTarget,decodePage,canonical,identity,hash,privateSave};
