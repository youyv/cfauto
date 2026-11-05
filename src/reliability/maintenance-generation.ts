import {AuthorityArchive} from './authority-archive';
import {archiveGenerationSource} from './archive-generation-source';
import {GenerationImport} from './generation-import';
import {GenerationActivation} from './generation-activation';
import {ConfigStore,type SqlDatabase} from './config-store';
import {SealedStore} from './sealed-store';
import type {KeyRing} from './credential-envelope';
import {AuthorityDrain} from './authority-drain';
import {canonical,ReliabilityError,type Json} from './protocol';
import type {MaintenanceMessage} from './maintenance-protocol';
/** Current-authority archive -> inactive generation -> guarded replacement only.
 * No legacy-KV bootstrap, arbitrary loader, force switch or public secret input. */
export class MaintenanceGeneration {
 private readonly imports:GenerationImport;
 private readonly activation:GenerationActivation;
 constructor(db:SqlDatabase,private readonly config:ConfigStore,sealed:SealedStore,installation:string,ring:KeyRing,secret:Uint8Array,drain:AuthorityDrain,now:()=>number=Date.now){
  const archive=new AuthorityArchive(db,sealed,installation,{role:'global'});
  this.imports=new GenerationImport(db,config,sealed,ring,secret,id=>archiveGenerationSource(archive,id),now);
  this.activation=new GenerationActivation(db,config,this.imports,drain,now);
 }
 async execute(message:MaintenanceMessage,atomicAck:(receipt:Json)=>void):Promise<Json>{
  const command=message.command,args=command.args as Record<string,any>;
  const guard=()=>{if(command.expected!==null&&canonical(command.expected)!==canonical({...this.config.status()}))throw new ReliabilityError('CONFLICT',409);};guard();let result:Json;
  switch(command.action){
   case 'generation_begin':if(!command.expected?.maintenance)throw new ReliabilityError('MAINTENANCE',409);result=await this.imports.begin({...args,baseGeneration:command.expected.generation,epoch:command.expected.epoch});break;
   case 'generation_resume':result=await this.imports.resume(args.id,args.limit);break;
   case 'generation_inspect':return this.imports.inspect(args.id);
   case 'generation_activation_inspect':return this.activation.inspect(args.id);
   case 'generation_activate':return this.activation.activate({id:command.id,importId:args.importId,drainId:args.drainId},atomicAck);
   default:throw new ReliabilityError('INVALID',400);
  }
  guard();return result;
 }
}
