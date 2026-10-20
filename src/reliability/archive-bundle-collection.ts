import type {SqlDatabase} from './config-store';
import {AuthorityArchive} from './authority-archive';
import {ArchivePacketTransport,packetDescriptor,type ArchivePacketDescriptor} from './archive-packet-transport';
import {verifyArchiveBundle} from './archive-bundle';
import {SealedStore} from './sealed-store';
import {accountId,shape} from './business-command';
import {canonical,identifier,revision,sha256,ReliabilityError} from './protocol';
export interface BundlePart {id:string;digest:string}
export interface BundleCollectionPlan {id:string;drain:string;generation:string;epoch:number;global:BundlePart;accounts:Array<BundlePart&{account:string}>}
interface Session extends Record<string,unknown>{id:string;plan:string;digest:string;state:string;result:string|null}
interface Transfer extends Record<string,unknown>{id:string;bundle:string;owner:string;part:number;descriptor:string}
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
function planValue(raw:unknown):BundleCollectionPlan {
 const p=JSON.parse(canonical(raw));shape(p,'id,drain,generation,epoch,global,accounts');identifier(p.id);identifier(p.drain);identifier(p.generation);revision(p.epoch);
 if(!Array.isArray(p.accounts)||p.accounts.length>10000)conflict();
 const part=(v:any,account=false)=>{shape(v,account?'account,id,digest':'id,digest');identifier(v.id);if(v.id.length>60||typeof v.digest!=='string'||!/^[a-f0-9]{64}$/.test(v.digest))conflict();if(account)accountId(v.account);};
 part(p.global);for(const a of p.accounts)part(a,true);p.accounts.sort((a:any,b:any)=>a.account<b.account?-1:1);
 if(new Set(p.accounts.map((a:any)=>a.account)).size!==p.accounts.length||new Set([p.global.id,...p.accounts.map((a:any)=>a.id)]).size!==p.accounts.length+1)conflict();return p as unknown as BundleCollectionPlan;
}
/** Receiver-only durable collection. This store must be isolated from live config
 * and execution tables. Original ciphertext is imported into archive stores, NEVER
 * applied as SQL or operational state. This is an internal/local persistence core;
 * it grants no maintenance permissions and performs no network calls. */
export class ArchiveBundleCollection {
 constructor(private readonly db:SqlDatabase,private readonly sealed:SealedStore,private readonly installation:string){
  identifier(installation);if(db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('config_meta','account_jobs','dispatch_outbox')").length)conflict();
  db.rows('CREATE TABLE IF NOT EXISTS archive_bundle_collections (id TEXT PRIMARY KEY,plan TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT)');
  db.rows('CREATE TABLE IF NOT EXISTS archive_bundle_collection_transfers (id TEXT PRIMARY KEY,bundle TEXT NOT NULL,owner TEXT NOT NULL,part INTEGER NOT NULL,descriptor TEXT NOT NULL,UNIQUE(bundle,owner,part))');
 }
 private row(id:string):Session {identifier(id);const row=this.db.rows<Session>('SELECT * FROM archive_bundle_collections WHERE id=?',id)[0];if(!row)unavailable();return row;}
 private async plan(id:string):Promise<BundleCollectionPlan>{const row=this.row(id),plan=planValue(JSON.parse(row.plan));if(plan.id!==id||await sha256(canonical({installation:this.installation,plan}))!==row.digest||!['collecting','verified'].includes(row.state))conflict();if((row.state==='verified')!==(row.result!==null))conflict();if(row.result!==null){const result=JSON.parse(row.result);if(!result||await sha256(canonical(result.manifest))!==result.digest||result.manifest.installation!==this.installation||result.manifest.generation!==plan.generation||result.manifest.epoch!==plan.epoch||result.manifest.drain.id!==plan.drain||result.manifest.global.id!==plan.global.id||result.manifest.global.digest!==plan.global.digest||canonical(result.manifest.accounts.map((a:any)=>({account:a.account,id:a.id,digest:a.digest})))!==canonical(plan.accounts))conflict();}return plan;}
 private stores(plan:BundleCollectionPlan,owner:string|null){if(owner!==null)accountId(owner);const part=owner===null?plan.global:plan.accounts.find(a=>a.account===owner);if(!part)return conflict();const archive=new AuthorityArchive(this.db,this.sealed,this.installation,owner===null?{role:'global'}:{role:'account',account:owner});return {part,archive,transport:new ArchivePacketTransport(this.db,archive)};}
 async begin(raw:unknown){const plan=planValue(raw),text=canonical(plan),digest=await sha256(canonical({installation:this.installation,plan}));this.db.transaction(()=>{const old=this.db.rows<Session>('SELECT * FROM archive_bundle_collections WHERE id=?',plan.id)[0];if(old){if(old.plan!==text||old.digest!==digest)conflict();}else this.db.rows("INSERT INTO archive_bundle_collections VALUES (?,?,?,'collecting',NULL)",plan.id,text,digest);});return this.inspect(plan.id);}
 async inspect(id:string){const plan=await this.plan(id),row=this.row(id);return {id,state:row.state,parts:plan.accounts.length+1,transfers:this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM archive_bundle_collection_transfers WHERE bundle=?',id)[0].n,planDigest:row.digest,bundleDigest:row.result?JSON.parse(row.result).digest:null,migrationReady:false as const,liveDrainProven:false as const};}
 async beginTransfer(id:string,owner:string|null,raw:unknown){const d=packetDescriptor(raw),plan=await this.plan(id),s=this.stores(plan,owner);if(d.archive!==s.part.id||d.generation!==plan.generation||d.epoch!==plan.epoch)conflict();const text=canonical(d),key=owner??'global';
  this.db.transaction(()=>{const old=this.db.rows<Transfer>('SELECT * FROM archive_bundle_collection_transfers WHERE id=?',d.id)[0];if(old){if(old.bundle!==id||old.owner!==key||old.part!==(d.part??-1)||old.descriptor!==text)conflict();}else{if(this.row(id).state!=='collecting'||this.db.rows('SELECT id FROM archive_packet_transfers WHERE id=?',d.id).length||this.db.rows('SELECT id FROM archive_bundle_collection_transfers WHERE bundle=? AND owner=? AND part=?',id,key,d.part??-1).length)conflict();this.db.rows('INSERT INTO archive_bundle_collection_transfers VALUES (?,?,?,?,?)',d.id,id,key,d.part??-1,text);}});
  // Reservation survives a crash before transport creation; replay uses the exact
  // original descriptor and ID, never silently creates a replacement transfer.
  return s.transport.beginImport(d);
 }
 private async transfer(bundle:string,id:string){identifier(id);const plan=await this.plan(bundle),row=this.db.rows<Transfer>('SELECT * FROM archive_bundle_collection_transfers WHERE id=?',id)[0];if(!row||row.bundle!==bundle)conflict();const d:ArchivePacketDescriptor=packetDescriptor(JSON.parse(row.descriptor)),s=this.stores(plan,row.owner==='global'?null:row.owner);if(d.id!==id||d.archive!==s.part.id||d.generation!==plan.generation||d.epoch!==plan.epoch||row.part!==(d.part??-1))conflict();const info=s.transport.info(id);if(canonical(info.descriptor)!==canonical(d)||info.direction!=='import')conflict();return {row,s};}
 async transferStatus(bundle:string,id:string){return (await this.transfer(bundle,id)).s.transport.info(id);}
 async putFrame(bundle:string,id:string,ordinal:number,data:string){return (await this.transfer(bundle,id)).s.transport.putFrame(id,ordinal,data);}
 async commitTransfer(bundle:string,id:string){return (await this.transfer(bundle,id)).s.transport.commitImport(id);}
 async complete(id:string){const plan=await this.plan(id),refs=[];
  for(const owner of [null,...plan.accounts.map(a=>a.account)]){const s=this.stores(plan,owner);await s.archive.finishReceive(s.part.id);const root=await s.archive.rootPacket(s.part.id);if(root.object.digest!==s.part.digest)conflict();refs.push({archive:s.archive,id:s.part.id});}
  const result=await verifyArchiveBundle(refs[0],plan.drain,refs.slice(1));
  const text=canonical(result);this.db.transaction(()=>{const row=this.row(id);if(row.plan!==canonical(plan))conflict();if(row.result!==null&&row.result!==text)conflict();this.db.rows("UPDATE archive_bundle_collections SET state='verified',result=? WHERE id=?",text,id);});return result;
 }
}
