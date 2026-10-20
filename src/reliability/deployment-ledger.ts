import { TEMPLATES } from '../config/templates';
import type { SqlDatabase } from './config-store';
import type { BusinessCommand } from './business-command';
import { deploymentIdentity, targetKey, validateDeploymentPlans, type DeploymentPlan } from './deployment-plan';
import { canonical, encoded, identifier, revision, ReliabilityError, type Json } from './protocol';
interface Run extends Record<string, unknown> { seq: number; task: string; generation: string; template: string; scope: string; payload: string; started: number; finished: number | null; status: string }
function conflict(): never { throw new ReliabilityError('CONFLICT',409); }
/** Projection of validated step facts, not caller claims. All mutating methods are
 * synchronous and MUST run in the caller's existing global SQLite transaction.
 * Audit runs are retained; only the legacy journal projection is bounded. */
export class DeploymentLedger {
    constructor(private readonly db: SqlDatabase, private readonly now: () => number = Date.now) {
        db.rows('CREATE TABLE IF NOT EXISTS deployment_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, generation TEXT NOT NULL, template TEXT NOT NULL, part INTEGER NOT NULL, scope TEXT NOT NULL, payload TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, status TEXT NOT NULL, result TEXT, UNIQUE(task,template,part))');
        db.rows('CREATE TABLE IF NOT EXISTS deployment_target_versions (generation TEXT NOT NULL, template TEXT NOT NULL, account TEXT NOT NULL, worker TEXT NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL, task TEXT NOT NULL, PRIMARY KEY(generation,template,account,worker))');
        db.rows('CREATE INDEX IF NOT EXISTS deployment_template_order ON deployment_runs(generation,template,scope,seq)');
    }
    registerInTransaction(task: string, generation: string, input: DeploymentPlan[]): void {
        identifier(task); identifier(generation); const plans=validateDeploymentPlans(input), started=this.now(); revision(started);
        const meta=this.db.rows<{generation:string;maintenance:number}>('SELECT generation,maintenance FROM config_meta WHERE id=1')[0];
        if (!meta || meta.generation!==generation || meta.maintenance) conflict();
        for (const [part,plan] of plans.entries()) {
            if (plan.scope==='full' && canonical(this.registry(generation,plan.template))!==canonical(plan.targets.map(t=>targetKey(t.account,t.worker)).sort())) conflict();
            if (plan.targets.some(t=>!this.db.rows('SELECT seq FROM dispatch_outbox WHERE task=? AND account=?',task,t.account).length)) conflict();
            this.db.rows("INSERT INTO deployment_runs(task,generation,template,part,scope,payload,started,status) VALUES (?,?,?,?,?,?,?,'running')",task,generation,plan.template,part,plan.scope,encoded({...plan,upstreamRevision:this.config(generation,'upstream:'+plan.template).revision}),started);
        }
    }
    recordScriptInTransaction(task: string, generation: string, account: string, ordinal: number): void {
        for (const run of this.db.rows<Run>('SELECT * FROM deployment_runs WHERE task=?',task)) {
            if (run.generation!==generation || run.finished!==null) conflict();
            const plan=JSON.parse(run.payload) as DeploymentPlan, target=plan.targets.find(t=>t.account===account && t.steps[0]===ordinal);
            if (!target) continue;
            this.db.rows('INSERT INTO deployment_target_versions VALUES (?,?,?,?,?,?,?) ON CONFLICT(generation,template,account,worker) DO UPDATE SET source=excluded.source,seq=excluded.seq,task=excluded.task WHERE excluded.seq>=deployment_target_versions.seq',generation,run.template,account,target.worker,deploymentIdentity(plan),run.seq,task);
        }
    }
    recordRemovalInTransaction(generation: string, account: string, command: BusinessCommand): void {
        if (command.kind!=='remove_worker' && command.kind!=='delete_worker') return;
        const templates=command.kind==='remove_worker'?Object.keys(TEMPLATES):[command.template];
        for (const template of templates) this.db.rows("UPDATE deployment_target_versions SET source='null' WHERE generation=? AND template=? AND account=? AND worker=?",generation,template,account,command.worker);
    }
    progressInTransaction(task: string): void {
        if (!this.db.rows('SELECT seq FROM deployment_runs WHERE task=? AND finished IS NULL',task).length) return;
        const unknown=this.db.rows("SELECT ordinal FROM business_step_state WHERE task=? AND state='unknown' LIMIT 1",task).length>0;
        this.db.rows('UPDATE deployment_runs SET status=? WHERE task=? AND finished IS NULL',unknown?'needs_review':'running',task);
    }
    private config(generation: string, domain: string): {revision:number;value:any} {
        const row=this.db.rows<{revision:number;payload:string}>('SELECT revision,payload FROM config_records WHERE generation=? AND domain=?',generation,domain)[0];
        return row?{revision:row.revision,value:JSON.parse(row.payload)}:{revision:0,value:null};
    }
    private write(generation: string, domain: string, value: unknown): void {
        const current=this.config(generation,domain), payload=encoded(value); if (canonical(current.value)===payload) return;
        const next=current.revision+1; revision(next);
        this.db.rows('INSERT INTO config_records VALUES (?,?,?,?) ON CONFLICT(generation,domain) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',generation,domain,next,payload);
        this.db.rows('INSERT INTO config_outbox(generation,domain,revision) VALUES (?,?,?)',generation,domain,next);
    }
    private registry(generation: string, template: string): string[] {
        const accounts=this.config(generation,'accounts').value;
        if (!Array.isArray(accounts)) conflict();
        const keys: string[]=[];
        for (const account of accounts) {
            const workers=account['workers_'+template] ?? [];
            if (!Array.isArray(workers) || workers.some(w=>typeof w!=='string')) conflict();
            keys.push(...workers.map(w=>targetKey(account.accountId,w)));
        }
        if (new Set(keys).size!==keys.length) conflict(); return keys.sort();
    }
    /** The final dispatch receipt and all ledger/journal/config writes commit together.
     * A failed projection cannot release the account permit or pretend completion. */
    completeInTransaction(task: string): void {
        const runs=this.db.rows<Run>('SELECT * FROM deployment_runs WHERE task=? AND finished IS NULL ORDER BY seq',task);
        if (!runs.length || this.db.rows("SELECT seq FROM dispatch_outbox WHERE task=? AND state!='terminal' LIMIT 1",task).length) return;
        for (const run of runs) {
            const meta=this.db.rows<{generation:string}>('SELECT generation FROM config_meta WHERE id=1')[0]; if (meta.generation!==run.generation) conflict();
            const plan=JSON.parse(run.payload) as DeploymentPlan & {upstreamRevision:number}, finished=Math.max(run.started,this.now()); revision(finished);
            const time=new Date(finished).toISOString(), states=new Map(this.db.rows<{account:string;ordinal:number;state:string}>('SELECT account,ordinal,state FROM business_step_state WHERE task=?',task).map(s=>[s.account+':'+s.ordinal,s.state]));
            const outcomes=plan.targets.map(t=>{
                const facts=t.steps.map(n=>states.get(t.account+':'+n));
                if (facts.some(s=>!s || !['verified','failed','skipped'].includes(s))) conflict();
                return {key:targetKey(t.account,t.worker),success:facts.every(s=>s==='verified'),cancelled:facts.every(s=>s==='skipped'),verified:facts.some(s=>s==='verified'),failed:facts.some(s=>s==='failed')};
            });
            const succeeded=outcomes.filter(o=>o.success), allSucceeded=succeeded.length===outcomes.length, cancelled=outcomes.every(o=>o.cancelled);
            const head=this.db.rows<{seq:number}>("SELECT seq FROM deployment_runs WHERE generation=? AND template=? AND scope='full' ORDER BY seq DESC LIMIT 1",run.generation,run.template)[0];
            const currentKeys=this.registry(run.generation,run.template), identity=deploymentIdentity(plan);
            const versions=new Map(this.db.rows<{account:string;worker:string;source:string}>('SELECT account,worker,source FROM deployment_target_versions WHERE generation=? AND template=?',run.generation,run.template).map(v=>[targetKey(v.account,v.worker),v.source]));
            const coversCurrent=canonical(currentKeys)===canonical(outcomes.map(o=>o.key).sort());
            const currentSource=currentKeys.length>0 && currentKeys.every(k=>versions.get(k)===identity);
            // Both full and partial work from an older intent must not rewrite a newer
            // full intent or a user-edited upstream, even if its HTTP effects succeeded.
            const superseded=(head!==undefined && head.seq>run.seq);
            const sourceChanged=this.config(run.generation,'upstream:'+run.template).revision!==plan.upstreamRevision;
            const advances=plan.scope==='full' && !superseded && !sourceChanged && allSucceeded && coversCurrent && currentSource;
            const previous=this.config(run.generation,'deploy:'+run.template).value ?? {mode:'latest'};
            if (!previous || typeof previous!=='object' || Array.isArray(previous) || !['latest','fixed'].includes(previous.mode) || (previous.pendingTargets!==undefined && (!Array.isArray(previous.pendingTargets) || previous.pendingTargets.some((v:unknown)=>typeof v!=='string')))) conflict();
            let next:any=previous;
            if (advances) next={...previous,mode:plan.mode,sourceIdentity:plan.sourceIdentity,currentSha:plan.sha,currentCustomSha:plan.customSha,currentDigest:plan.sourceDigest,deployTime:time,lastAttempt:time,lastTaskId:task,pendingTargets:[],pendingSha:null,pendingCustomSha:null,pendingDigest:null,pendingSourceIdentity:null,commitDate:null};
            else if (!cancelled && !superseded && !sourceChanged && plan.scope==='full') {
                const failed=new Set(outcomes.filter(o=>!o.success).map(o=>o.key));
                const pending=currentKeys.filter(k=>failed.has(k) || versions.get(k)!==identity);
                next={...previous,mode:plan.mode,lastAttempt:time,lastTaskId:task,pendingTargets:pending,pendingSha:plan.sha,pendingCustomSha:plan.customSha,pendingDigest:plan.sourceDigest,pendingSourceIdentity:plan.sourceIdentity};
            } else if (!cancelled && !superseded && !sourceChanged && plan.scope==='partial') {
                const hasPendingSource=previous.pendingSha!=null || previous.pendingCustomSha!=null || previous.pendingDigest!=null;
                const desiredSha=(hasPendingSource?previous.pendingSha:previous.currentSha) ?? null, desiredCustom=(hasPendingSource?previous.pendingCustomSha:previous.currentCustomSha) ?? null;
                const desiredSource=(hasPendingSource?previous.pendingSourceIdentity:previous.sourceIdentity) ?? '', desiredDigest=hasPendingSource?previous.pendingDigest:previous.currentDigest;
                const matches=plan.sha===desiredSha && plan.customSha===desiredCustom && plan.sourceIdentity===desiredSource && (!desiredDigest || desiredDigest===plan.sourceDigest);
                const pending=new Set<string>(previous.pendingTargets ?? []);
                for (const outcome of outcomes) { if (!outcome.success) pending.add(outcome.key); else if (matches) pending.delete(outcome.key); }
                next={...previous,lastAttempt:time,lastTaskId:task,pendingTargets:[...pending].filter(k=>currentKeys.includes(k)).sort(),pendingSha:desiredSha};
            }
            this.write(run.generation,'deploy:'+run.template,next);
            const anyVerified=outcomes.some(o=>o.verified), anyFailed=outcomes.some(o=>o.failed);
            const status=allSucceeded?'succeeded':anyFailed?(anyVerified?'partial_failed':'failed'):(anyVerified?'partial_cancelled':'cancelled');
            const journal=this.config(run.generation,'deployJournal').value ?? []; if (!Array.isArray(journal)) conflict();
            const entry={time,type:run.template,sha:plan.sha,...(plan.customSha?{customSha:plan.customSha}:{}),taskId:task,accounts:succeeded.length,total:outcomes.length,summary:status+'; scope='+plan.scope+'; ledger='+(advances?'advanced':superseded?'superseded':sourceChanged?'source_changed':'retained'),...(!allSucceeded?{failed:outcomes.filter(o=>!o.success).map(o=>o.key).slice(0,100)}:{})};
            this.write(run.generation,'deployJournal',[entry,...journal].slice(0,100));
            this.db.rows('UPDATE deployment_runs SET finished=?,status=?,result=? WHERE seq=?',finished,status,encoded({advanced:advances,superseded,sourceChanged,coversCurrent,currentSource,outcomes}),run.seq);
        }
    }
    inspectTask(task: string): Json {
        identifier(task);
        return this.db.rows<Run & {result:string|null}>('SELECT * FROM deployment_runs WHERE task=? ORDER BY seq',task).map(r=>({template:r.template,scope:r.scope,status:r.status,started:r.started,finished:r.finished,result:r.result?JSON.parse(r.result):null}));
    }
}
