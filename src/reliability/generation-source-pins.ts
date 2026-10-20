import type {SqlDatabase} from './config-store';
import {SealedStore} from './sealed-store';
import type {GenerationSource,PreparedGeneration} from './generation-data';
import {customSourceCode,type CustomSourceArtifact} from './source-artifact';
import {canonical,identifier,ReliabilityError,sha256} from './protocol';
function unavailable():never{throw new ReliabilityError('NOT_READY',503);}
function conflict():never{throw new ReliabilityError('CONFLICT',409);}
interface Pin extends Record<string,unknown>{generation:string;template:string;digest:string;import_id:string;preparation:string;source_identity:string;provenance:string}
/** Migrated source lineage is explicit. It does not fabricate successful deploy runs
 * in the new generation. The sealed import retains the original bytes and origin
 * key/generation/task references. No cleanup or public write API is provided. */
export class GenerationSourcePins {
 constructor(private readonly db:SqlDatabase,private readonly sealed:SealedStore){db.rows('CREATE TABLE IF NOT EXISTS generation_source_pins (generation TEXT NOT NULL,template TEXT NOT NULL,digest TEXT NOT NULL,import_id TEXT NOT NULL,preparation TEXT NOT NULL,source_identity TEXT NOT NULL,provenance TEXT NOT NULL,PRIMARY KEY(generation,template,digest))');}
 /** Trusted synchronous participant in GenerationImport final verification transaction.
  * This pins only inactive data; it never sets config/credential/runtime pointers. */
 stageInTransaction(id:string,generation:string,preparation:string,sourceIdentity:string,sources:GenerationSource[]):void {
  identifier(id);identifier(generation);identifier(preparation);if(!/^[a-f0-9]{64}$/.test(sourceIdentity))conflict();
  const imported=this.db.rows<{target:string;prepared:string;state:string}>('SELECT target,prepared,state FROM generation_imports WHERE id=?',id)[0],meta=this.db.rows<{generation:string|null}>('SELECT generation FROM config_meta WHERE id=1')[0];
  if(!imported||imported.target!==generation||imported.prepared!==preparation||!['staging','verified'].includes(imported.state)||meta.generation===generation)conflict();
  for(const source of sources){const {artifact,provenance}=source;const value={generation,template:artifact.template,digest:artifact.digest,import_id:id,preparation,source_identity:sourceIdentity,provenance:canonical(provenance)};
   const old=this.db.rows<Pin>('SELECT * FROM generation_source_pins WHERE generation=? AND template=? AND digest=?',generation,artifact.template,artifact.digest)[0];if(old){if(canonical({...old})!==canonical(value))conflict();continue;}
   this.db.rows('INSERT INTO generation_source_pins VALUES (?,?,?,?,?,?,?)',generation,artifact.template,artifact.digest,id,preparation,sourceIdentity,canonical(provenance));
  }
 }
 async load(generation:string,template:string,digest:string):Promise<CustomSourceArtifact>{
  identifier(generation);identifier(template);if(!/^[a-f0-9]{64}$/.test(digest))unavailable();
  const check=()=>{const meta=this.db.rows<{generation:string|null}>('SELECT generation FROM config_meta WHERE id=1')[0];if(meta.generation!==generation)unavailable();const active=this.db.rows<{state:string}>('SELECT state FROM config_generations WHERE id=?',generation)[0];if(active?.state!=='active')unavailable();};check();
  const pin=this.db.rows<Pin>('SELECT * FROM generation_source_pins WHERE generation=? AND template=? AND digest=?',generation,template,digest)[0];if(!pin)unavailable();
  const imported=this.db.rows<{target:string;prepared:string;state:string;digest:string}>('SELECT target,prepared,state,digest FROM generation_imports WHERE id=?',pin.import_id)[0];if(!imported||imported.target!==generation||imported.prepared!==pin.preparation||!['verified','activated'].includes(imported.state))unavailable();
  const value=await this.sealed.get({id:pin.preparation,kind:'artifact',account:'migration',generation}) as unknown as {schema:number;requestDigest:string;sourceIdentity:string;data:PreparedGeneration};
  if(value.schema!==1||value.requestDigest!==imported.digest||value.sourceIdentity!==pin.source_identity||!Array.isArray(value.data?.customSources))unavailable();
  const sources=value.data.customSources.filter(s=>s.artifact?.template===template&&s.artifact?.digest===digest);if(sources.length!==1||canonical(sources[0].provenance)!==pin.provenance)unavailable();
  const artifact=sources[0].artifact;if(artifact.kind!=='custom'||canonical(Object.keys(artifact).sort())!==canonical(['code','digest','kind','template']))unavailable();customSourceCode(artifact.code);if(await sha256(artifact.code)!==digest)unavailable();
  check();const current=this.db.rows<Pin>('SELECT * FROM generation_source_pins WHERE generation=? AND template=? AND digest=?',generation,template,digest)[0];if(!current||canonical({...current})!==canonical({...pin}))conflict();
  return {...artifact};
 }
}
