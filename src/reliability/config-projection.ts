import {ConfigStore,type SqlDatabase} from './config-store';
import {ReliabilityError} from './protocol';
/** Revision hints only. Compatibility values are read from the authority directly,
 * never from a KV projection. This consumer retains all outbox events/generations,
 * persists no credential, source, variable or webhook value, and is safe to replay. */
export class ConfigProjection {
 constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore){
  db.rows('CREATE TABLE IF NOT EXISTS config_projection (generation TEXT NOT NULL,domain TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(generation,domain))');
  db.rows('CREATE TABLE IF NOT EXISTS config_projection_generations (generation TEXT PRIMARY KEY)');
 }
 consume(limit=100):{processed:number;pending:number}{
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new ReliabilityError('INVALID',400);
  return this.db.transaction(()=>{
   const meta=this.config.status();if(!meta.generation)throw new ReliabilityError('NOT_READY',503);
   if(!this.db.rows('SELECT generation FROM config_projection_generations WHERE generation=?',meta.generation).length){
    this.db.rows('INSERT INTO config_projection SELECT generation,domain,revision FROM config_records WHERE generation=? ON CONFLICT(generation,domain) DO UPDATE SET revision=MAX(config_projection.revision,excluded.revision)',meta.generation);
    this.db.rows('INSERT INTO config_projection_generations VALUES (?)',meta.generation);
   }
   const events=this.db.rows<{id:number;generation:string;domain:string;revision:number}>('SELECT id,generation,domain,revision FROM config_outbox WHERE acknowledged=0 ORDER BY id LIMIT ?',limit);
   for(const event of events){this.db.rows('INSERT INTO config_projection VALUES (?,?,?) ON CONFLICT(generation,domain) DO UPDATE SET revision=MAX(config_projection.revision,excluded.revision)',event.generation,event.domain,event.revision);this.db.rows('UPDATE config_outbox SET acknowledged=1 WHERE id=?',event.id);}
   return {processed:events.length,pending:this.status().pending};
  });
 }
 status():{pending:number;lastAcknowledged:number}{return {pending:this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM config_outbox WHERE acknowledged=0')[0].n,lastAcknowledged:this.db.rows<{n:number}>('SELECT COALESCE(MAX(id),0) AS n FROM config_outbox WHERE acknowledged=1')[0].n};}
}
