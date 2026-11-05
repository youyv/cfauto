/* Same-installation encrypted archive upload. This does NOT restore live SQL,
 * import/activate a generation, reopen ingress, deploy, or erase old evidence. */
const fs=require('node:fs/promises'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {randomUUID}=require('node:crypto');
const {readPrivateJson,assertPrivate,privateDirectory}=require('./maintenance-client.cjs');
const {signedCommandRunner,localCore,save,readSaved,exists,noLinks,hash,exact}=require('./archive-bundle-client.cjs');
const fail=code=>{throw Error(code);};
async function archiveBundleUpload({profile,request,source,out,resume=false,limit=100,transport=fetch}){
 profile=JSON.parse(JSON.stringify(profile));request=JSON.parse(JSON.stringify(request));exact(profile,'maintenance,snapshots');exact(profile.maintenance,'endpoint,target,operator,secret');exact(request,'id,generation,epoch');const c=localCore();c.identifier(request.id);c.identifier(request.generation);c.revision(request.epoch);if(!Number.isInteger(limit)||limit<1||limit>500)fail('INVALID_LIMIT');
 const endpoint=new URL(profile.maintenance.endpoint);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/api/reliability/maintenance'||endpoint.search||endpoint.hash||endpoint.href!==profile.maintenance.endpoint)fail('INVALID_ENDPOINT');
 await c.signMaintenance({version:1,target:profile.maintenance.target,operator:profile.maintenance.operator,at:Date.now(),nonce:randomUUID(),command:{id:'upload_profile_check',action:'status',expected:null,args:{}}},profile.maintenance.secret);
 source=path.resolve(source);out=path.resolve(out);await noLinks(source);await noLinks(out);const relative=path.relative(source,out);if(!relative||!relative.startsWith('..')&&!path.isAbsolute(relative))fail('SEPARATE_OUTPUT_REQUIRED');await assertPrivate(source);
 const origin=await readSaved(path.join(source,'identity.json')),stored=await readSaved(path.join(source,'bundle.json'));if(c.canonical(origin.target)!==c.canonical(profile.maintenance.target))fail('INSTALLATION_CONFLICT');
 const installation=hash(c.canonical(profile.maintenance.target)),counter={calls:0};let sourceLock,sourceDb,outputLock,sourceHeld=false,outputHeld=false;
 try{
  const sourceLockFile=path.join(source,'receiver-lock.sqlite'),sourceFile=path.join(source,'receiver.sqlite');await assertPrivate(sourceLockFile);await assertPrivate(sourceFile);sourceLock=new DatabaseSync(sourceLockFile);sourceLock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');sourceHeld=true;
  sourceDb=new DatabaseSync(sourceFile,{readOnly:true});const db={rows:(query,...args)=>sourceDb.prepare(query).all(...args),transaction:fn=>{sourceDb.exec('BEGIN');try{const value=fn();sourceDb.exec('COMMIT');return value;}catch(e){sourceDb.exec('ROLLBACK');throw e;}}},sealed=new c.SealedStore(db,profile.snapshots);
  const refs=[{owner:null,id:stored.manifest.global.id},...stored.manifest.accounts.map(a=>({owner:a.account,id:a.id}))].map(r=>({...r,archive:new c.AuthorityArchive(db,sealed,installation,r.owner===null?{role:'global'}:{role:'account',account:r.owner})}));
  const verified=await c.verifyArchiveBundle(refs[0],stored.manifest.drain.id,refs.slice(1));if(c.canonical(verified)!==c.canonical(stored)||verified.manifest.installation!==installation)fail('SOURCE_BUNDLE_CONFLICT');
  // No network call has happened before complete source authentication.
  if(resume)await assertPrivate(out);else await privateDirectory(out);
  const identity={schema:1,direction:'archive_upload',sourceDigest:verified.digest,request,target:profile.maintenance.target,endpoint:profile.maintenance.endpoint,operator:profile.maintenance.operator,snapshotKeyFingerprint:hash(c.canonical(profile.snapshots))},identityFile=path.join(out,'identity.json');
  if(resume){if(c.canonical(await readSaved(identityFile))!==c.canonical(identity))fail('UPLOAD_IDENTITY_CONFLICT');}else await save(identityFile,identity);
  const lockFile=path.join(out,'upload-lock.sqlite');if(!await exists(lockFile))await save(lockFile,'');await assertPrivate(lockFile);outputLock=new DatabaseSync(lockFile);outputLock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');outputHeld=true;
  const operation={...request,sourceDigest:verified.digest},command=signedCommandRunner({profile,request:operation,out,limit,transport,counter}),status=await command('status',{}),expected={generation:request.generation,epoch:request.epoch,maintenance:1};
  if(status.generation!==request.generation||status.epoch!==request.epoch||status.maintenance!==1)fail('MAINTAINED_AUTHORITY_REQUIRED');
  for(const ref of refs){const snapshot=await ref.archive.snapshot(ref.id);
   for(const part of [null,...snapshot.manifest.pages.map((_,i)=>i)]){const packet=part===null?await ref.archive.rootPacket(ref.id):await ref.archive.pagePacket(ref.id,part),text=c.canonical(packet),bytes=Buffer.from(text),id='u_'+hash(c.canonical([operation,ref.owner,ref.id,part])).slice(0,48),descriptor=c.packetDescriptor({id,archive:ref.id,part,generation:snapshot.manifest.generation,epoch:snapshot.manifest.epoch,digest:hash(bytes),bytes:bytes.length,frames:Math.ceil(bytes.length/3072)});
    const begun=await command('archive_import_begin',{descriptor},ref.owner,expected);if(begun.direction!=='import'||c.canonical(begun.descriptor)!==c.canonical(descriptor)||!['receiving','complete'].includes(begun.state))fail('INVALID_IMPORT_ACK');
    for(let ordinal=0;ordinal<descriptor.frames;ordinal++){const data=bytes.subarray(ordinal*3072,Math.min(bytes.length,(ordinal+1)*3072)).toString('base64'),frame=await command('archive_import_frame',{id,ordinal,data},ref.owner,expected);if(typeof frame?.duplicate!=='boolean')fail('INVALID_FRAME_ACK');}
    const committed=await command('archive_import_commit',{id},ref.owner,expected);if(committed.state!=='complete'||c.canonical(committed.descriptor)!==c.canonical(descriptor))fail('INVALID_COMMIT_ACK');
   }
   const finished=await command('archive_finish',{id:ref.id},ref.owner,expected);if(finished.id!==ref.id||finished.state!=='ready'||finished.generation!==snapshot.manifest.generation||finished.epoch!==snapshot.manifest.epoch||finished.migrationReady!==false)fail('INVALID_ARCHIVE_ACK');
  }
  const receipt={id:request.id,state:'archived',sourceDigest:verified.digest,archives:refs.length,globalArchive:refs[0].id,activationPerformed:false,migrationReady:false,currentStateGuaranteed:false},resultFile=path.join(out,'upload.json');if(await exists(resultFile)){if(c.canonical(await readSaved(resultFile))!==c.canonical(receipt))fail('UPLOAD_RESULT_CONFLICT');}else await save(resultFile,receipt);
  return {...receipt,networkCommands:counter.calls};
 }catch(e){if(e.message==='COLLECTION_STEP_LIMIT')return {id:request.id,state:'incomplete',networkCommands:counter.calls,resumeRequired:true,activationPerformed:false,migrationReady:false};throw e;}
 finally{try{sourceDb?.close();}finally{try{if(outputLock){try{if(outputHeld)outputLock.exec('ROLLBACK');}finally{outputLock.close();}}}finally{if(sourceLock){try{if(sourceHeld)sourceLock.exec('ROLLBACK');}finally{sourceLock.close();}}}}}
}
module.exports={archiveBundleUpload};
if(require.main===module)(async()=>{const args=process.argv.slice(2),options={};let resume=false;for(let i=0;i<args.length;i++){if(args[i]==='--resume'){if(resume)fail('INVALID_OPTIONS');resume=true;continue;}if(!['--profile','--request','--source','--out','--limit'].includes(args[i])||Object.hasOwn(options,args[i])||i+1>=args.length)fail('INVALID_OPTIONS');options[args[i]]=args[++i];}if(!['--profile','--request','--source','--out'].every(k=>options[k]))fail('USAGE_PROFILE_REQUEST_SOURCE_OUT');const result=await archiveBundleUpload({profile:await readPrivateJson(options['--profile']),request:await readPrivateJson(options['--request']),source:options['--source'],out:options['--out'],resume,limit:options['--limit']===undefined?100:Number(options['--limit'])});console.log(JSON.stringify(result));if(result.state!=='archived')process.exitCode=2;})().catch(e=>{console.error('Archive upload: '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'UPLOAD_FAILED'));process.exitCode=1;});
