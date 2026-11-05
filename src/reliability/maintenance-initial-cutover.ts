import {ConfigStore,type SqlDatabase} from './config-store';
import {SealedStore} from './sealed-store';
import type {KeyRing} from './credential-envelope';
import type {InitialCutoverPin,InitialCutoverTarget} from './initial-cutover-pin';
import {InitialCutoverSource} from './initial-cutover-source';
import {GenerationImport} from './generation-import';
import {InitialGenerationActivation} from './initial-generation-activation';
import type {MaintenanceMessage} from './maintenance-protocol';
import {canonical,ReliabilityError,type Json} from './protocol';
/** Empty-authority initial migration only, guarded by an independently provisioned
 * source anchor and the existing atomic initial activation participant. No public
 * source loaders, proof booleans, secret setters or automatic maintenance release. */
export class MaintenanceInitialCutover {
 private readonly source:InitialCutoverSource;private readonly imports:GenerationImport;private readonly activation:InitialGenerationActivation;
 constructor(db:SqlDatabase,private readonly config:ConfigStore,sealed:SealedStore,target:InitialCutoverTarget,private readonly anchor:InitialCutoverPin|undefined,ring:KeyRing,secret:Uint8Array,now:()=>number=Date.now){
  this.source=new InitialCutoverSource(db,config,sealed,target,anchor,now);
  this.imports=new GenerationImport(db,config,sealed,ring,secret,id=>this.source.load(id),now);
  this.activation=new InitialGenerationActivation(db,config,this.imports,this.source,now);
 }
 async execute(message:MaintenanceMessage,atomicAck:(receipt:Json)=>void):Promise<Json>{
  const c=message.command,a=c.args as Record<string,any>;
  if(c.action==='initial_identity')return this.source.identityView();
  if(c.action==='initial_activation_inspect')return this.activation.inspect(a.id);
  const p=this.anchor;if(!p)throw new ReliabilityError('NOT_READY',503);
  if(c.action==='initial_source_inspect')return this.source.inspect(a.id);
  if(c.action==='initial_import_inspect')return this.imports.inspect(p.importId);
  const guard=()=>{if(!c.expected||c.expected.generation!==null||c.expected.maintenance!==1||c.expected.epoch!==p.epoch||canonical(c.expected)!==canonical({...this.config.status()}))throw new ReliabilityError('CONFLICT',409);};guard();let result:Json;
  switch(c.action){
   case 'initial_source_begin':result=this.source.begin(a.id);break;
   case 'initial_source_frame':result=await this.source.frame(a.id,a.ordinal,a.data);break;
   case 'initial_source_commit':result=await this.source.commit(a.id);break;
   case 'initial_import_begin':result=await this.imports.begin({id:p.importId,target:p.generation,source:p.sourceId,baseGeneration:null,epoch:p.epoch,credentials:'migrate',unprefixed:p.unprefixed});break;
   case 'initial_import_resume':result=await this.imports.resume(p.importId,a.limit);break;
   case 'initial_activate':return this.activation.activate({id:c.id,importId:p.importId,proofId:p.id,epoch:p.epoch},atomicAck);
   default:throw new ReliabilityError('INVALID',400);
  }
  guard();return result;
 }
}
