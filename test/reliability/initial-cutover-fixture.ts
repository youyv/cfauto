import {sqliteFixture} from './sqlite-fixture';
import {ConfigStore} from '../../src/reliability/config-store';
import {SealedStore} from '../../src/reliability/sealed-store';
import {TaskDispatch} from '../../src/reliability/task-dispatch';
import {CredentialAuthority} from '../../src/reliability/credential-authority';
import {AuthorityDrain} from '../../src/reliability/authority-drain';
import {InitialCutoverSource} from '../../src/reliability/initial-cutover-source';
import {MaintenanceInitialCutover} from '../../src/reliability/maintenance-initial-cutover';
import {MaintenanceService} from '../../src/reliability/maintenance-service';
import {initialCutoverPin,INITIAL_FRAME_BYTES,type InitialCutoverPin} from '../../src/reliability/initial-cutover-pin';
import {canonical,sha256,type Json} from '../../src/reliability/protocol';
import type {MaintenanceCommand,MaintenanceMessage} from '../../src/reliability/maintenance-protocol';
export const initialTarget={account:'f'.repeat(32),worker:'manager',namespace:'a'.repeat(32)};
export const initialCredentials={currentId:'credential_new',keys:{credential_new:'5'.repeat(64)}};
export const initialSnapshots={currentId:'snapshot_new',keys:{snapshot_new:'7'.repeat(64)}};
export const initialSecret='2'.repeat(64);
/** Entire fixture is LOCAL FAKE DATA. None of these evidence hashes is a real
 * freeze/drain approval, and no fixture/config is suitable for production. */
export async function initialCutoverFixture(opened:ReturnType<typeof sqliteFixture>[],change?:(payload:any)=>void,overrides?:Record<string,string|Uint8Array>){
 const f=sqliteFixture(),offline=sqliteFixture();opened.push(f,offline);let clock=10000;const now=()=>clock,config=new ConfigStore(f.db),sealed=new SealedStore(f.db,initialSnapshots),dispatch=new TaskDispatch(f.db,new TextEncoder().encode(initialSecret));new CredentialAuthority(f.db,config,dispatch,initialCredentials,now);const drain=new AuthorityDrain(f.db,config,async()=>null as any,now);
 const identity=f.db.rows<{identity:string}>('SELECT identity FROM authority_identity WHERE id=1')[0].identity;
 const values:Record<string,string|Uint8Array>={ACCOUNTS_UNIFIED_STORAGE:JSON.stringify([{accountId:'e'.repeat(32),alias:'test-only',email:'',globalKey:'',apiToken:'local-only-initial-token',authMode:'token',workers_cmliu:['one']}]),AUTO_UPDATE_CFG_GLOBAL:JSON.stringify({enabled:false,interval:'30',lastCheck:123,lastGc:100}),VARS_cmliu:JSON.stringify([{key:'TEST',value:'private-only-test-variable'}]),SESSION_local:new Uint8Array([0,255,1])};
 Object.assign(values,overrides??{});
 const files=new Map<string,Uint8Array>();const entries=await Promise.all(Object.keys(values).sort().map(async(name,i)=>{const file='value-'+String(i).padStart(6,'0')+'.bin',bytes=typeof values[name]==='string'?new TextEncoder().encode(values[name]):values[name] as Uint8Array;files.set(file,bytes);return {name,file,bytes:bytes.length,sha256:await sha256(typeof values[name]==='string'?values[name] as string:'')};}));
 // Non-UTF8 auth evidence also gets its actual byte hash.
 for(const entry of entries)entry.sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',files.get(entry.file)! as Uint8Array<ArrayBuffer>)),b=>b.toString(16).padStart(2,'0')).join('');
 const manifest={schema:1,readOnly:true,...initialTarget,deployment:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',version:'22222222-2222-2222-2222-222222222222',startedAt:new Date(3000).toISOString(),capturedAt:new Date(4000).toISOString(),consistency:'live-best-effort-not-cutover',migrationReady:false,inventoryMatched:true,verifiedLocalBytes:true,totalBytes:entries.reduce((n,x)=>n+x.bytes,0),entries};const manifestText=JSON.stringify(manifest,null,2);
 const evidence={legacyDeployment:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',legacyVersion:'11111111-1111-1111-1111-111111111111',freezeDeployment:manifest.deployment,freezeVersion:manifest.version,freezeArtifact:'a'.repeat(64),freezeEvidence:'b'.repeat(64),drainEvidence:'c'.repeat(64),backupManifest:await sha256(manifestText),verificationReport:'d'.repeat(64),frozenAt:1000,drainedAt:2000,backupStartedAt:3000,backupCompletedAt:4000,verifiedAt:5000,expiresAt:60000};
 const payload:any={schema:1,kind:'cfauto.initial-cutover-source',pinId:'pin1',target:{...initialTarget},evidence:{...evidence},manifest:Buffer.from(manifestText).toString('base64'),entries:[...files].map(([file,b])=>({file,data:Buffer.from(b).toString('base64')})),customSources:[]};change?.(payload);
 const context={id:'source1_sealed',kind:'config_backup' as const,account:'initial_cutover',generation:'g1'};const sourceSealed=new SealedStore(offline.db,initialSnapshots);await sourceSealed.put(context,payload as Json,5000);const packet=await sourceSealed.exportPacket(context),packetText=canonical(packet),bytes=Buffer.from(packetText),frames:string[]=[];for(let i=0;i<bytes.length;i+=INITIAL_FRAME_BYTES)frames.push(bytes.subarray(i,i+INITIAL_FRAME_BYTES).toString('base64'));
 const rawPin:InitialCutoverPin={schema:1,id:'pin1',target:{...initialTarget},installation:identity,sourceId:'source1',importId:'import1',generation:'g1',epoch:0,packet:{id:context.id,digest:await sha256(packetText),bytes:bytes.length,frames:frames.length},evidence:{...evidence},unprefixed:'plaintext',legacyKeySource:'explicit_slot'};const pin=initialCutoverPin(canonical(rawPin),initialTarget)!;
 const make=(anchor:InitialCutoverPin|undefined=pin)=>{const source=new InitialCutoverSource(f.db,config,sealed,initialTarget,anchor,now),maintenance=new MaintenanceInitialCutover(f.db,config,sealed,initialTarget,anchor,initialCredentials,new TextEncoder().encode(initialSecret),now),service=new MaintenanceService(f.db,config,drain,now,undefined,undefined,undefined,initialSecret,undefined,undefined,(m,commit)=>maintenance.execute(m,commit));return {source,maintenance,service};};const parts=make();
 const message=(command:MaintenanceCommand):MaintenanceMessage=>({version:1,target:initialTarget,operator:'ops',at:now(),nonce:'local_nonce',command});
 const execute=(id:string,action:MaintenanceCommand['action'],args:Json={},expected:{generation:string|null;epoch:number;maintenance:number}|null={generation:null,epoch:0,maintenance:1})=>parts.service.execute(message({id,action,args,expected}));
 const upload=async()=>{await execute('source_begin','initial_source_begin',{id:'source1'});for(const [ordinal,data]of frames.entries())await execute('source_frame_'+ordinal,'initial_source_frame',{id:'source1',ordinal,data});return execute('source_commit','initial_source_commit',{id:'source1'});};
 const prepare=async()=>{await upload();await execute('import_begin','initial_import_begin');return execute('import_resume','initial_import_resume',{limit:100});};
 return {...f,...parts,config,sealed,drain,identity,pin,rawPin,packet,packetText,frames,payload,files,manifest,manifestText,make,message,execute,upload,prepare,now,setNow:(n:number)=>{clock=n;}};
}
