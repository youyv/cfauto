/* Full raw backup verification and two-pass business comparison. This does NOT
 * certify frozen writers, provider consistency, credentials, or approve a cutover. */
const fs=require('node:fs/promises'),path=require('node:path'),{isIP}=require('node:net');
const {hash,canonical,privateSave}=require('./cutover-window.cjs');
const {assertPrivate,privateDirectory}=require('./maintenance-client.cjs');
const {localInitialCodecs}=require('./initial-source-codecs.cjs');
const {active}=require('./backup-worker-readonly.cjs');
const fail=c=>{throw Error(c);},same=(a,b)=>canonical(a)===canonical(b);
async function restrictedRead(base,name,max=5*1024*1024){
 if(!/^(?:manifest[.]json|manifest[.]sha256|intent[.]json|(?:before|after)-(?:deployments|version)[.]json|(?:before|after)-keys-[0-9]{4}[.]json|value-[0-9]{6}[.]bin)$/.test(name))fail('INVALID_BACKUP_FILE');
 const file=path.join(base,name);await assertPrivate(base);const before=await fs.lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.size>max||path.dirname(await fs.realpath(file))!==await fs.realpath(base))fail('UNSAFE_BACKUP_FILE');
 // Old backupKv writes inherit a private owner's DACL. Validate effective
 // principal/owner permissions without altering any original backup ACL or byte.
 if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(file,'check_inherited');else await assertPrivate(file);
 const raw=await fs.readFile(file),after=await fs.lstat(file);await assertPrivate(base);
 if(raw.length>max||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('BACKUP_FILE_CHANGED');
 if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(file,'check_inherited');else await assertPrivate(file);
 return raw;
}
function target(value){if(!value||Object.keys(value).sort().join(',')!=='account,deployment,namespace,version,worker'||! /^[a-f0-9]{32}$/.test(value.account)||! /^[a-f0-9]{32}$/.test(value.namespace)||! /^[a-z0-9][a-z0-9-]{0,62}$/.test(value.worker)||!['deployment','version'].every(k=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value[k])))fail('INVALID_BACKUP_TARGET');return JSON.parse(canonical(value));}
function nonBusinessKind(entry){const c=localInitialCodecs();if(c.legacyBusinessDomain(entry.name)!==null)return null;
 if(!Number.isSafeInteger(entry.expiration)||entry.expiration<1)return 'unclassified';
 if(/^SESSION_[a-f0-9]{64}$/.test(entry.name))return 'session';
 if(entry.name.startsWith('RATE_LIMIT_')&&(isIP(entry.name.slice(11))!==0||entry.name==='RATE_LIMIT_unknown'))return 'login_rate_limit';
 if(Object.keys(c.TEMPLATES).some(t=>entry.name===c.KV_KEYS.ghInfoCache(t)))return 'github_discovery_cache';
 return 'unclassified';
}
async function loadCompleteBackup({directory,expected,manifestSha256}){
 expected=target(expected);if(!/^[a-f0-9]{64}$/.test(manifestSha256))fail('INVALID_MANIFEST_DIGEST');directory=path.resolve(directory);await assertPrivate(directory);const c=localInitialCodecs(),references=[];
 async function read(name,max){const bytes=await restrictedRead(directory,name,max);references.push({file:name,bytes:bytes.length,sha256:hash(bytes)});return bytes;}
 async function json(name,max=4*1024*1024){return c.parseStrictBackupJson(await read(name,max));}
 const raw=await read('manifest.json',4*1024*1024);if(hash(raw)!==manifestSha256||(await read('manifest.sha256',128)).toString('utf8')!==manifestSha256+'\n')fail('BACKUP_MANIFEST_DIGEST_MISMATCH');
 const m=c.parseStrictBackupJson(raw),intent=await json('intent.json');
 if(intent.schema!==1||intent.readOnly!==true||intent.migrationReady!==false||intent.consistency!=='live-best-effort-not-cutover'||intent.startedAt!==m.startedAt||['account','worker','namespace'].some(k=>intent[k]!==expected[k]))fail('BACKUP_INTENT_MISMATCH');
 const names=await fs.readdir(directory);if(names.includes('failure.json'))fail('FAILED_BACKUP_NOT_ACCEPTABLE');
 async function inventory(label){const files=names.filter(n=>new RegExp('^'+label+'-keys-[0-9]{4}[.]json$').test(n)).sort();if(!files.length||files.length>1000)fail('MISSING_BACKUP_INVENTORY');const keys=[],seen=new Set(),cursors=new Set();
  for(let i=0;i<files.length;i++){if(files[i]!==label+'-keys-'+String(i).padStart(4,'0')+'.json')fail('BACKUP_INVENTORY_GAP');const b=await json(files[i]),cursor=b.result_info?.cursor;
   if(b.success!==true||!Array.isArray(b.result)||b.result.length>1000||b.result_info?.count!==b.result.length||typeof cursor!=='string'||cursor.length>4096)fail('INVALID_BACKUP_INVENTORY');
   if((i===files.length-1)!==(cursor==='')||(cursor&&(cursors.has(cursor)||!b.result.length)))fail('INCOMPLETE_BACKUP_INVENTORY');if(cursor)cursors.add(cursor);
   for(const k of b.result){if(!k||typeof k.name!=='string'||!k.name||Buffer.byteLength(k.name)>512||['.','..'].includes(k.name)||Object.keys(k).some(x=>!['name','expiration','metadata'].includes(x))||seen.has(k.name))fail('INVALID_BACKUP_KEY');seen.add(k.name);keys.push(k);}if(keys.length>100000)fail('TOO_MANY_BACKUP_KEYS');
  }return keys.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 }
 const before=await inventory('before'),after=await inventory('after');if(!same(before,after)||!Array.isArray(m.entries)||!same(before,m.entries.map(({file,bytes,sha256,...key})=>key)))fail('BACKUP_INVENTORY_MISMATCH');
 for(const label of ['before','after']){const deployments=await json(label+'-deployments.json'),version=await json(label+'-version.json');if(deployments.success!==true||version.success!==true||!same(active(deployments.result),{version:expected.version,deployment:expected.deployment})||version.result?.id!==expected.version||!Array.isArray(version.result.resources?.bindings))fail('BACKUP_CONTROL_PLANE_MISMATCH');const kv=version.result.resources.bindings.filter(b=>b.name==='CONFIG_KV');if(kv.length!==1||kv[0].type!=='kv_namespace'||kv[0].namespace_id!==expected.namespace)fail('BACKUP_KV_BINDING_MISMATCH');}
 const valueFiles=names.filter(n=>/^value-[0-9]{6}[.]bin$/.test(n)).sort();if(!same(valueFiles,m.entries.map(e=>e.file)))fail('BACKUP_VALUE_FILE_SET_MISMATCH');
 const files=new Map(),source=await c.legacyGenerationSource(raw,manifestSha256,expected,async(name,size)=>{if(size>5*1024*1024)fail('INITIAL_SOURCE_VALUE_TOO_LARGE');const b=await read(name,5*1024*1024);if(b.length!==size)fail('BACKUP_VALUE_SIZE_MISMATCH');files.set(name,b);return b;});
 const types=m.entries.map(e=>({keyDigest:hash(e.name),domain:c.legacyBusinessDomain(e.name),ignoredKind:nonBusinessKind(e)}));
 return {directory,manifest:m,manifestBytes:raw,manifestSha256,files,source,types,references};
}
async function compareCompleteBackups({first,second,expected}){
 expected=target(expected);if(path.resolve(first.directory).toLowerCase()===path.resolve(second.directory).toLowerCase())fail('INDEPENDENT_BACKUP_PASSES_REQUIRED');const a=await loadCompleteBackup({...first,expected}),b=await loadCompleteBackup({...second,expected});
 if(await fs.realpath(a.directory)===await fs.realpath(b.directory)||a.manifestSha256===b.manifestSha256||Date.parse(a.manifest.capturedAt)>Date.parse(b.manifest.startedAt))fail('BACKUP_PASSES_NOT_SEQUENTIAL');
 const maps=[a,b].map(x=>new Map(x.manifest.entries.map(e=>[e.name,e]))),differences=[];const keys=[...new Set([...maps[0].keys(),...maps[1].keys()])].sort();
 for(const key of keys){const x=maps[0].get(key),y=maps[1].get(key),domain=localInitialCodecs().legacyBusinessDomain(key);const content=e=>e?(({file,...rest})=>rest)(e):null;
  if(!same(content(x),content(y)))differences.push({keyDigest:hash(key),domain,kind:!x?'added':!y?'removed':'changed',nonBusinessKinds:[x?nonBusinessKind(x):null,y?nonBusinessKind(y):null]});
 }
 const unclassified=a.types.concat(b.types).filter(x=>x.ignoredKind==='unclassified'),businessDifferences=differences.filter(x=>x.domain!==null);
 const report={schema:1,target:expected,first:{manifestSha256:a.manifestSha256,startedAt:a.manifest.startedAt,capturedAt:a.manifest.capturedAt,files:a.files.size,totalBytes:a.manifest.totalBytes},second:{manifestSha256:b.manifestSha256,startedAt:b.manifest.startedAt,capturedAt:b.manifest.capturedAt,files:b.files.size,totalBytes:b.manifest.totalBytes},businessStable:businessDifferences.length===0&&unclassified.length===0,recognizedBusinessStable:businessDifferences.length===0,allRawValuesStable:differences.length===0,unclassifiedKeyDigests:[...new Set(unclassified.map(x=>x.keyDigest))],differences,completeRawBytesVerified:true,twoCompleteInventoryEvidenceSets:true,independentRemoteReadsProven:false,credentialsValidated:false,providerConsistencyProven:false,freezeProven:false,drainProven:false,migrationReady:false,cutoverApproved:false};
 return {first:a,second:b,report};
}
async function verifyCutoverBackupPair({first,second,expected,out}){await privateDirectory(out);try{const r=await compareCompleteBackups({first,second,expected});await privateSave(out,'backup-pair-report.json',r.report);await privateSave(out,'source-references.json',{first:r.first.references,second:r.second.references});return r.report;}catch(e){const error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'BACKUP_PAIR_VERIFICATION_FAILED';await privateSave(out,'failure.json',{error,cutoverApproved:false});throw Error(error);}}
module.exports={loadCompleteBackup,compareCompleteBackups,verifyCutoverBackupPair,nonBusinessKind,restrictedRead};
