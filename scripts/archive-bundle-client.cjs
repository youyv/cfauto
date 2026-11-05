/* Offline receiver + independently signed, archive-only download orchestration.
 * No freeze, unseal, activation, deployment, deletion or provider mutation. */
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {DatabaseSync}=require('node:sqlite');
const {createHash,randomUUID}=require('node:crypto');
const {maintenanceClient,readPrivateJson,assertPrivate,privateDirectory}=require('./maintenance-client.cjs');
const fail=code=>{throw Error(code);};
const hash=x=>createHash('sha256').update(x).digest('hex');
let core;
function localCore(){if(!core){const root=path.resolve(__dirname,'..');const output=require('esbuild').buildSync({stdin:{contents:"export {ArchiveBundleCollection} from './src/reliability/archive-bundle-collection';export {AuthorityArchive} from './src/reliability/authority-archive';export {verifyArchiveBundle} from './src/reliability/archive-bundle';export {packetDescriptor} from './src/reliability/archive-packet-transport';export {SealedStore} from './src/reliability/sealed-store';export {canonical,identifier,revision} from './src/reliability/protocol';export {maintenanceCommand,signMaintenance} from './src/reliability/maintenance-protocol';",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});const mod=new Module(path.join(__dirname,'.archive-bundle-core.cjs'),module);mod.filename=path.join(__dirname,'.archive-bundle-core.cjs');mod.paths=module.paths;mod._compile(output.outputFiles[0].text,mod.filename);core=mod.exports;}return core;}
async function protectCreated(file){if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(file,'file');await assertPrivate(file);}
async function save(file,value){await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value),{flag:'wx',mode:0o600});await protectCreated(file);}
async function readSaved(file,max=16*1024*1024){return readPrivateJson(file,max);}
async function exists(file){try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function noLinks(file){let p=path.resolve(file);for(;;){try{if((await fs.lstat(p)).isSymbolicLink())fail('UNSAFE_LOCAL_PATH');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(p);if(parent===p)return;p=parent;}}
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.split(',').sort().join(','))fail('INVALID_INPUT');}
function signedCommandRunner({profile,request,out,limit,transport,counter}){const c=localCore();
 return async function command(action,args,owner=null,expected=null){const inner={action,args,expected},id='bc_'+hash(c.canonical([request,owner,inner])).slice(0,48),cmd=c.maintenanceCommand(owner===null?{id,...inner}:{id,action:'account_archive',expected,args:{account:owner,action,args}}),cache=path.join(out,id+'.json');
   if(await exists(cache)){const saved=await readSaved(cache,131072);if(c.canonical(saved.command)!==c.canonical(cmd)||hash(c.canonical(saved.value))!==saved.digest)fail('LOCAL_ACK_CORRUPT');return saved.value;}
   if(counter.calls>=limit)fail('COLLECTION_STEP_LIMIT');counter.calls++;
   const evidence=path.join(out,id+'_'+randomUUID());const summary=await maintenanceClient({profile:profile.maintenance,command:cmd,out:evidence,transport});if(!summary.acknowledged)fail('REMOTE_COMMAND_REJECTED');
   // Evidence directory is private; response.bin is inherited from that protected
   // directory. It is not executed and is bounded/digest-checked before caching.
   await assertPrivate(evidence);const responseFile=path.join(evidence,'response.bin');if((await fs.lstat(responseFile)).isSymbolicLink())fail('UNSAFE_LOCAL_PATH');const bytes=await fs.readFile(responseFile);if(bytes.length>65536||hash(bytes)!==summary.responseSha256)fail('LOCAL_ACK_CORRUPT');const response=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));exact(response,'value');await save(cache,{command:cmd,value:response.value,digest:hash(c.canonical(response.value))});return response.value;
  }
}
async function archiveBundleClient({profile,request,out,resume=false,limit=100,transport=fetch}){
 profile=JSON.parse(JSON.stringify(profile));request=JSON.parse(JSON.stringify(request));exact(profile,'maintenance,snapshots');exact(request,'id,drain,generation,epoch');const c=localCore();c.identifier(request.id);c.identifier(request.drain);c.identifier(request.generation);c.revision(request.epoch);if(!Number.isInteger(limit)||limit<1||limit>500)fail('INVALID_LIMIT');
 exact(profile.maintenance,'endpoint,target,operator,secret');exact(profile.snapshots,'currentId,keys');c.identifier(profile.snapshots.currentId);if(!profile.snapshots.keys||!Object.hasOwn(profile.snapshots.keys,profile.snapshots.currentId)||Object.values(profile.snapshots.keys).some(k=>typeof k!=='string'||Buffer.byteLength(k)<32))fail('INVALID_PROFILE');
 // Validate target/operator/key using the real signing protocol before local state.
 const endpoint=new URL(profile.maintenance.endpoint);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/api/reliability/maintenance'||endpoint.search||endpoint.hash||endpoint.href!==profile.maintenance.endpoint)fail('INVALID_ENDPOINT');
 await c.signMaintenance({version:1,target:profile.maintenance.target,operator:profile.maintenance.operator,at:Date.now(),nonce:randomUUID(),command:{id:'bundle_profile_check',action:'status',expected:null,args:{}}},profile.maintenance.secret);
 out=path.resolve(out);await noLinks(out);if(resume){await assertPrivate(out);}else await privateDirectory(out);
 const installation=hash(c.canonical(profile.maintenance.target)),identity={schema:1,request,target:profile.maintenance.target,endpoint:profile.maintenance.endpoint,operator:profile.maintenance.operator,snapshotKeyFingerprint:hash(c.canonical(profile.snapshots))};
 const identityFile=path.join(out,'identity.json');if(resume){if(c.canonical(await readSaved(identityFile))!==c.canonical(identity))fail('COLLECTION_IDENTITY_CONFLICT');}else await save(identityFile,identity);
 const openDb=async name=>{const file=path.join(out,name);if(!await exists(file))await save(file,'');await assertPrivate(file);return new DatabaseSync(file);};
 let lock,sql,lockHeld=false;const counter={calls:0};
 try{
  lock=await openDb('receiver-lock.sqlite');lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');lockHeld=true;
  sql=await openDb('receiver.sqlite');sql.exec('PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=FULL;');
  const db={rows:(q,...args)=>sql.prepare(q).all(...args),transaction:fn=>{sql.exec('BEGIN IMMEDIATE');try{const v=fn();sql.exec('COMMIT');return v;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const collection=new c.ArchiveBundleCollection(db,new c.SealedStore(db,profile.snapshots),installation);
  const command=signedCommandRunner({profile,request,out,limit,transport,counter});
  const status=await command('status',{});if(status.generation!==request.generation||status.epoch!==request.epoch||status.maintenance!==1)fail('MAINTAINED_AUTHORITY_REQUIRED');
  const drain=await command('drain_inspect',{id:request.drain});if(drain.id!==request.drain||drain.generation!==request.generation||drain.epoch!==request.epoch||drain.state!=='ready'||drain.accounts!==drain.probed||!drain.blockers||Object.values(drain.blockers).some(v=>v!==0))fail('READY_DRAIN_REQUIRED');
  const accounts=[];let after=null,digest=null;
  do{const page=await command('archive_accounts',{after,limit:50,digest});if(!page||!Array.isArray(page.items)||page.items.length>50||typeof page.digest!=='string'||! /^[a-f0-9]{64}$/.test(page.digest)||digest!==null&&digest!==page.digest||page.items.some((a,i)=>typeof a!=='string'||! /^[a-f0-9]{32}$/.test(a)||(i? a<=page.items[i-1]:after!==null&&a<=after)))fail('INVALID_ACCOUNT_INVENTORY');if(page.after!==null&&(page.items.length===0||page.after!==page.items.at(-1)))fail('INVALID_ACCOUNT_INVENTORY');accounts.push(...page.items);if(accounts.length>10000)fail('INVENTORY_TOO_LARGE');after=page.after;digest=page.digest;}while(after!==null);
  if(accounts.length!==drain.accounts||hash(c.canonical(accounts))!==digest)fail('INVENTORY_DIGEST_CONFLICT');
  const expected={generation:request.generation,epoch:request.epoch,maintenance:1};const refs=[];
  for(const owner of [null,...accounts]){const id='b_'+hash(c.canonical([request,owner])).slice(0,48);const created=await command('archive_create',{id},owner,expected);if(created.id!==id||created.state!=='ready'||created.generation!==request.generation||created.epoch!==request.epoch)fail('INVALID_ARCHIVE_ACK');const inventory=await command('archive_inventory',{id},owner);if(inventory.id!==id||inventory.generation!==request.generation||inventory.epoch!==request.epoch||!Number.isSafeInteger(inventory.pages)||inventory.pages<0||inventory.pages>512)fail('INVALID_ARCHIVE_INVENTORY');refs.push({owner,id,pages:inventory.pages});}
  async function packet(ref,part,receive){const transfer='t_'+hash(c.canonical([request,ref.owner,ref.id,part])).slice(0,48),info=await command('archive_export_begin',{id:transfer,archive:ref.id,part},ref.owner),d=info.descriptor;
   if(!d||d.id!==transfer||d.archive!==ref.id||d.part!==part||d.generation!==request.generation||d.epoch!==request.epoch||!Number.isSafeInteger(d.frames)||d.frames<1||d.frames>2731||!Number.isSafeInteger(d.bytes)||d.bytes<1||d.bytes>8388608||d.frames!==Math.ceil(d.bytes/3072))fail('INVALID_PACKET_DESCRIPTOR');
   if(receive)await collection.beginTransfer(request.id,ref.owner,d);const chunks=[];
   for(let ordinal=0;ordinal<d.frames;ordinal++){const f=await command('archive_export_frame',{id:transfer,ordinal},ref.owner);if(f.id!==transfer||f.ordinal!==ordinal||typeof f.data!=='string'||f.data.length>4096||hash(f.data)!==f.digest)fail('INVALID_FRAME');const bytes=Buffer.from(f.data,'base64');if(bytes.toString('base64')!==f.data||bytes.length!==Math.min(3072,d.bytes-ordinal*3072))fail('INVALID_FRAME');if(receive)await collection.putFrame(request.id,transfer,ordinal,f.data);else chunks.push(bytes);}
   if(receive){await collection.commitTransfer(request.id,transfer);return;}
   const bytes=Buffer.concat(chunks);if(bytes.length!==d.bytes||hash(bytes)!==d.digest)fail('INVALID_PACKET_DIGEST');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(c.canonical(value)!==bytes.toString('utf8'))fail('INVALID_PACKET_ENCODING');return value;
  }
  // Obtain immutable root pins first; full key/AAD authentication happens in the
  // receiver. Never trust downloaded plaintext to authorize operational changes.
  for(const ref of refs){const root=await packet(ref,null,false);if(!root?.object||typeof root.object.digest!=='string'||! /^[a-f0-9]{64}$/.test(root.object.digest))fail('INVALID_ROOT');ref.digest=root.object.digest;}
  const plan={...request,global:{id:refs[0].id,digest:refs[0].digest},accounts:refs.slice(1).map(r=>({account:r.owner,id:r.id,digest:r.digest}))};await collection.begin(plan);
  for(const ref of refs){await packet(ref,null,true);for(let part=0;part<ref.pages;part++)await packet(ref,part,true);}
  const result=await collection.complete(request.id),output=path.join(out,'bundle.json');if(await exists(output)){if(c.canonical(await readSaved(output))!==c.canonical(result))fail('BUNDLE_RESULT_CONFLICT');}else await save(output,result);
  return {id:request.id,state:'verified',accounts:accounts.length,digest:result.digest,networkCommands:counter.calls,migrationReady:false,liveDrainProven:false,legacyDrainProven:false};
 }catch(e){if(e.message==='COLLECTION_STEP_LIMIT')return {id:request.id,state:'incomplete',networkCommands:counter.calls,resumeRequired:true,migrationReady:false};throw e;}
 finally{try{sql?.close();}finally{if(lock){try{if(lockHeld)lock.exec('ROLLBACK');}finally{lock.close();}}}}
}
module.exports={archiveBundleClient,protectCreated,signedCommandRunner,localCore,save,readSaved,exists,noLinks,hash,exact};
if(require.main===module)(async()=>{const argv=process.argv.slice(2),options={};let resume=false;for(let i=0;i<argv.length;i++){if(argv[i]==='--resume'){if(resume)fail('INVALID_OPTIONS');resume=true;continue;}if(!['--profile','--request','--out','--limit'].includes(argv[i])||Object.hasOwn(options,argv[i])||i+1>=argv.length)fail('INVALID_OPTIONS');options[argv[i]]=argv[++i];}if(!options['--profile']||!options['--request']||!options['--out'])fail('USAGE_PROFILE_REQUEST_OUT');const result=await archiveBundleClient({profile:await readPrivateJson(options['--profile']),request:await readPrivateJson(options['--request']),out:options['--out'],resume,limit:options['--limit']===undefined?100:Number(options['--limit'])});console.log(JSON.stringify(result));if(result.state!=='verified')process.exitCode=2;})().catch(e=>{console.error('Archive bundle client: '+(/^[A-Z0-9_]+$/.test(e.message)?e.message:'COLLECTION_FAILED'));process.exitCode=1;});
