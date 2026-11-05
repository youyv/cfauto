import type {SqlDatabase} from './config-store';
import {AuthorityArchive} from './authority-archive';
import {canonical,identifier,revision,sha256,ReliabilityError} from './protocol';
import {shape} from './business-command';
export const ARCHIVE_FRAME_BYTES=3072;
const MAX_PACKET_BYTES=8*1024*1024;
export interface ArchivePacketDescriptor {id:string;archive:string;part:number|null;generation:string;epoch:number;digest:string;bytes:number;frames:number}
interface TransferRow extends Record<string,unknown>{id:string;direction:string;archive_id:string;part:number;generation:string;epoch:number;digest:string;bytes:number;frames:number;state:string;error:string|null}
interface FrameRow extends Record<string,unknown>{ordinal:number;data:string;digest:string}
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
const encoder=new TextEncoder();
function encoded(bytes:Uint8Array):string{let result='';for(let i=0;i<bytes.length;i+=4096)result+=String.fromCharCode(...bytes.subarray(i,i+4096));return btoa(result);}
function decoded(text:string):Uint8Array{if(typeof text!=='string'||text.length>4096||!text.length)invalid();let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(text),c=>c.charCodeAt(0));}catch{return invalid();}if(encoded(bytes)!==text)invalid();return bytes;}
export function packetDescriptor(raw:unknown):ArchivePacketDescriptor {
 const value=JSON.parse(canonical(raw));shape(value,'id,archive,part,generation,epoch,digest,bytes,frames');
 identifier(value.id);identifier(value.archive);identifier(value.generation);if(value.id.length>60||value.archive.length>60)invalid();revision(value.epoch);revision(value.bytes);revision(value.frames);
 if(value.part!==null){revision(value.part);if(value.part>=512)invalid();}
 if(typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||value.bytes<1||value.bytes>MAX_PACKET_BYTES||value.frames!==Math.ceil(value.bytes/ARCHIVE_FRAME_BYTES))invalid();
 return value as ArchivePacketDescriptor;
}
/** Retained ciphertext-only packet frames. Transport readiness never means migration
 * readiness. Import frames are unverified staging until the entire packet digest,
 * original sealed packet authentication and archive context have all been verified.
 * No downloaded SQL, config activation, deletion or provider request is performed. */
export class ArchivePacketTransport {
 constructor(private readonly db:SqlDatabase,private readonly archive:AuthorityArchive){
  db.rows('CREATE TABLE IF NOT EXISTS archive_packet_transfers (id TEXT PRIMARY KEY,direction TEXT NOT NULL,archive_id TEXT NOT NULL,part INTEGER NOT NULL,generation TEXT NOT NULL,epoch INTEGER NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,frames INTEGER NOT NULL,state TEXT NOT NULL,error TEXT)');
  db.rows('CREATE TABLE IF NOT EXISTS archive_transfer_frames (transfer TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(transfer,ordinal))');
 }
 private row(id:string):TransferRow{identifier(id);const row=this.db.rows<TransferRow>('SELECT * FROM archive_packet_transfers WHERE id=?',id)[0];if(!row)unavailable();packetDescriptor(this.descriptor(row));if(!['export','import'].includes(row.direction)||!['receiving','complete'].includes(row.state))conflict();return row;}
 private descriptor(row:TransferRow):ArchivePacketDescriptor{return {id:row.id,archive:row.archive_id,part:row.part===-1?null:row.part,generation:row.generation,epoch:row.epoch,digest:row.digest,bytes:row.bytes,frames:row.frames};}
 info(id:string):{descriptor:ArchivePacketDescriptor;direction:string;state:string;received:number;error:string|null;migrationReady:false}{const row=this.row(id);return {descriptor:this.descriptor(row),direction:row.direction,state:row.state,received:this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM archive_transfer_frames WHERE transfer=?',id)[0].n,error:row.error,migrationReady:false};}
 async inventory(id:string):Promise<{id:string;generation:string;epoch:number;pages:number;tables:number;rows:number;migrationReady:false;scope:string}>{const result=await this.archive.snapshot(id);return {id,generation:result.manifest.generation,epoch:result.manifest.epoch,pages:result.manifest.pages.length,tables:result.manifest.tables.length,rows:result.manifest.tables.reduce((n,t)=>n+t.rows,0),migrationReady:false,scope:'one_durable_object'};}
 async beginExport(id:string,archive:string,part:number|null):Promise<ReturnType<ArchivePacketTransport['info']>>{
  identifier(id);identifier(archive);if(id.length>60||archive.length>60)invalid();if(part!==null){revision(part);if(part>=512)invalid();}
  const previous=this.db.rows<TransferRow>('SELECT * FROM archive_packet_transfers WHERE id=?',id)[0];if(previous&&(previous.direction!=='export'||previous.archive_id!==archive||previous.part!==(part??-1)))conflict();
  const packet=part===null?await this.archive.rootPacket(archive):await this.archive.pagePacket(archive,part),text=canonical(packet),bytes=encoder.encode(text);
  const meta=this.archive.inspect(archive) as {generation:string;epoch:number};const descriptor=packetDescriptor({id,archive,part,generation:meta.generation,epoch:meta.epoch,digest:await sha256(text),bytes:bytes.length,frames:Math.ceil(bytes.length/ARCHIVE_FRAME_BYTES)});
  const frames:FrameRow[]=[];for(let ordinal=0;ordinal<descriptor.frames;ordinal++){const data=encoded(bytes.subarray(ordinal*ARCHIVE_FRAME_BYTES,Math.min(bytes.length,(ordinal+1)*ARCHIVE_FRAME_BYTES)));frames.push({ordinal,data,digest:await sha256(data)});}
  return this.db.transaction(()=>{const old=this.db.rows<TransferRow>('SELECT * FROM archive_packet_transfers WHERE id=?',id)[0];if(old){if(old.direction!=='export'||canonical(this.descriptor(old))!==canonical(descriptor))conflict();return this.info(id);}
   this.insert(descriptor,'export','complete');for(const f of frames)this.db.rows('INSERT INTO archive_transfer_frames VALUES (?,?,?,?)',id,f.ordinal,f.data,f.digest);return this.info(id);
  });
 }
 private insert(d:ArchivePacketDescriptor,direction:string,state:string):void{this.db.rows('INSERT INTO archive_packet_transfers VALUES (?,?,?,?,?,?,?,?,?,?,NULL)',d.id,direction,d.archive,d.part??-1,d.generation,d.epoch,d.digest,d.bytes,d.frames,state);}
 beginImport(raw:unknown):ReturnType<ArchivePacketTransport['info']>{const descriptor=packetDescriptor(raw);return this.db.transaction(()=>{const old=this.db.rows<TransferRow>('SELECT * FROM archive_packet_transfers WHERE id=?',descriptor.id)[0];if(old){if(old.direction!=='import'||canonical(this.descriptor(old))!==canonical(descriptor))conflict();}else this.insert(descriptor,'import','receiving');return this.info(descriptor.id);});}
 private frameSize(row:TransferRow,ordinal:number):number{revision(ordinal);if(ordinal>=row.frames)invalid();return Math.min(ARCHIVE_FRAME_BYTES,row.bytes-ordinal*ARCHIVE_FRAME_BYTES);}
 async exportFrame(id:string,ordinal:number):Promise<{id:string;ordinal:number;data:string;digest:string}>{const row=this.row(id);if(row.direction!=='export'||row.state!=='complete')conflict();const size=this.frameSize(row,ordinal),frame=this.db.rows<FrameRow>('SELECT ordinal,data,digest FROM archive_transfer_frames WHERE transfer=? AND ordinal=?',id,ordinal)[0];if(!frame)unavailable();if(decoded(frame.data).length!==size||await sha256(frame.data)!==frame.digest)conflict();return {id,ordinal,data:frame.data,digest:frame.digest};}
 async putFrame(id:string,ordinal:number,data:string):Promise<{duplicate:boolean}>{const row=this.row(id);if(row.direction!=='import')conflict();const size=this.frameSize(row,ordinal),bytes=decoded(data);if(bytes.length!==size)invalid();const digest=await sha256(data);
  return this.db.transaction(()=>{const current=this.row(id);if(canonical(this.descriptor(current))!==canonical(this.descriptor(row))||current.direction!=='import')conflict();const old=this.db.rows<FrameRow>('SELECT ordinal,data,digest FROM archive_transfer_frames WHERE transfer=? AND ordinal=?',id,ordinal)[0];if(old){if(old.data!==data||old.digest!==digest)conflict();return {duplicate:true};}if(current.state!=='receiving')conflict();this.db.rows('INSERT INTO archive_transfer_frames VALUES (?,?,?,?)',id,ordinal,data,digest);return {duplicate:false};});
 }
 async commitImport(id:string):Promise<ReturnType<ArchivePacketTransport['info']>>{
  const row=this.row(id);if(row.direction!=='import')conflict();
  try{
   const frames=this.db.rows<FrameRow>('SELECT ordinal,data,digest FROM archive_transfer_frames WHERE transfer=? ORDER BY ordinal',id);if(frames.length!==row.frames)unavailable();
   const bytes=new Uint8Array(row.bytes);let offset=0;for(let ordinal=0;ordinal<frames.length;ordinal++){const frame=frames[ordinal];if(frame.ordinal!==ordinal||await sha256(frame.data)!==frame.digest)conflict();const value=decoded(frame.data);if(value.length!==this.frameSize(row,ordinal))conflict();bytes.set(value,offset);offset+=value.length;}
   let text:string,packet:unknown;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);packet=JSON.parse(text);}catch{return invalid();}
   if(canonical(packet)!==text||await sha256(text)!==row.digest)conflict();
   const current=this.row(id);if(current.direction!=='import'||canonical(this.descriptor(current))!==canonical(this.descriptor(row)))conflict();
   if(row.part===-1)await this.archive.receiveRoot(row.archive_id,row.generation,row.epoch,packet);
   else{const meta=this.archive.inspect(row.archive_id) as {generation:string;epoch:number};if(meta.generation!==row.generation||meta.epoch!==row.epoch)conflict();await this.archive.receivePage(row.archive_id,row.part,packet);}
   return this.db.transaction(()=>{const current=this.row(id);if(canonical(this.descriptor(current))!==canonical(this.descriptor(row)))conflict();this.db.rows("UPDATE archive_packet_transfers SET state='complete',error=NULL WHERE id=?",id);return this.info(id);});
  }catch(error){this.db.rows('UPDATE archive_packet_transfers SET error=? WHERE id=?',error instanceof ReliabilityError?error.code:'NOT_READY',id);throw new ReliabilityError(error instanceof ReliabilityError?error.code:'NOT_READY',error instanceof ReliabilityError?error.status:503);}
 }
}
