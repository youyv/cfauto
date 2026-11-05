/* Resumeable initial-source transport/activation client. It cannot provision a
 * pin, deploy code, enable business/Cron, or retry an uncertain provider mutation.
 * The already deployed server anchor is the authority, never a local approval bit. */
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {privateDirectory,assertPrivate}=require('./maintenance-client.cjs');
const {readPrivateBytes}=require('./cutover-evidence.cjs');
const {localInitialCodecs}=require('./initial-source-codecs.cjs');
const {signedCommandRunner,save,readSaved,exists,noLinks,hash,exact,localCore}=require('./archive-bundle-client.cjs');
const fail=c=>{throw Error(c);};
async function loadInitialPackage(directory,target){
 directory=path.resolve(directory);await noLinks(directory);await assertPrivate(directory);const c=localInitialCodecs();
 const report=await readSaved(path.join(directory,'source-package.json')),pinBytes=await readPrivateBytes(path.join(directory,'pin.canonical.json'),8192),pin=c.initialCutoverPin(pinBytes.toString('utf8'),target);
 if(!pin||hash(pinBytes)!==report.pinSha256||report.pinId!==pin.id||report.sourceId!==pin.sourceId||report.importId!==pin.importId||report.generation!==pin.generation||c.canonical(report.target)!==c.canonical(target)||report.packet?.file!=='packet.json'||report.packet.id!==pin.packet.id||report.packet.digest!==pin.packet.digest||report.packet.bytes!==pin.packet.bytes||report.packet.frames!==pin.packet.frames)fail('INITIAL_PACKAGE_PIN_MISMATCH');
 const bytes=await readPrivateBytes(path.join(directory,'packet.json'),c.INITIAL_MAX_PACKET_BYTES);if(bytes.length!==pin.packet.bytes||hash(bytes)!==pin.packet.digest||!Array.isArray(report.frames)||report.frames.length!==pin.packet.frames)fail('INITIAL_PACKAGE_BYTES_MISMATCH');
 const frames=[];for(let i=0;i<report.frames.length;i++){const ref=report.frames[i];if(ref.ordinal!==i||ref.file!=='frame-'+String(i).padStart(4,'0')+'.json')fail('INITIAL_FRAME_REFERENCE_MISMATCH');const frame=await readSaved(path.join(directory,ref.file),8192);exact(frame,'ordinal,data');const expected=bytes.subarray(i*c.INITIAL_FRAME_BYTES,Math.min(bytes.length,(i+1)*c.INITIAL_FRAME_BYTES));if(frame.ordinal!==i||frame.data!==expected.toString('base64')||ref.sha256!==hash(frame.data)||ref.bytes!==expected.length)fail('INITIAL_FRAME_BYTES_MISMATCH');frames.push(frame);}
 return {pin,frames,pinSha256:hash(pinBytes),packetSha256:hash(bytes),directory};
}
function anchorIdentity(live,pin){return live&&live.installation===pin.installation&&live.sourceAnchorConfigured===true&&live.activationPerformed===false&&live.scope==='initial_source_identity'&&localCore().canonical(live.target)===localCore().canonical(pin.target)&&localCore().canonical(live.anchor)===localCore().canonical({id:pin.id,sourceId:pin.sourceId,importId:pin.importId,generation:pin.generation,expiresAt:pin.evidence.expiresAt});}
async function initialCutoverClient({profile,activationProfile,source,out,resume=false,limit=100,transport=fetch,beforeActivate}){
 profile=JSON.parse(JSON.stringify(profile));exact(profile,'endpoint,target,operator,secret');if(!Number.isSafeInteger(limit)||limit<2||limit>500)fail('INVALID_INITIAL_STEP_LIMIT');
 const url=new URL(profile.endpoint);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/api/reliability/maintenance'||url.search||url.hash||url.href!==profile.endpoint)fail('INVALID_INITIAL_ENDPOINT');
 const p=await loadInitialPackage(source,profile.target),pin=p.pin,c=localCore(),expected={generation:null,epoch:pin.epoch,maintenance:1};
 // Production uses separate migration and activation operators; never expand the
 // migration operator permission set just to accommodate a one-profile client.
 const split=activationProfile!==undefined;
 if(split){activationProfile=JSON.parse(JSON.stringify(activationProfile));exact(activationProfile,'endpoint,target,operator,secret');if(activationProfile.endpoint!==profile.endpoint||c.canonical(activationProfile.target)!==c.canonical(profile.target)||activationProfile.operator===profile.operator||activationProfile.secret===profile.secret)fail('INITIAL_ACTIVATION_PROFILE_MISMATCH');}
 else activationProfile=profile;
 await c.signMaintenance({version:1,target:activationProfile.target,operator:activationProfile.operator,at:Date.now(),nonce:randomUUID(),command:{id:'activation_profile_check',action:'status',expected:null,args:{}}},activationProfile.secret);
 await c.signMaintenance({version:1,target:profile.target,operator:profile.operator,at:Date.now(),nonce:randomUUID(),command:{id:'initial_profile_check',action:'status',expected:null,args:{}}},profile.secret);
 out=path.resolve(out);await noLinks(out);const relative=path.relative(p.directory,out);if(!relative||!relative.startsWith('..')&&!path.isAbsolute(relative))fail('SEPARATE_INITIAL_OUTPUT_REQUIRED');if(resume)await assertPrivate(out);else await privateDirectory(out);
 const identity={schema:1,kind:'initial_cutover_client',pinSha256:p.pinSha256,packetSha256:p.packetSha256,target:profile.target,endpoint:profile.endpoint,operator:profile.operator,...(split?{activationOperator:activationProfile.operator}:{}),installation:pin.installation,expected},identityFile=path.join(out,'identity.json');
 if(resume){if(c.canonical(await readSaved(identityFile))!==c.canonical(identity))fail('INITIAL_CLIENT_IDENTITY_CONFLICT');}else await save(identityFile,identity);
 const lockFile=path.join(out,'initial-client-lock.sqlite');if(!await exists(lockFile))await save(lockFile,'');await assertPrivate(lockFile);const lock=new DatabaseSync(lockFile);let held=false;const counter={calls:0},runId='run_'+randomUUID(),base={id:pin.id,pinSha256:p.pinSha256,operator:profile.operator};
 const runner=request=>signedCommandRunner({profile:{maintenance:profile},request,out,limit,transport,counter});const command=runner(base),fresh=runner({...base,runId});
 const activationBase={...base,operator:activationProfile.operator},activate=signedCommandRunner({profile:{maintenance:activationProfile},request:activationBase,out,limit,transport,counter});
 const activationInner={action:'initial_activate',args:{},expected},activationId='bc_'+hash(c.canonical([activationBase,null,activationInner])).slice(0,48);
 try{lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');held=true;
  const live=await fresh('initial_identity',{});if(!anchorIdentity(live,pin))fail('DEPLOYED_INITIAL_ANCHOR_REQUIRED');
  const originalCompleted=live.generation===pin.generation&&live.maintenance===1&&live.epoch===pin.epoch+1;
  if(originalCompleted&&!resume)fail('INITIAL_ALREADY_ACTIVATED_USE_ORIGINAL_RUN');
  if(!originalCompleted&&(live.generation!==null||live.epoch!==pin.epoch||live.maintenance!==1))fail('INITIAL_EMPTY_MAINTENANCE_REQUIRED');
  if(!originalCompleted){
   const begin=await command('initial_source_begin',{id:pin.sourceId},null,expected);if(begin.id!==pin.sourceId||!['receiving','complete'].includes(begin.state)||begin.frames!==pin.packet.frames)fail('INITIAL_SOURCE_BEGIN_MISMATCH');
   for(const frame of p.frames){const ack=await command('initial_source_frame',{id:pin.sourceId,...frame},null,expected);if(ack.id!==pin.sourceId||ack.ordinal!==frame.ordinal||ack.received!==true)fail('INITIAL_SOURCE_FRAME_MISMATCH');}
   const committed=await command('initial_source_commit',{id:pin.sourceId},null,expected);if(committed.id!==pin.sourceId||committed.state!=='complete'||committed.received!==pin.packet.frames)fail('INITIAL_SOURCE_COMMIT_MISMATCH');
   let imported=await command('initial_import_begin',{},null,expected),i=0,previous=null;
   for(;;){if(imported.id!==pin.importId||imported.target!==pin.generation||imported.source!==pin.sourceId||imported.stale!==false||!['preparing','staging','verified'].includes(imported.state))fail('INITIAL_IMPORT_STATE_MISMATCH');if(imported.state==='verified')break;
    const progress=c.canonical([imported.state,imported.count,imported.staged]);if(progress===previous||i>=1000)fail('INITIAL_IMPORT_NOT_ADVANCING');previous=progress;
    imported=await runner({...base,resumeOrdinal:i++})('initial_import_resume',{limit:100},null,expected);
   }
  }
  // Trusted publisher checkpoint after complete import verification, before the
  // first activation. It does not change/replace the deployment-controlled pin.
  if(!originalCompleted&&beforeActivate!==undefined){if(typeof beforeActivate!=='function')fail('INITIAL_CHECKPOINT_INVALID');await beforeActivate({pin,activationId});}
  const ack=await activate('initial_activate',{},null,expected);if(ack.id!==activationId||ack.importId!==pin.importId||ack.proofId!==pin.id||ack.generation!==pin.generation||ack.epoch!==pin.epoch+1||ack.maintenance!==true||ack.scope!=='initial_authority')fail('INITIAL_ACTIVATION_ACK_MISMATCH');
  const durable=await fresh('initial_activation_inspect',{id:activationId});if(c.canonical(durable)!==c.canonical(ack))fail('INITIAL_ACTIVATION_ORIGINAL_ACK_MISMATCH');
  const final=await fresh('status',{});if(final.generation!==pin.generation||final.epoch!==pin.epoch+1||final.maintenance!==1)fail('INITIAL_FINAL_MAINTENANCE_MISMATCH');
  const report={schema:1,pinId:pin.id,sourceId:pin.sourceId,importId:pin.importId,generation:pin.generation,epoch:pin.epoch+1,activationCommandId:activationId,originalActivationAck:ack,packetSha256:p.packetSha256,maintenance:true,businessEnabled:false,cronChanged:false,managementApiMutationPerformed:false,authorityActivationRecorded:true,pinProvisionedByClient:false};
  const complete=path.join(out,'complete.json');if(await exists(complete)){if(c.canonical(await readSaved(complete))!==c.canonical(report))fail('INITIAL_ORIGINAL_RESULT_CONFLICT');}else await save(complete,report);await save(path.join(out,runId+'.json'),{state:'complete',calls:counter.calls,at:new Date().toISOString()});return report;
 }catch(e){const error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'INITIAL_CLIENT_FAILED';await save(path.join(out,runId+'-failure.json'),{error,calls:counter.calls,resumeWithSameOutputAndPackage:true,noProviderMutationRetry:true});throw Error(error);}finally{if(held)lock.exec('ROLLBACK');lock.close();}
}
module.exports={loadInitialPackage,initialCutoverClient,anchorIdentity};
if(require.main===module)(async()=>{const args=process.argv.slice(2),o={};for(let i=0;i<args.length;i++){if(args[i]==='--resume'){o.resume=true;continue;}if(!['--profile','--activation-profile','--source','--out','--limit'].includes(args[i])||Object.hasOwn(o,args[i])||i+1===args.length)fail('INVALID_INITIAL_CLIENT_OPTIONS');o[args[i]]=args[++i];}if(!o['--profile']||!o['--source']||!o['--out'])fail('USAGE_PROFILE_SOURCE_OUT');const profile=await readSaved(o['--profile'],16384),activationProfile=o['--activation-profile']?await readSaved(o['--activation-profile'],16384):undefined;console.log(JSON.stringify(await initialCutoverClient({profile,activationProfile,source:o['--source'],out:o['--out'],resume:o.resume===true,limit:o['--limit']?Number(o['--limit']):100})));})().catch(e=>{console.error(/^[A-Z0-9_]+$/.test(e.message)?e.message:'INITIAL_CLIENT_FAILED');process.exitCode=1;});
