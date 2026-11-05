import { ConfigStore, type SqlDatabase } from './config-store';
import { SealedStore, type SealedContext } from './sealed-store';
import { canonical, identifier, revision, ReliabilityError, type Json } from './protocol';

export const CRON_WINDOW_MS=5*60*1000;
export const CRON_MAX_LATENESS_MS=2*CRON_WINDOW_MS;
interface CycleRow extends Record<string,unknown> { id:string; generation:string; window:number; epoch:number; dependencies:string; state:string }
const conflict=():never=>{throw new ReliabilityError('CONFLICT',409);};
const context=(row:CycleRow):SealedContext=>({id:row.id,kind:'artifact',account:'automation',generation:row.generation});
/** Internal global-DO cycle snapshot boundary, not a production Cron entry point.
 * A window is claimed once per generation, regardless of concurrent configuration
 * edits. Reservation precedes encryption; recovery may seal only the SAME revision
 * vector, never silently replan a reserved cycle against newer user settings.
 * No task execution, external notification or GC deletion is implied by 'ready'. */
export class AutomationCycles {
    constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly sealed:SealedStore) {
        db.rows('CREATE TABLE IF NOT EXISTS automation_cycles (id TEXT PRIMARY KEY, generation TEXT NOT NULL, window INTEGER NOT NULL, epoch INTEGER NOT NULL, dependencies TEXT NOT NULL, state TEXT NOT NULL, UNIQUE(generation,window))');
    }
    async open(scheduledAt:number,now:number):Promise<{id:string;state:string;window:number;generation:string}> {
        revision(scheduledAt);revision(now);
        if (scheduledAt>now || now-scheduledAt>CRON_MAX_LATENESS_MS) throw new ReliabilityError('INVALID',400);
        const window=Math.floor(scheduledAt/CRON_WINDOW_MS)*CRON_WINDOW_MS;
        const view=this.config.readAll();
        const expected=view.records.map(r=>({domain:r.domain,revision:r.revision}));
        // readAll's watermark also detects a newly inserted domain, not only changes
        // to a previously enumerated record. No values/URLs/credentials in SQL index.
        const dependencies=canonical({expected,watermark:view.watermark});
        const row=this.db.transaction(()=>{
            const meta=this.config.status();
            if(meta.maintenance)throw new ReliabilityError('MAINTENANCE',503);
            if(meta.generation!==view.generation || meta.epoch!==view.epoch)conflict();
            const prior=this.db.rows<CycleRow>('SELECT * FROM automation_cycles WHERE generation=? AND window=?',view.generation,window)[0];
            if(prior)return prior;
            const id='cycle_'+crypto.randomUUID().replace(/-/g,'');
            this.db.rows("INSERT INTO automation_cycles VALUES (?,?,?,?,?,'reserved')",id,view.generation,window,view.epoch,dependencies);
            return this.get(id);
        });
        if(row.state==='reserved') {
            if(row.epoch!==view.epoch || row.dependencies!==dependencies)conflict();
            const snapshot={schema:1,cycle:row.id,window:row.window,view};
            await this.sealed.put(context(row),snapshot as unknown as Json);
            if(canonical(await this.sealed.get(context(row)))!==canonical(snapshot))conflict();
            // Config may have changed while encrypting; this is still the original
            // frozen view. Actual admission must assert its generation/epoch/vector.
            this.db.transaction(()=>{
                const current=this.get(row.id);
                if(current.dependencies!==row.dependencies || current.epoch!==row.epoch)conflict();
                this.db.rows("UPDATE automation_cycles SET state='ready' WHERE id=? AND state='reserved'",row.id);
            });
        }
        return {id:row.id,state:this.get(row.id).state,window:row.window,generation:row.generation};
    }
    private get(id:string):CycleRow {
        identifier(id);const row=this.db.rows<CycleRow>('SELECT * FROM automation_cycles WHERE id=?',id)[0];
        if(!row)throw new ReliabilityError('NOT_READY',404);return row;
    }
    /** Recovery reads remain available after the scheduling window expires. This
     * does not authorize new work; dispatch/admission still own mutation barriers. */
    async read(id:string):Promise<Json> {
        const row=this.get(id);if(row.state!=='ready')throw new ReliabilityError('NOT_READY',503);
        const snapshot=await this.sealed.get(context(row)) as any;
        if(snapshot?.schema!==1 || snapshot.cycle!==id || snapshot.window!==row.window || snapshot.view?.generation!==row.generation || snapshot.view.epoch!==row.epoch || !Array.isArray(snapshot.view.records))conflict();
        const dependencies=canonical({expected:snapshot.view.records.map((r:any)=>({domain:r.domain,revision:r.revision})),watermark:snapshot.view.watermark});
        if(dependencies!==row.dependencies)conflict();return snapshot;
    }
    /** A server-owned lane ID maps to the same admission key on every retry. */
    taskKey(id:string,lane:string):string {this.get(id);identifier(lane);const key=id+'_'+lane;identifier(key);return key;}
}
