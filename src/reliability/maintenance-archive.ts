import {AuthorityArchive} from './authority-archive';
import {ArchivePacketTransport} from './archive-packet-transport';
import {ConfigStore,type SqlDatabase} from './config-store';
import {SealedStore} from './sealed-store';
import {canonical,ReliabilityError,type Json} from './protocol';
import type {MaintenanceMessage} from './maintenance-protocol';
export async function runArchiveCommand(archive:AuthorityArchive,transport:ArchivePacketTransport,command:MaintenanceMessage['command']):Promise<Json>{const args=command.args as Record<string,any>;let result:unknown;
  switch(command.action){
   case 'archive_create':if(!command.expected?.generation||command.expected.maintenance!==1)throw new ReliabilityError('MAINTENANCE',409);result=await archive.create(args.id,command.expected.generation,command.expected.epoch);break;
   case 'archive_inventory':result=await transport.inventory(args.id);break;
   case 'archive_export_begin':result=await transport.beginExport(args.id,args.archive,args.part);break;
   case 'archive_export_frame':result=await transport.exportFrame(args.id,args.ordinal);break;
   case 'archive_import_begin':result=transport.beginImport(args.descriptor);break;
   case 'archive_import_frame':result=await transport.putFrame(args.id,args.ordinal,args.data);break;
   case 'archive_import_commit':result=await transport.commitImport(args.id);break;
   case 'archive_finish':result=await archive.finishReceive(args.id);break;
   case 'archive_transfer_status':result=transport.info(args.id);break;
   default:throw new ReliabilityError('INVALID',400);
  }

 return JSON.parse(canonical(result)) as Json;
}
/** Global archive adapter; the account adapter shares the same fixed action runner. */
export class MaintenanceArchive {
 private readonly archive:AuthorityArchive;private readonly transport:ArchivePacketTransport;
 constructor(db:SqlDatabase,private readonly config:ConfigStore,sealed:SealedStore,installation:string){this.archive=new AuthorityArchive(db,sealed,installation,{role:'global'});this.transport=new ArchivePacketTransport(db,this.archive);}
 async execute(message:MaintenanceMessage):Promise<Json>{const guard=()=>{if(message.command.expected!==null&&canonical(message.command.expected)!==canonical({...this.config.status()}))throw new ReliabilityError('CONFLICT',409);};guard();const result=await runArchiveCommand(this.archive,this.transport,message.command);guard();return result;}
}
