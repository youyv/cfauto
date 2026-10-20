import {ConfigStore,type SqlDatabase} from './config-store';
import {SealedStore,type SealedContext,type SealedPacket} from './sealed-store';
import {canonical,identifier,revision,sha256,ReliabilityError,type Json} from './protocol';
import {shape} from './business-command';
import {legacyGenerationSource,type LegacyBackupTarget} from './legacy-generation-source';
import type {LoadedGenerationSource} from './generation-import';
import type {GenerationSource} from './generation-data';
import type {InitialCutoverProofStore,InitialCutoverBinding} from './initial-generation-activation';
import {INITIAL_FRAME_BYTES,initialCutoverEvidence,initialCutoverPin,type InitialCutoverPin,type InitialCutoverTarget} from './initial-cutover-pin';
interface SourceRow extends Record<string,unknown>{id:string;pin:string;state:string;packet_digest:string;frames:number}
interface ProofRow extends Record<string,unknown>{id:string;binding:string;digest:string;state:string;pin:string}
interface BackupFile {file:string;data:string}
interface SourcePayload {schema:1;kind:'cfauto.initial-cutover-source';pinId:string;target:InitialCutoverTarget;evidence:InitialCutoverPin['evidence'];manifest:string;entries:BackupFile[];customSources:Array<{template:string;digest:string;source:GenerationSource}>}
const invalid=():never=>{throw new ReliabilityError('INVALID',400);},unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);},conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
function bytes64(text:unknown,max:number):Uint8Array{if(typeof text!=='string'||text.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))invalid();let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(text as string),c=>c.charCodeAt(0));}catch{return invalid();}if(bytes.length>max)invalid();let out='';for(let i=0;i<bytes.length;i+=4096)out+=String.fromCharCode(...bytes.subarray(i,i+4096));if(btoa(out)!==text)invalid();return bytes;}
/** Ciphertext-only, resumable receipt of an exact deployment-pinned source packet.
 * This class authenticates a separately verified release artifact; it NEVER declares
 * that logs, a timeout, a signature or a hash by itself proves legacy drain. No
 * public maintenance command can set/replace the anchor or waive source blockers.
 * Until the actual stop-write verifier has produced and installed a real anchor,
 * all import/activation paths remain NOT_READY. No test proof callback is installed. */
export class InitialCutoverSource implements InitialCutoverProofStore {
 private readonly anchor:InitialCutoverPin|undefined;
 constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly sealed:SealedStore,private readonly target:InitialCutoverTarget,pin:InitialCutoverPin|undefined,private readonly now:()=>number=Date.now){
  this.anchor=initialCutoverPin(pin===undefined?undefined:canonical(pin),target);
  db.rows('CREATE TABLE IF NOT EXISTS initial_cutover_sources (id TEXT PRIMARY KEY,pin TEXT NOT NULL,state TEXT NOT NULL,packet_digest TEXT NOT NULL,frames INTEGER NOT NULL)');
  db.rows('CREATE TABLE IF NOT EXISTS initial_cutover_frames (source TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(source,ordinal))');
  db.rows('CREATE TABLE IF NOT EXISTS initial_cutover_proofs (id TEXT PRIMARY KEY,binding TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,pin TEXT NOT NULL)');
 }
 private pin():InitialCutoverPin{if(!this.anchor||canonical(this.anchor.target)!==canonical(this.target))return unavailable();return this.anchor;}
 private identity():string{const identity=this.db.rows<{identity:string}>('SELECT identity FROM authority_identity WHERE id=1')[0]?.identity;if(!identity)unavailable();return identity;}
 identityView():Json{return {target:JSON.parse(canonical(this.target)),installation:this.identity(),...this.config.status(),sourceAnchorConfigured:!!this.anchor,anchor:this.anchor?{id:this.anchor.id,sourceId:this.anchor.sourceId,importId:this.anchor.importId,generation:this.anchor.generation,expiresAt:this.anchor.evidence.expiresAt}:null,scope:'initial_source_identity',activationPerformed:false};}
 private barrier():InitialCutoverPin{const p=this.pin(),m=this.config.status(),now=this.now();revision(now);if(this.identity()!==p.installation||m.generation!==null||m.maintenance!==1||m.epoch!==p.epoch)conflict();if(now<p.evidence.verifiedAt||now>p.evidence.expiresAt)unavailable();return p;}
 private row(id:string):SourceRow{identifier(id);const p=this.pin();if(id!==p.sourceId)conflict();const row=this.db.rows<SourceRow>('SELECT * FROM initial_cutover_sources WHERE id=?',id)[0];if(!row)unavailable();if(row.pin!==canonical(p)||row.packet_digest!==p.packet.digest||row.frames!==p.packet.frames||!['receiving','complete'].includes(row.state))conflict();return row;}
 inspect(id:string):Json{const r=this.row(id);return {id:r.id,state:r.state,frames:r.frames,received:this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM initial_cutover_frames WHERE source=?',id)[0].n,scope:'pinned_initial_source',activationReady:false};}
 begin(id:string):Json{const p=this.barrier();if(id!==p.sourceId)conflict();return this.db.transaction(()=>{this.barrier();const r=this.db.rows<SourceRow>('SELECT * FROM initial_cutover_sources WHERE id=?',id)[0];if(!r)this.db.rows('INSERT INTO initial_cutover_sources VALUES (?,?,?,?,?)',id,canonical(p),'receiving',p.packet.digest,p.packet.frames);return this.inspect(id);});}
 async frame(id:string,ordinal:number,data:string):Promise<Json>{const p=this.barrier(),r=this.row(id);revision(ordinal);if(ordinal>=p.packet.frames)invalid();const bytes=bytes64(data,INITIAL_FRAME_BYTES),expected=Math.min(INITIAL_FRAME_BYTES,p.packet.bytes-ordinal*INITIAL_FRAME_BYTES);if(bytes.length!==expected)invalid();const digest=await sha256(data);return this.db.transaction(()=>{this.barrier();this.row(id);const old=this.db.rows<{data:string;digest:string}>('SELECT data,digest FROM initial_cutover_frames WHERE source=? AND ordinal=?',id,ordinal)[0];if(old){if(old.data!==data||old.digest!==digest)conflict();}else{if(r.state==='complete')conflict();this.db.rows('INSERT INTO initial_cutover_frames VALUES (?,?,?,?)',id,ordinal,data,digest);}return {id,ordinal,digest,received:true};});}
 private context():SealedContext{const p=this.pin();return {id:p.packet.id,kind:'config_backup',account:'initial_cutover',generation:p.generation};}
 async commit(id:string):Promise<Json>{const p=this.barrier(),row=this.row(id),frames=this.db.rows<{ordinal:number;data:string;digest:string}>('SELECT ordinal,data,digest FROM initial_cutover_frames WHERE source=? ORDER BY ordinal',id);if(frames.length!==p.packet.frames)unavailable();const bytes=new Uint8Array(p.packet.bytes);let offset=0;for(const [i,f]of frames.entries()){if(f.ordinal!==i||await sha256(f.data)!==f.digest)conflict();const value=bytes64(f.data,INITIAL_FRAME_BYTES);if(value.length!==Math.min(INITIAL_FRAME_BYTES,p.packet.bytes-offset))conflict();bytes.set(value,offset);offset+=value.length;}
  let text:string,packet:SealedPacket;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);packet=JSON.parse(text);}catch{return invalid();}if(offset!==p.packet.bytes||canonical(packet)!==text||await sha256(text)!==p.packet.digest)conflict();this.barrier();await this.sealed.importPacket(this.context(),packet);this.barrier();
  // Semantic source validation happens BEFORE the receiving row can become complete.
  await this.payload();return this.db.transaction(()=>{this.barrier();const current=this.row(id);if(current.state!==row.state&&current.state!=='complete')conflict();this.db.rows("UPDATE initial_cutover_sources SET state='complete' WHERE id=?",id);return this.inspect(id);});
 }
 private async payload():Promise<LoadedGenerationSource>{
  const p=this.barrier(),raw=await this.sealed.get(this.context());this.barrier();shape(raw,'schema,kind,pinId,target,evidence,manifest,entries,customSources');const value=raw as unknown as SourcePayload;
  if(value.schema!==1||value.kind!=='cfauto.initial-cutover-source'||value.pinId!==p.id||canonical(value.target)!==canonical(p.target)||canonical(initialCutoverEvidence(value.evidence))!==canonical(p.evidence)||!Array.isArray(value.entries)||value.entries.length>100000||!Array.isArray(value.customSources)||value.customSources.length>100)invalid();
  const manifest=bytes64(value.manifest,4*1024*1024),files=new Map<string,Uint8Array>();let total=manifest.length;for(const f of value.entries){shape(f,'file,data');if(typeof f.file!=='string'||!/^value-[0-9]{6}\.bin$/.test(f.file)||files.has(f.file))invalid();const bytes=bytes64(f.data,5*1024*1024);total+=bytes.length;if(total>5*1024*1024)invalid();files.set(f.file,bytes);}
  let info:any;try{info=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(manifest));}catch{return invalid();}
  if(Date.parse(info.startedAt)!==p.evidence.backupStartedAt||Date.parse(info.capturedAt)!==p.evidence.backupCompletedAt||!Array.isArray(info.entries)||info.entries.length!==files.size)conflict();
  const custom=new Map<string,GenerationSource>();for(const s of value.customSources){shape(s,'template,digest,source');identifier(s.template);if(typeof s.digest!=='string'||!/^[a-f0-9]{64}$/.test(s.digest)||custom.has(s.template+':'+s.digest))invalid();custom.set(s.template+':'+s.digest,s.source);}
  const expected:LegacyBackupTarget={...p.target,deployment:p.evidence.freezeDeployment,version:p.evidence.freezeVersion};const parsed=await legacyGenerationSource(manifest,p.evidence.backupManifest,expected,async(file,size)=>{const bytes=files.get(file);if(!bytes||bytes.length!==size)return invalid();return bytes;},async(template,digest)=>{const source=custom.get(template+':'+digest);if(!source)return unavailable();return source;});this.barrier();
  // The legacy adapter remains unproven for every ordinary live backup. This is a
  // DIFFERENT source identity: its complete original bytes and timing are pinned
  // by the separately installed stop-write release approval, not by an HTTP flag.
  if(canonical(parsed.blockers)!==canonical({legacyDrainUnproven:1})||parsed.identity!==p.evidence.backupManifest)conflict();
  return {identity:await this.sourceIdentity(),data:parsed.data,blockers:{},migrationReady:false,resolveCustom:parsed.resolveCustom};
 }
 private sourceIdentity():Promise<string>{const p=this.pin();return sha256(canonical(['cfauto.initial-cutover-source.v1',p]));}
 async load(id:string):Promise<LoadedGenerationSource>{this.barrier();if(this.row(id).state!=='complete')unavailable();return this.payload();}
 private binding(binding:InitialCutoverBinding,sourceIdentity:string):void{const p=this.barrier();if(canonical(Object.keys(binding).sort())!==canonical(['installation','importId','generation','epoch','sourceIdentity','recordsDigest'].sort())||binding.installation!==p.installation||binding.importId!==p.importId||binding.generation!==p.generation||binding.epoch!==p.epoch||binding.sourceIdentity!==sourceIdentity||!/^[a-f0-9]{64}$/.test(binding.recordsDigest))conflict();}
 async verify(id:string,binding:InitialCutoverBinding):Promise<{digest:string}>{const p=this.barrier();if(id!==p.id)conflict();binding=JSON.parse(canonical(binding));const source=await this.load(p.sourceId);this.binding(binding,source.identity);const digest=await sha256(canonical(['cfauto.initial-cutover-proof.v1',p,binding]));return this.db.transaction(()=>{this.binding(binding,source.identity);const row=this.db.rows<ProofRow>('SELECT * FROM initial_cutover_proofs WHERE id=?',id)[0];if(row){if(row.binding!==canonical(binding)||row.digest!==digest||row.pin!==canonical(p)||row.state!=='ready')conflict();}else this.db.rows('INSERT INTO initial_cutover_proofs VALUES (?,?,?,?,?)',id,canonical(binding),digest,'ready',canonical(p));return {digest};});}
 consumeInTransaction(id:string,binding:InitialCutoverBinding,digest:string):void{const p=this.barrier();if(id!==p.id)conflict();const row=this.db.rows<ProofRow>('SELECT * FROM initial_cutover_proofs WHERE id=?',id)[0];if(!row||row.binding!==canonical(binding)||row.digest!==digest||row.pin!==canonical(p)||row.state!=='ready'||this.row(p.sourceId).state!=='complete')conflict();this.db.rows("UPDATE initial_cutover_proofs SET state='consumed' WHERE id=?",id);}
}
