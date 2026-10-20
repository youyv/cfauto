import {storeAutomationDecision,readAutomationDecision} from './automation-decision-store';
import { AutomationCycles, CRON_MAX_LATENESS_MS } from './automation-cycle';
import type { AutomationDecision, AutomationPlanner } from './automation-planner';
import { ConfigStore, type SqlDatabase } from './config-store';
import { canonical, identifier, ReliabilityError, revision, type Json } from './protocol';
import { SealedStore, type SealedContext } from './sealed-store';
import { TaskDispatch } from './task-dispatch';
import type { PreparedTaskInput } from './task-preparation';
import { WebhookOutbox } from './webhook-outbox';
interface FlowRow extends Record<string,unknown> {cycle:string;generation:string;at:number;expires:number;state:string;error:string|null}
interface LaneRow extends Record<string,unknown> {cycle:string;template:string;state:string;task:string|null;notice:string|null;attempts:number;error:string|null}
const context=(row:FlowRow):SealedContext=>({id:'decision_'+row.cycle,kind:'artifact',account:'automation',generation:row.generation});
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
export interface AutomationFlowOptions {
    /** Must preserve TaskPreparation's guard inside its first-insert transaction.
     * Duplicate task receipts bypass the guard, allowing late lost-ACK recovery. */
    submit:(plan:PreparedTaskInput,guard:()=>void)=>Promise<{id:string;duplicate:boolean}>;
    arm:(delay:number)=>Promise<void>; now?:()=>number;
}
/** Durable Cron orchestration. No direct business HTTP writes; all mutations use
 * the existing task executor and receipt ledger. Planning happens once, before a
 * sealed decision manifest. Old/incomplete decisions never get new randomness.
 * Retention GC is audit-only under the user's retain-all policy, not deletion. */
export class AutomationFlow {
    private readonly work=new Map<string,Promise<void>>();
    private readonly now:()=>number;
    constructor(private readonly db:SqlDatabase,private readonly config:ConfigStore,private readonly cycles:AutomationCycles,private readonly sealed:SealedStore,
        private readonly planner:Pick<AutomationPlanner,'prepare'>,private readonly dispatch:TaskDispatch,private readonly notices:WebhookOutbox,private readonly options:AutomationFlowOptions) {
        this.now=options.now??Date.now;
        db.rows('CREATE TABLE IF NOT EXISTS automation_flows (cycle TEXT PRIMARY KEY,generation TEXT NOT NULL,at INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,error TEXT)');
        db.rows('CREATE TABLE IF NOT EXISTS automation_lanes (cycle TEXT NOT NULL,template TEXT NOT NULL,state TEXT NOT NULL,task TEXT,notice TEXT,attempts INTEGER NOT NULL,error TEXT,PRIMARY KEY(cycle,template))');
        db.rows('CREATE TABLE IF NOT EXISTS automation_tick_cursor (generation TEXT PRIMARY KEY, after_rowid INTEGER NOT NULL)');
        db.rows('CREATE TABLE IF NOT EXISTS automation_gc_audits (cycle TEXT PRIMARY KEY,generation TEXT NOT NULL,at INTEGER NOT NULL,policy TEXT NOT NULL,counts TEXT NOT NULL)');
    }
    private row(cycle:string):FlowRow {identifier(cycle);const row=this.db.rows<FlowRow>('SELECT * FROM automation_flows WHERE cycle=?',cycle)[0];if(!row)unavailable();return row;}
    private active(row:FlowRow):boolean {const meta=this.config.status();return !meta.maintenance&&meta.generation===row.generation;}
    inspect(cycle:string):Json {
        const row=this.row(cycle);
        return {cycle,state:row.state,error:row.error,lanes:this.db.rows<LaneRow>('SELECT * FROM automation_lanes WHERE cycle=? ORDER BY template',cycle).map(l=>({template:l.template,state:l.state,task:l.task,notice:l.notice,error:l.error})),retentionAudit:this.db.rows('SELECT cycle FROM automation_gc_audits WHERE cycle=?',cycle).length===1};
    }
    async start(scheduledAt:number):Promise<Json> {
        const now=this.now();revision(now);revision(scheduledAt+CRON_MAX_LATENESS_MS);
        const cycle=await this.cycles.open(scheduledAt,now);
        const fresh=this.db.transaction(()=>{
            if(this.db.rows('SELECT cycle FROM automation_flows WHERE cycle=?',cycle.id).length)return false;
            this.db.rows("INSERT INTO automation_flows VALUES (?,?,?,?,'planning',NULL)",cycle.id,cycle.generation,now,scheduledAt+CRON_MAX_LATENESS_MS);return true;
        });
        await this.coalesce(cycle.id,fresh);return this.inspect(cycle.id);
    }
    private coalesce(cycle:string,fresh=false):Promise<void> {
        const prior=this.work.get(cycle);if(prior)return prior;
        const pending=this.drive(cycle,fresh).finally(()=>{if(this.work.get(cycle)===pending)this.work.delete(cycle);});
        this.work.set(cycle,pending);return pending;
    }
    /** Invoked by the global alarm or terminal-receipt observer; never wakes or
     * unlocks unknown account writes. A parked admission needs operator review. */
    async tick():Promise<void> {
        // Persist a round-robin batch BEFORE awaits. Long-running tasks must not
        // repeatedly occupy the first page; a failed drive must not starve its tail.
        const rows=this.db.transaction(()=>{
            const meta=this.config.status();if(meta.maintenance||!meta.generation)return [];
            const cursor=this.db.rows<{after_rowid:number}>('SELECT after_rowid FROM automation_tick_cursor WHERE generation=?',meta.generation)[0]?.after_rowid??0;
            const select=(after:number)=>this.db.rows<FlowRow & {position:number}>("SELECT rowid AS position,* FROM automation_flows WHERE generation=? AND rowid>? AND state IN ('planning','active') ORDER BY rowid LIMIT 20",meta.generation,after);
            let selected=select(cursor);if(!selected.length&&cursor)selected=select(0);
            if(selected.length)this.db.rows('INSERT INTO automation_tick_cursor VALUES (?,?) ON CONFLICT(generation) DO UPDATE SET after_rowid=excluded.after_rowid',meta.generation,selected[selected.length-1].position);
            return selected;
        });
        if(rows.length)await this.options.arm(1000);
        for(const row of rows)await this.coalesce(row.cycle);
    }
    /** Receipt-driven recheck, including parked reviews; never retries an external write. */
    async observeTask(task:string):Promise<void> {
        identifier(task);
        for(const row of this.db.rows<{cycle:string}>('SELECT cycle FROM automation_lanes WHERE task=?',task))await this.coalesce(row.cycle);
    }
    private async restore(row:FlowRow):Promise<AutomationDecision|null> {
        if(!this.db.rows('SELECT id FROM sealed_objects WHERE id=?',context(row).id).length)return null;
        const value=await readAutomationDecision(this.sealed,{cycle:row.cycle,generation:row.generation,at:row.at});
        if(value.schema!==1||value.cycle!==row.cycle||value.generation!==row.generation||value.at!==row.at||!Array.isArray(value.lanes)||value.lanes.length>10||new Set(value.lanes.map(l=>l.template)).size!==value.lanes.length)unavailable();
        for(const lane of value.lanes)if(lane.plan.scope!=='automation'||lane.plan.key!==this.cycles.taskKey(row.cycle,lane.template)||lane.plan.generation!==row.generation)unavailable();
        return value;
    }
    private async drive(cycle:string,fresh:boolean):Promise<void> {
        const row=this.row(cycle);if(!this.active(row)||row.state==='complete'||row.state==='planning_failed')return;
        if(row.state!=='needs_review')await this.options.arm(1000); // Parked review never creates a recurring wake.
        let decision:AutomationDecision|null;
        try {
            decision=await this.restore(row);
            if(!decision) {
                if(!fresh){this.db.rows("UPDATE automation_flows SET state='planning_failed',error='INCOMPLETE_MANIFEST' WHERE cycle=?",cycle);return;}
                decision=await this.planner.prepare(cycle,row.at);
                await storeAutomationDecision(this.sealed,{cycle:row.cycle,generation:row.generation,at:row.at},decision);
                decision=await this.restore(row);if(!decision)unavailable();
            }
        } catch(error) {
            this.db.rows("UPDATE automation_flows SET state='planning_failed',error=? WHERE cycle=?",error instanceof ReliabilityError?error.code:'NOT_READY',cycle);return;
        }
        if(!decision)return unavailable();
        this.db.transaction(()=>{
            for(const lane of decision!.lanes)this.db.rows("INSERT OR IGNORE INTO automation_lanes VALUES (?,?,'ready',NULL,NULL,0,NULL)",cycle,lane.template);
            this.db.rows("UPDATE automation_flows SET state='active' WHERE cycle=?",cycle);
        });
        for(const lane of decision.lanes) {
            if(!this.active(row))return;
            let status=this.db.rows<LaneRow>('SELECT * FROM automation_lanes WHERE cycle=? AND template=?',cycle,lane.template)[0];
            if(['ready','submitting'].includes(status.state)) {
                if(status.attempts>=8){this.db.rows("UPDATE automation_lanes SET state='admission_unknown',error='RETRY_BUDGET' WHERE cycle=? AND template=?",cycle,lane.template);continue;}
                this.db.rows("UPDATE automation_lanes SET state='submitting',attempts=attempts+1 WHERE cycle=? AND template=?",cycle,lane.template);
                try {
                    const task=await this.options.submit(lane.plan,()=>{
                        if(this.now()>row.expires)throw new ReliabilityError('CONFLICT',409);
                        // This runs in the same transaction as the first dispatch insert.
                        // Planner-time checks alone cannot fence a concurrent manual admission.
                        for(const target of lane.plan.targets)if(this.db.rows("SELECT task FROM dispatch_outbox WHERE account=? AND state!='terminal' AND task NOT IN (SELECT task FROM automation_lanes WHERE cycle=? AND task IS NOT NULL) LIMIT 1",target.account,cycle).length)throw new ReliabilityError('CONFLICT',409);
                    });
                    this.db.rows("UPDATE automation_lanes SET state='running',task=?,error=NULL WHERE cycle=? AND template=?",task.id,cycle,lane.template);
                } catch(error) {
                    const code=error instanceof ReliabilityError?error.code:'NOT_READY';
                    const state=code==='INVALID'||code==='CONFLICT'?'refused':'submitting';
                    this.db.rows('UPDATE automation_lanes SET state=?,error=? WHERE cycle=? AND template=?',state,code,cycle,lane.template);continue;
                }
                status=this.db.rows<LaneRow>('SELECT * FROM automation_lanes WHERE cycle=? AND template=?',cycle,lane.template)[0];
            }
            if(!status.task || ['refused','admission_unknown'].includes(status.state))continue;
            const targets=this.dispatch.inspect(status.task);
            if(!targets.length)unavailable();
            if(targets.some(t=>t.state!=='terminal')) {
                const unknown=this.db.rows("SELECT task FROM deployment_runs WHERE task=? AND status='needs_review' LIMIT 1",status.task).length>0;
                this.db.rows('UPDATE automation_lanes SET state=? WHERE cycle=? AND template=?',unknown?'needs_review':'running',cycle,lane.template);continue;
            }
            const success=targets.every(t=>t.outcome==='succeeded');
            // A configured but unsupported destination is not an absent setting.
            // Retain the frozen planner decision as a safe terminal projection;
            // no outbox record or retry is created, and task success stays separate.
            if(success&&decision.issues.some(issue=>issue.template===lane.template&&issue.code==='WEBHOOK_UNSUPPORTED')) {
                this.db.rows("UPDATE automation_lanes SET state='notification_unsupported',error='WEBHOOK_UNSUPPORTED' WHERE cycle=? AND template=?",cycle,lane.template);continue;
            }
            if(success&&lane.webhook) {
                try {
                    const notice=await this.notices.enqueue(status.task,row.generation,lane.webhook);
                    this.db.rows('UPDATE automation_lanes SET notice=? WHERE cycle=? AND template=?',notice.id,cycle,lane.template);
                    const outcome=await this.notices.send(notice.id);
                    if(outcome.state==='unknown'||outcome.state==='in_flight') {this.db.rows("UPDATE automation_lanes SET state='notification_unknown' WHERE cycle=? AND template=?",cycle,lane.template);continue;}
                    if(outcome.state==='queued'){this.db.rows("UPDATE automation_lanes SET state='running' WHERE cycle=? AND template=?",cycle,lane.template);continue;}
                    if(outcome.state==='rejected'){this.db.rows("UPDATE automation_lanes SET state='notification_rejected' WHERE cycle=? AND template=?",cycle,lane.template);continue;}
                } catch {this.db.rows("UPDATE automation_lanes SET state='notification_unknown',error='NOT_READY' WHERE cycle=? AND template=?",cycle,lane.template);continue;}
            }
            this.db.rows('UPDATE automation_lanes SET state=? WHERE cycle=? AND template=?',success?'succeeded':'failed',cycle,lane.template);
        }
        if(!this.active(row))return;
        const states=this.db.rows<LaneRow>('SELECT * FROM automation_lanes WHERE cycle=?',cycle);
        if(decision.checked&&!states.some(s=>['ready','submitting','admission_unknown'].includes(s.state)))this.config.recordRuntime(cycle+'_check',{lastCheck:decision.at});
        if(decision.gc) {
            const old=this.db.rows('SELECT cycle FROM automation_gc_audits WHERE cycle=?',cycle);
            if(!old.length) {
                const count=(table:string)=>this.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM '+table)[0].n;
                const counts=canonical({sealedObjects:count('sealed_objects'),tasks:count('dispatch_tasks'),notices:count('webhook_outbox'),deleted:0});
                this.db.rows('INSERT INTO automation_gc_audits VALUES (?,?,?,?,?)',cycle,row.generation,decision.at,'retain_all_no_deletes',counts);
            }
            this.config.recordRuntime(cycle+'_gc',{lastGc:decision.at});
        }
        const pending=states.some(s=>['ready','submitting','running'].includes(s.state));
        const review=states.some(s=>['needs_review','admission_unknown','notification_unknown'].includes(s.state));
        this.db.rows('UPDATE automation_flows SET state=? WHERE cycle=?',pending?'active':review?'needs_review':'complete',cycle);
        if(pending)await this.options.arm(5000);
    }
}
