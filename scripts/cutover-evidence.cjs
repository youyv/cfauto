/* Replay immutable raw Observability evidence; this is never a platform drain
 * certificate. No provider cursor, deployment, KV write or operator force flag. */
const fs=require('node:fs/promises'),path=require('node:path');
const {assertPrivate,readPrivateJson,privateDirectory}=require('./maintenance-client.cjs');
const {windowTarget,decodePage,canonical,identity,hash,privateSave}=require('./cutover-window.cjs');
const fail=code=>{throw Error(code);};
function verifyReportedPage({target,request,responseBytes,transport}){
 const keys=request&&Object.keys(request).sort().join(',');
 if(keys!=='dry,limit,parameters,queryId,timeframe,view'||request.dry!==true||request.view!=='events'||typeof request.queryId!=='string'||!request.queryId||request.queryId.length>128||!Number.isSafeInteger(request.limit)||request.limit<2||request.limit>1000||canonical(request.parameters)!==canonical({filters:[{key:'$metadata.service',operation:'eq',type:'string',value:target.worker}]}))fail('INVALID_EVIDENCE_QUERY');
 const {from,to}=request.timeframe??{};
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<target.from||to>target.to||from>to||Object.keys(request.timeframe).sort().join(',')!=='from,to')fail('INVALID_EVIDENCE_TIMEFRAME');
 if(!Buffer.isBuffer(responseBytes)||transport?.httpStatus!==200||transport.sha256!==hash(responseBytes)||(transport.bytes!==undefined&&transport.bytes!==responseBytes.length))fail('EVIDENCE_BYTES_MISMATCH');
 const page=decodePage(responseBytes,target,from,to,request.limit),body=JSON.parse(responseBytes.toString('utf8'));
 if(body.result.run.query?.id!==request.queryId)fail('EVIDENCE_QUERY_ID_MISMATCH');
 return {...page,from,to,requestSha256:hash(canonical(request)),responseSha256:hash(responseBytes)};
}
async function readPrivateBytes(filename,max=20*1024*1024){
 await assertPrivate(path.dirname(filename));await assertPrivate(filename);
 const a=await fs.lstat(filename);if(!a.isFile()||a.size>max)fail('INVALID_EVIDENCE_FILE');
 const bytes=await fs.readFile(filename);await assertPrivate(filename);const b=await fs.lstat(filename);
 if(bytes.length>max||a.ino!==b.ino||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs)fail('EVIDENCE_FILE_CHANGED');
 return bytes;
}
function combineReportedPages(target,pages){
 target=windowTarget(target,7*24*60*60*1000);
 const accepted=pages.filter(p=>!p.refine).sort((a,b)=>a.from-b.from||a.to-b.to),events=[],seen=new Map(),gaps=[];let cursor=target.from,overlapDuplicates=0;
 for(const p of accepted){
  if(!Number.isSafeInteger(p.from)||!Number.isSafeInteger(p.to)||p.from<target.from||p.to>target.to||p.from>p.to||p.abr!==1||p.count!==p.events.length)fail('INVALID_REPORTED_PAGE');
  if(p.from>cursor)gaps.push({from:cursor,to:p.from-1});cursor=Math.max(cursor,p.to+1);
  for(const e of p.events){
   if(e.timestamp<p.from||e.timestamp>p.to||e.$metadata?.service!==target.worker)fail('EVENT_OUTSIDE_WINDOW');
   const key=identity(e),digest=hash(canonical(e)),previous=seen.get(key);
   if(previous){if(previous!==digest)fail('CONFLICTING_OVERLAP_EVENT');overlapDuplicates++;continue;}
   seen.set(key,digest);events.push(e);
  }
 }
 if(cursor<=target.to)gaps.push({from:cursor,to:target.to});
 events.sort((a,b)=>a.timestamp-b.timestamp||identity(a).localeCompare(identity(b)));
 return {summary:{schema:1,target,acceptedPages:accepted.length,rejectedForRefinement:pages.length-accepted.length,events:events.length,overlapDuplicates,gaps,nonpagedReportedCoverage:gaps.length===0,providerLogCompletenessProven:false,globalExecutionFenceProven:false,drainProven:false},events};
}
async function replayCutoverEvidence({target,sources,out}){
 target=windowTarget(target,7*24*60*60*1000);
 if(!Array.isArray(sources)||sources.length<1||sources.length>512||sources.some(s=>!s||Object.keys(s).sort().join(',')!=='directory,kind'||!path.isAbsolute(s.directory)||!['legacy_first','partition'].includes(s.kind)))fail('INVALID_EVIDENCE_SOURCES');
 sources=JSON.parse(JSON.stringify(sources));if(new Set(sources.map(s=>path.resolve(s.directory).toLowerCase())).size!==sources.length)fail('DUPLICATE_EVIDENCE_SOURCE');
 out=await privateDirectory(out);await privateSave(out,'intent.json',{schema:1,target,sources,readOnly:true,startedAt:new Date().toISOString()});
 const pages=[],references=[];
 try{
  for(const source of sources){
   const directory=path.resolve(source.directory);await assertPrivate(directory);const intent=await readPrivateJson(path.join(directory,'intent.json'));
   if(intent.target?.account!==target.account||intent.target?.worker!==target.worker||intent.readOnly!==true||intent.target.from<target.from||intent.target.to>target.to)fail('EVIDENCE_SOURCE_TARGET_MISMATCH');
   let prefixes;
   if(source.kind==='legacy_first')prefixes=['page-0000'];
   else{if(intent.method!=='nonpaged_time_partition')fail('INVALID_EVIDENCE_SOURCE');prefixes=(await fs.readdir(directory)).filter(n=>/^query-[0-9]{4}-request[.]json$/.test(n)).map(n=>n.slice(0,-13)).sort();if(!prefixes.length||prefixes.length>512)fail('INVALID_EVIDENCE_SOURCE');}
   for(const prefix of prefixes){
    const request=await readPrivateJson(path.join(directory,prefix+'-request.json'));
    if(request.timeframe?.from<intent.target.from||request.timeframe?.to>intent.target.to||(source.kind==='legacy_first'&&(request.timeframe?.from!==intent.target.from||request.timeframe?.to!==intent.target.to||request.limit!==intent.target.pageSize||request.queryId!==intent.queryId)))fail('EVIDENCE_SOURCE_QUERY_MISMATCH');
    const transport=await readPrivateJson(path.join(directory,prefix+'-transport.json'));
    const responseBytes=await readPrivateBytes(path.join(directory,prefix+'-response.bin'));
    const page=verifyReportedPage({target,request,transport,responseBytes});pages.push(page);
    references.push({directory,prefix,kind:source.kind,from:page.from,to:page.to,requestFileSha256:hash(await readPrivateBytes(path.join(directory,prefix+'-request.json'),16384)),transportFileSha256:hash(await readPrivateBytes(path.join(directory,prefix+'-transport.json'),16384)),responseSha256:page.responseSha256,reportedCount:page.count,returnedEvents:page.events.length,abr:page.abr,accepted:!page.refine});
   }
  }
  const result=combineReportedPages(target,pages);result.summary.references=references;await privateSave(out,'summary.json',result.summary);return result;
 }catch(e){const safe=/^(INVALID_|EVIDENCE_|EVENT_|CONFLICTING_|QUERY_|DUPLICATE_|PRIVATE_|UNSAFE_)[A-Z0-9_]+$/.test(e.message)?e.message:'EVIDENCE_REPLAY_FAILED';await privateSave(out,'failure.json',{error:safe,references,drainProven:false});throw Error(safe);}
}
module.exports={verifyReportedPage,combineReportedPages,replayCutoverEvidence,readPrivateBytes};
