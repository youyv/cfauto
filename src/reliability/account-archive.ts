import {AuthorityArchive} from './authority-archive';
import {ArchivePacketTransport} from './archive-packet-transport';
import {runArchiveCommand} from './maintenance-archive';
import {maintenanceCommand,type MaintenanceMessage} from './maintenance-protocol';
import {canonical,ReliabilityError,type Json} from './protocol';
import {accountId} from './business-command';
import type {SqlDatabase} from './config-store';
import {SealedStore} from './sealed-store';
/** Account-only archive. Global durable independent maintenance authorization is
 * checked before creating archive stores and after every action; no ConfigStore or
 * queue restore is created on an account object. Transport never activates data. */
export class AccountArchive {
 private archive:AuthorityArchive|undefined;private transport:ArchivePacketTransport|undefined;
 constructor(private readonly db:SqlDatabase,private readonly sealed:SealedStore,private readonly account:string,private readonly installation:string,private readonly authorize:(message:MaintenanceMessage)=>Promise<void>){accountId(account);}
 async execute(raw:MaintenanceMessage):Promise<Json>{const message=JSON.parse(canonical(raw)) as MaintenanceMessage,command=maintenanceCommand(message.command);if(command.action!=='account_archive'||(command.args as {account:string}).account!==this.account)throw new ReliabilityError('INVALID',403);message.command=command;
  await this.authorize(message);
  if(!this.archive){this.archive=new AuthorityArchive(this.db,this.sealed,this.installation,{role:'account',account:this.account});this.transport=new ArchivePacketTransport(this.db,this.archive);}
  const args=command.args as {account:string;action:MaintenanceMessage['command']['action'];args:Json};
  const result=await runArchiveCommand(this.archive,this.transport!,{id:command.id,action:args.action,expected:command.expected,args:args.args});
  await this.authorize(message);return result;
 }
}
