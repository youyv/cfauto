import {copyPreparedTask} from './prepared-task-copy';
import {readAdjudicationFact} from './adjudication-fact';
import {UnknownAdjudication} from './unknown-adjudication';
import {AccountArchive} from './account-archive';
import {authorityAccounts} from './authority-accounts';
import {UnknownObservation,parseObservationRequest,type ObservationRequest} from './unknown-observation';
import {maintenanceCommand,type MaintenanceMessage} from './maintenance-protocol';
import { AccountDrain } from './account-drain';
import { BusinessEffects, type BusinessStepFact } from './business-effects';
import { AccountQueue } from './account-queue';
import { AccountRunner, type RunnerOptions, type RunnerSnapshot } from './account-runner';
import { ConfigStore, type SqlDatabase } from './config-store';
import { CredentialAuthority, type CredentialPermit } from './credential-authority';
import { SealedStore } from './sealed-store';
import { TaskDispatch, dispatchOnce, type TaskDelivery, type TerminalTaskState } from './task-dispatch';
import { TaskPreparation, type PreparedTaskInput } from './task-preparation';
import { canonical, sha256, identifier, revision, ReliabilityError, type Json } from './protocol';
import type { RpcMessage, RpcMethod } from './coordinator-rpc';

export interface CoordinatedOperation extends RunnerSnapshot { credentialRevision: number }
export interface CoordinatedDelivery extends TaskDelivery { generation: string; credentialRevision: number; cancelRequested?: boolean }
export type RpcSend = (method: RpcMethod, account: string, body: Json) => Promise<Json>;
export interface Wakeup {
    /** Admission must exclude alarms until the callback finishes (DO blockConcurrencyWhile).
     * Callback may await local crypto/storage, never another DO or an external fetch. */
    admit: <T>(callback: () => Promise<T>) => Promise<T>;
    arm: (delayMs: number) => Promise<void>;
}
const terminal = new Set<string>(['succeeded', 'failed', 'partial_failed', 'cancelled', 'partial_cancelled']);
function invalid(): never { throw new ReliabilityError('INVALID', 400); }
function conflict(): never { throw new ReliabilityError('CONFLICT', 409); }
function json(value: unknown): Json { return JSON.parse(canonical(value)) as Json; }
function permit(input: unknown, account: string): CredentialPermit {
    const value = json(input) as unknown as CredentialPermit;
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'account,credentialRevision,generation,snapshot,task,token') invalid();
    identifier(value.generation); identifier(value.task); identifier(value.account); identifier(value.token); identifier(value.snapshot); revision(value.credentialRevision);
    if (!value.credentialRevision || value.account !== account) conflict();
    return value;
}
function deliveryPermit(value: CoordinatedDelivery): CredentialPermit {
    return { task: value.task, account: value.account, token: value.token, snapshot: value.snapshot, generation: value.generation, credentialRevision: value.credentialRevision };
}
/** Persistent retry budget for delivery/receipt failures and process crashes. A pass
 * reserves the next wake BEFORE doing async work. Eight failures park, never release a
 * permit. Explicit trusted wake/admission can retry; there is no timeout-based unlock. */
export class DurableWakeup {
    constructor(private readonly db: SqlDatabase, private readonly wakeup: Wakeup) {
        db.rows('CREATE TABLE IF NOT EXISTS coordinator_alarm (id INTEGER PRIMARY KEY CHECK(id=1), failures INTEGER NOT NULL)');
        db.rows('INSERT OR IGNORE INTO coordinator_alarm VALUES (1,0)');
    }
    async wake(): Promise<void> { await this.wakeup.arm(100); this.db.rows('UPDATE coordinator_alarm SET failures=0 WHERE id=1'); }
    async beforePass(): Promise<boolean> {
        const failures = this.db.rows<{ failures: number }>('SELECT failures FROM coordinator_alarm WHERE id=1')[0].failures;
        if (failures >= 8) return false;
        await this.wakeup.arm(Math.min(300_000, 1000 * 2 ** failures));
        this.db.rows('UPDATE coordinator_alarm SET failures=failures+1 WHERE id=1');
        return true;
    }
    succeeded(): void { this.db.rows('UPDATE coordinator_alarm SET failures=0 WHERE id=1'); }
}

/** Global role only. Stores share one global DB; no account queue is created here.
 * Authenticated binding RPC is the only receiver; business admission remains a trusted
 * planner call, not an arbitrary browser-provided PreparedTaskInput endpoint. */
export class GlobalCoordinatorRuntime {
    private readonly effects: BusinessEffects | undefined;
    private readonly retry: DurableWakeup;
    private running: Promise<void> | undefined;
    constructor(private readonly db: SqlDatabase, private readonly config: ConfigStore, private readonly sealed: SealedStore, private readonly dispatch: TaskDispatch, private readonly authority: CredentialAuthority, private readonly preparation: TaskPreparation, private readonly send: RpcSend, private readonly wakeup: Wakeup, businessEffects = false, private readonly reviewAuthority?: (operator:string)=>void,private readonly archiveIntent?:(message:MaintenanceMessage)=>Promise<string>,private readonly adjudicationIntent?:(message:MaintenanceMessage)=>Promise<string>) {
        this.effects = businessEffects ? new BusinessEffects(db) : undefined;
        this.retry = new DurableWakeup(db, wakeup);
    }
    async submit(input: PreparedTaskInput, admissionGuard?: () => void): Promise<{ id: string; duplicate: boolean }> {
        const frozen = copyPreparedTask(input);
        return this.wakeup.admit(async () => { await this.retry.wake(); return this.preparation.submit(frozen, admissionGuard); });
    }
    async requestWake(task: string): Promise<void> {
        identifier(task);
        await this.wakeup.admit(async () => {
            if (this.config.status().maintenance) throw new ReliabilityError('MAINTENANCE',503);
            await this.retry.wake();
            if (this.config.status().maintenance) throw new ReliabilityError('MAINTENANCE',503);
            this.dispatch.requestWake(task);
        });
    }
    async requestCancel(task: string): Promise<void> {
        identifier(task);
        await this.wakeup.admit(async () => { await this.retry.wake(); this.dispatch.requestCancel(task); });
    }
    private async snapshot(value: CredentialPermit, steps?: string[]): Promise<CoordinatedOperation> {
        const stored = await this.sealed.get({ id: value.snapshot, kind: 'task_snapshot', account: value.account, generation: value.generation });
        if (!stored || Array.isArray(stored) || typeof stored !== 'object' || stored.schema !== 1 || stored.account !== value.account || stored.generation !== value.generation || !Array.isArray(stored.steps) || (steps && canonical(stored.steps) !== canonical(steps))) conflict();
        const operation = stored.operation as unknown as CoordinatedOperation;
        if (!operation || typeof operation !== 'object' || operation.credentialRevision !== value.credentialRevision || !operation.input || !Object.hasOwn(operation, 'operation')) conflict();
        // Authorization occurs AFTER decryption. A revoked/replaced credential or permit
        // cannot pass because it was valid before a WebCrypto await.
        return operation;
    }
    private async delivery(value: TaskDelivery, forCancellation = false): Promise<CoordinatedDelivery> {
        const row = this.db.rows<{ generation: string }>('SELECT generation FROM sealed_objects WHERE id=? AND account=? AND kind=?', value.snapshot, value.account, 'task_snapshot')[0];
        if (!row) conflict();
        const stored = await this.sealed.get({ id: value.snapshot, account: value.account, generation: row.generation, kind: 'task_snapshot' });
        const operation = (stored as Record<string, Json>)?.operation as unknown as CoordinatedOperation;
        if (!operation) conflict();
        const result: CoordinatedDelivery = { ...value, generation: row.generation, credentialRevision: operation.credentialRevision, ...(this.dispatch.cancelRequested(value.task,value.account) ? {cancelRequested:true} : {}) };
        permit(deliveryPermit(result), value.account);
        await this.snapshot(deliveryPermit(result), value.steps);
        // No external work yet. Revoked jobs must still arrive and retain their permit;
        // the account runner turns refused authorization into needs_review.
        if (!forCancellation && this.config.status().maintenance) throw new ReliabilityError('MAINTENANCE', 503);
        this.dispatch.assertPermit(value.task, value.account, value.token, value.snapshot);
        return result;
    }
    /** A normal internal RPC signature is NOT a maintenance review grant. Bind every
     * external read to the independently authenticated, durable global command intent.
     * No account caller can create that receipt or choose another operator/target. */
    private reviewGrant(r:ObservationRequest):void {
        const denied=():never=>{throw new ReliabilityError('INVALID',403);};
        if(!this.reviewAuthority)denied();this.reviewAuthority!(r.operator);
        if(!this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='maintenance_receipts'").length)denied();
        const receipt=this.db.rows<{operator:string;intent:string;state:string}>('SELECT operator,intent,state FROM maintenance_receipts WHERE id=?',r.id)[0];
        if(!receipt||receipt.operator!==r.operator||!['pending','complete'].includes(receipt.state))denied();
        const intent=JSON.parse(receipt.intent),command=intent?.command;
        if(intent.operator!==r.operator||command?.id!==r.id||command.action!=='review_observe'||command.expected===null)denied();
        if(canonical(command.args)!==canonical({task:r.permit.task,account:r.permit.account,step:r.step,call:r.call}))denied();
        if(command.expected.generation!==r.permit.generation||command.expected.epoch!==r.epoch||canonical(command.expected)!==canonical({...this.config.status()}))conflict();
    }
    private async adjudicationGrant(raw:MaintenanceMessage):Promise<MaintenanceMessage>{
        const message=json(raw) as unknown as MaintenanceMessage;if(!message||Object.keys(message).sort().join(',')!=='at,command,nonce,operator,target,version'||message.version!==1||!this.adjudicationIntent)throw new ReliabilityError('INVALID',403);message.command=maintenanceCommand(message.command);if(!['review_candidates','review_attest','review_close_failed'].includes(message.command.action))invalid();
        const intent=await this.adjudicationIntent(message);if(!this.db.rows("SELECT name FROM sqlite_master WHERE name='maintenance_receipts' AND type='table'").length)throw new ReliabilityError('INVALID',403);const row=this.db.rows<{intent:string;operator:string;state:string}>('SELECT intent,operator,state FROM maintenance_receipts WHERE id=?',message.command.id)[0];if(!row||row.intent!==intent||row.operator!==message.operator||!['pending','complete'].includes(row.state))throw new ReliabilityError('INVALID',403);return message;
    }
    private async adjudicationObservation(message:MaintenanceMessage):Promise<ObservationRequest>{
        const args=message.command.args as Record<string,any>;let observation=args.observation;
        if(message.command.action==='review_close_failed'){const att=this.db.rows<{state:string;intent:string;result:string|null}>('SELECT state,intent,result FROM maintenance_receipts WHERE id=?',args.attestation)[0];if(!att||att.state!=='complete'||att.result===null)conflict();const intent=JSON.parse(att.intent),result=JSON.parse(att.result);if(intent.command.action!=='review_attest'||result.proof!==args.proof||result.operator===message.operator)conflict();for(const key of ['task','account','step','call'])if(intent.command.args[key]!==args[key])conflict();observation=intent.command.args.observation;}
        identifier(observation);const source=this.db.rows<{operator:string;state:string;intent:string;result:string|null}>('SELECT operator,state,intent,result FROM maintenance_receipts WHERE id=?',observation)[0];if(!source||source.state!=='complete'||source.result===null)conflict();const original=JSON.parse(source.intent),result=JSON.parse(source.result);if(original.command.action!=='review_observe'||result.state!=='observed')conflict();for(const key of ['task','account','step','call'])if(original.command.args[key]!==args[key]||result[key]!==args[key])conflict();
        const row=this.db.rows<Record<string,any>>('SELECT * FROM dispatch_outbox WHERE task=? AND account=?',args.task,args.account)[0];if(!row||typeof row.token!=='string')conflict();const stored=await this.sealed.get({id:row.snapshot,account:args.account,generation:result.generation,kind:'task_snapshot'}) as any;const value={task:args.task,account:args.account,token:row.token,snapshot:row.snapshot,generation:result.generation,credentialRevision:stored.operation?.credentialRevision};await this.snapshot(value,JSON.parse(row.steps));
        return parseObservationRequest({id:observation,operator:source.operator,permit:value,epoch:result.epoch,accountsRevision:result.accountsRevision,step:args.step,call:args.call});
    }
    async adjudicate(raw:MaintenanceMessage):Promise<Json>{const message=await this.adjudicationGrant(raw);if(message.command.action==='review_candidates'){const args=message.command.args as {task:string;account:string};if(!this.db.rows('SELECT task FROM dispatch_outbox WHERE task=? AND account=?',args.task,args.account).length)conflict();return this.send('adjudicate',args.account,json({message,observation:null}));}const observation=await this.adjudicationObservation(message);return this.send('adjudicate',observation.permit.account,json({message,observation}));}
    private async archiveGrant(raw:MaintenanceMessage):Promise<MaintenanceMessage>{
        const message=json(raw) as unknown as MaintenanceMessage;
        if(!message||Object.keys(message).sort().join(',')!=='at,command,nonce,operator,target,version'||message.version!==1)throw new ReliabilityError('INVALID',403);
        identifier(message.operator);identifier(message.nonce);revision(message.at);message.command=maintenanceCommand(message.command);
        if(!['account_archive','archive_accounts'].includes(message.command.action)||!this.archiveIntent)throw new ReliabilityError('INVALID',403);
        const intent=await this.archiveIntent(message);
        if(!this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='maintenance_receipts'").length)throw new ReliabilityError('INVALID',403);
        const row=this.db.rows<{intent:string;operator:string;state:string}>('SELECT intent,operator,state FROM maintenance_receipts WHERE id=?',message.command.id)[0];
        if(!row||row.intent!==intent||row.operator!==message.operator||!['pending','complete'].includes(row.state))throw new ReliabilityError('INVALID',403);
        if(message.command.expected!==null&&canonical(message.command.expected)!==canonical({...this.config.status()}))conflict();return message;
    }
    private archiveAccounts():string[]{
        this.db.rows('CREATE TABLE IF NOT EXISTS account_archive_registry (account TEXT PRIMARY KEY)');
        return authorityAccounts(this.db,this.config.status().generation!);
    }
    async archiveMaintenance(raw:MaintenanceMessage):Promise<Json>{
        const message=await this.archiveGrant(raw),args=message.command.args as Record<string,any>,accounts=this.archiveAccounts();
        if(message.command.action==='archive_accounts'){const digest=await sha256(canonical(accounts));if(args.digest!==null&&args.digest!==digest)conflict();await this.archiveGrant(message);if(canonical(this.archiveAccounts())!==canonical(accounts))conflict();const remaining=accounts.filter(a=>args.after===null||a>args.after),items=remaining.slice(0,args.limit);return {items,digest,after:remaining.length>args.limit?items.at(-1)!:null,scope:'directory_dispatch_and_retained_archive_accounts'};}
        if(!accounts.includes(args.account))throw new ReliabilityError('NOT_READY',404);
        this.db.rows('INSERT OR IGNORE INTO account_archive_registry VALUES (?)',args.account);
        const result=await this.send('account_archive',args.account,json({message}));await this.archiveGrant(message);return result;
    }
    /** Trusted maintenance call only: the independently authenticated operator cannot
     * choose a token/snapshot or submit an arbitrary executor/URL. */
    async observeUnknown(message:MaintenanceMessage):Promise<Json> {
        const command=message.command,args=command.args as {task:string;account:string;step:number;call:number};
        if(command.action!=='review_observe'||command.expected===null)invalid();
        const view=this.config.read(['accounts']);
        if(canonical({...this.config.status()})!==canonical(command.expected))conflict();
        const row=this.db.rows<Record<string,any>>('SELECT task,account,snapshot,steps,digest,token FROM dispatch_outbox WHERE task=? AND account=?',args.task,args.account)[0];
        if(!row||typeof row.token!=='string')conflict();
        const delivery=await this.delivery({...row,steps:JSON.parse(row.steps)} as TaskDelivery,true),value=deliveryPermit(delivery);
        const request:ObservationRequest={id:command.id,operator:message.operator,permit:value,epoch:view.epoch,accountsRevision:view.records[0].revision,step:args.step,call:args.call};
        this.reviewGrant(request);
        this.authority.authorizeReview(value,request.epoch,request.accountsRevision);
        if(canonical({...this.config.status()})!==canonical(command.expected))conflict();
        const result=await this.send('review_observe',args.account,json(request));
        this.authority.authorizeReview(value,request.epoch,request.accountsRevision);
        if(canonical({...this.config.status()})!==canonical(command.expected))conflict();
        return result;
    }
    async handle(message: RpcMessage): Promise<Json> {
        if (message.direction !== 'account-global') invalid();
        if (message.method === 'authorize_adjudication') {
            const body=message.body as any;if(!body||Object.keys(body).sort().join(',')!=='message,observation,phase'||!['receipt','fresh','replay'].includes(body.phase))invalid();const grant=await this.adjudicationGrant(body.message);if(grant.command.action==='review_candidates'){const args=grant.command.args as {task:string;account:string};if(body.observation!==null||body.phase!=='receipt'||args.account!==message.account||!this.db.rows('SELECT task FROM dispatch_outbox WHERE task=? AND account=?',args.task,args.account).length)throw new ReliabilityError('INVALID',403);return {authorizedCandidates:true};}const r=await this.adjudicationObservation(grant);if(r.permit.account!==message.account||canonical(r)!==canonical(body.observation))throw new ReliabilityError('INVALID',403);
            if(body.phase==='replay'&&grant.command.action!=='review_close_failed')invalid();if(body.phase==='fresh'){if(canonical(grant.command.expected)!==canonical({...this.config.status()}))conflict();this.authority.authorizeReview(r.permit,r.epoch,r.accountsRevision);}return {authorizedAdjudication:true};
        }
        if (message.method === 'authorize_account_archive') {
            const body=message.body as {message:Json};if(!body||Object.keys(body).join(',')!=='message')invalid();const grant=await this.archiveGrant(body.message as unknown as MaintenanceMessage);
            if(grant.command.action!=='account_archive'||(grant.command.args as {account:string}).account!==message.account||!this.archiveAccounts().includes(message.account))throw new ReliabilityError('INVALID',403);
            return {authorizedArchive:true};
        }
        if (message.method === 'authorize_review') {
            const body=message.body as unknown as {request:ObservationRequest};
            if(!body||typeof body!=='object'||Object.keys(body).join(',')!=='request')invalid();
            const request=parseObservationRequest(body.request),value=permit(json(request.permit),message.account);
            this.reviewGrant(request);await this.snapshot(value);this.reviewGrant(request);
            this.authority.authorizeReview(value,request.epoch,request.accountsRevision);return {authorizedReadOnly:true};
        }
        if (message.method === 'authorize' || message.method === 'snapshot') {
            const value = permit(message.body, message.account);
            const snapshot = await this.snapshot(value);
            this.authority.authorize(value);
            return message.method === 'snapshot' ? json(snapshot) : { authorized: true };
        }
        if (message.method === 'progress') {
            if (!this.effects) invalid();
            const body = message.body as { permit: Json; facts: Json };
            if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'facts,permit') invalid();
            const value = permit(body.permit, message.account), snapshot = await this.snapshot(value);
            this.effects.apply(value, snapshot.operation, body.facts);
            return { acknowledged: true };
        }
        if (message.method === 'complete') {
            const body = message.body as { permit: Json; outcome: TerminalTaskState; evidence: string };
            if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'evidence,outcome,permit') invalid();
            const value = permit(body.permit, message.account);
            const delivery = this.db.rows<{ snapshot: string; token: string }>('SELECT snapshot,token FROM dispatch_outbox WHERE task=? AND account=?', value.task, value.account)[0];
            if (!delivery || delivery.snapshot !== value.snapshot || delivery.token !== value.token) conflict();
            const snapshot = await this.snapshot(value); // Including on duplicate/revoked/maintenance receipts.
            // Schedule before the transaction. No network call inside the admission gate.
            await this.wakeup.admit(async () => {
                await this.retry.wake();
                if (this.effects) {
                    const operation = snapshot.operation as { commands: Json[] };
                    this.effects.assertComplete(value.task, value.account, operation.commands.length, body.outcome);
                }
                this.dispatch.complete(value.task, value.account, value.token, body.outcome, body.evidence);
            });
            return { acknowledged: true };
        }
        invalid();
    }
    tick(): Promise<void> {
        if (this.running) return this.running;
        this.running = this.pass().finally(() => { this.running = undefined; }); return this.running;
    }
    private async pass(): Promise<void> {
        // Maintenance is a hard stop for new deliveries, NOT proof of drain. Existing
        // terminal receipts are accepted; outstanding permits remain visible for migration.
        const count = this.db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM dispatch_outbox WHERE state IN ('sending','accepted')")[0].n;
        const pending = !this.config.status().maintenance && this.db.rows("SELECT p.seq FROM dispatch_outbox p WHERE p.state='sending' OR (p.state='pending' AND ?<3 AND NOT EXISTS (SELECT 1 FROM dispatch_outbox a WHERE a.account=p.account AND a.state IN ('sending','accepted'))) LIMIT 1", count).length > 0;
        const waking = !this.config.status().maintenance && this.dispatch.pendingWakes().length > 0;
        if ((!pending && !waking && !this.dispatch.pendingCancels().length) || !await this.retry.beforePass()) return;
        let retryPending = 0;
        if (!this.config.status().maintenance) {
            const result = await dispatchOnce(this.dispatch, async item => { await this.send('deliver', item.account, json(await this.delivery(item))); });
            retryPending += result.retryPending;
            for (const item of this.dispatch.pendingWakes()) {
                try {
                    const { request, ...delivery } = item;
                    await this.send('deliver',item.account,json(await this.delivery(delivery)));
                    this.dispatch.acknowledgeWake(item.task,item.account,item.token,request);
                } catch { retryPending++; }
            }
        }
        // Cancellation is safe during maintenance; it never authorizes external writes.
        for (const item of this.dispatch.pendingCancels()) {
            try {
                const value = await this.delivery(item, true);
                await this.send('cancel', item.account, json(deliveryPermit(value)));
                this.dispatch.acknowledgeCancel(item.task,item.account,item.token);
            } catch { retryPending++; }
        }
        if (!retryPending) this.retry.succeeded();
    }
}

/** Account role only. Immutable inbox binding and queue commit together. The terminal
 * outbox is rebuilt from durable queue facts after any crash, never from global state. */
export class AccountCoordinatorRuntime {
    private observation: UnknownObservation | undefined;
    private accountArchive: Promise<AccountArchive> | undefined;
    private readonly drain: AccountDrain;
    private readonly retry: DurableWakeup;
    private running: Promise<void> | undefined;
    constructor(private readonly db: SqlDatabase, private readonly queue: AccountQueue, private readonly sealed: SealedStore, private readonly account: string, private readonly send: RpcSend, private readonly wakeup: Wakeup, private readonly options: Pick<RunnerOptions, 'digestSecret' | 'transport' | 'execute'> & { businessEffects?: boolean;archiveInstallation?:()=>Promise<string> }) {
        identifier(account);this.drain=new AccountDrain(db,account);
        if (typeof options.digestSecret !== 'string' || new TextEncoder().encode(options.digestSecret).length < 32) invalid();
        this.options = { ...options }; this.retry = new DurableWakeup(db, wakeup);
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS coordinator_inbox (task TEXT PRIMARY KEY, delivery TEXT NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS coordinator_receipts (task TEXT PRIMARY KEY, payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)');
            db.rows('CREATE TABLE IF NOT EXISTS coordinator_progress (task TEXT PRIMARY KEY, version INTEGER NOT NULL, cancel_requested INTEGER NOT NULL, payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0)');
        });
    }
    async handle(message: RpcMessage): Promise<Json> {
        if (message.direction !== 'global-account' || message.account !== this.account) invalid();
        if (message.method === 'account_archive') {
            const body=message.body as {message:Json};if(!body||Object.keys(body).join(',')!=='message'||!this.options.archiveInstallation)throw new ReliabilityError('INVALID',403);
            if(!this.accountArchive)this.accountArchive=this.options.archiveInstallation().then(installation=>new AccountArchive(this.db,this.sealed,this.account,installation,async request=>{await this.send('authorize_account_archive',this.account,json({message:request}));}));
            return (await this.accountArchive).execute(body.message as unknown as MaintenanceMessage);
        }
        if (message.method === 'adjudicate') {
            const body=json(message.body) as any;if(!body||Object.keys(body).sort().join(',')!=='message,observation')invalid();const command=maintenanceCommand(body.message.command),args=command.args as Record<string,any>;
            if(command.action==='review_candidates'){
                if(body.observation!==null||args.account!==this.account)invalid();await this.send('authorize_adjudication',this.account,json({message:body.message,observation:null,phase:'receipt'}));
                return this.db.transaction(()=>{const inbox=this.db.rows<{delivery:string}>('SELECT delivery FROM coordinator_inbox WHERE task=?',args.task)[0],job=this.db.rows<{state:string}>('SELECT state FROM account_jobs WHERE id=?',args.task)[0];if(!inbox||!job)conflict();const delivery=JSON.parse(inbox.delivery);if(delivery.account!==this.account||delivery.task!==args.task)conflict();const hasJournal=this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_calls'").length>0,steps=this.db.rows<{ordinal:number;kind:string;state:string;evidence:string|null}>("SELECT ordinal,kind,state,evidence FROM account_steps WHERE job=? AND state IN ('unknown','in_flight') ORDER BY ordinal",args.task),items:Array<Record<string,Json>>=[];let missingEvidence=false;
                    for(const step of steps){const calls=hasJournal?this.db.rows<{ordinal:number;state:string;digest:string}>("SELECT ordinal,state,digest FROM execution_calls WHERE job=? AND mutation=1 AND state IN ('unknown','in_flight') ORDER BY ordinal",args.task+'_'+step.ordinal):[];if(!calls.length)missingEvidence=true;for(const call of calls){const position=step.ordinal*500+call.ordinal;if(args.after!==null&&position<=args.after)continue;items.push({position,step:step.ordinal,kind:step.kind,stepState:step.state,evidence:step.evidence,call:call.ordinal,callState:call.state,digest:call.digest,eligibleAtCapture:!this.running&&job.state==='needs_review'&&step.state==='unknown'});}}
                    const page=items.slice(0,args.limit);return {task:args.task,account:this.account,state:job.state,executing:!!this.running,items:page,after:items.length>args.limit?page.at(-1)!.position:null,missingEvidence,settlementProven:false,currentStateGuaranteed:false,observedAt:Date.now(),scope:'read_snapshot'};
                });
            }
            const r=parseObservationRequest(body.observation);if(r.permit.account!==this.account||args.account!==this.account)invalid();
            const authorize=async(phase:string,observation:ObservationRequest)=>{await this.send('authorize_adjudication',this.account,json({message:body.message,observation,phase}));};await authorize('receipt',r);
            const core=new UnknownAdjudication(this.db,this.sealed,this.queue,this.account,{digestSecret:this.options.digestSecret,isExecuting:()=>!!this.running,authorize:async(action,operator,observation,replay)=>{if(operator!==body.message.operator||action!==(command.action==='review_attest'?'attest':'close_failed')||canonical(observation)!==canonical(r))invalid();await authorize(replay?'replay':'fresh',observation);}});
            if(command.action==='review_attest')return core.attest({id:command.id,operator:body.message.operator,observation:r,evidence:args.evidence,statement:args.statement,reference:args.reference,document:args.document});
            if(command.action==='review_close_failed')return core.closeFailed({id:command.id,operator:body.message.operator,attestation:args.attestation,proof:args.proof});invalid();
        }
        if (message.method === 'review_observe') {
            if(!this.observation)this.observation=new UnknownObservation(this.db,this.sealed,this.account,{
                digestSecret:this.options.digestSecret,transport:(url,init)=>this.options.transport(url,init),
                isExecuting:()=>!!this.running,
                authorize:async request=>{await this.send('authorize_review',this.account,json({request}));}
            });
            return this.observation.capture(message.body as unknown as ObservationRequest);
        }
        if (message.method === 'probe_drain') {
            const settlements=[];if(this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='unknown_adjudications'").length){const records=this.db.rows<{job:string;step:number;evidence:string}>('SELECT job,step,evidence FROM unknown_adjudications');if(records.length>10000)conflict();for(const row of records){const value=await readAdjudicationFact(this.db,this.sealed,this.account,row.job,row.step,row.evidence);if(!value)conflict();settlements.push(value);}}
            return json(this.drain.probe(message.body,!!this.running,!!this.options.businessEffects,settlements));
        }
        if (message.method === 'release_drain') return this.drain.release(message.body);
        if (message.method === 'cancel') {
            const value = permit(message.body,this.account);
            if (canonical(value) !== canonical(deliveryPermit(this.delivery(value.task)))) conflict();
            return this.wakeup.admit(async () => { await this.retry.wake(); this.drain.assertDelivery(value.generation); this.queue.cancel(value.task); return { acknowledged:true }; });
        }
        if (message.method !== 'deliver') invalid();
        const raw = json(message.body) as unknown as CoordinatedDelivery;
        if (!raw || typeof raw !== 'object' || (Object.hasOwn(raw,'cancelRequested') && typeof raw.cancelRequested !== 'boolean')) invalid();
        // Cancellation is monotone control state, not part of immutable inbox identity.
        const { cancelRequested = false, ...value } = raw;
        if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'account,credentialRevision,digest,generation,snapshot,steps,task,token') invalid();
        permit(deliveryPermit(value), this.account);
        return this.wakeup.admit(async () => {
            await this.retry.wake();
            return json(this.queue.enqueue(value.task, value.digest, value.snapshot, value.steps, () => {
                this.drain.assertDelivery(value.generation);
                const payload = canonical(value), old = this.db.rows<{ delivery: string }>('SELECT delivery FROM coordinator_inbox WHERE task=?', value.task)[0];
                if (old && old.delivery !== payload) conflict();
                if (!old) this.db.rows('INSERT INTO coordinator_inbox VALUES (?,?)', value.task, payload);
            }, cancelRequested));
        });
    }
    private delivery(task: string): CoordinatedDelivery {
        const row = this.db.rows<{ delivery: string }>('SELECT delivery FROM coordinator_inbox WHERE task=?', task)[0];
        if (!row) conflict(); return JSON.parse(row.delivery) as CoordinatedDelivery;
    }
    private progressChanges(): { id: string; version: number; cancel_requested: number }[] {
        if (!this.options.businessEffects) return [];
        return this.db.rows("SELECT j.id,j.cancel_requested,(SELECT COALESCE(MAX(seq),0) FROM account_receipts WHERE job=j.id) AS version FROM account_jobs j JOIN coordinator_inbox i ON i.task=j.id LEFT JOIN coordinator_progress p ON p.task=j.id WHERE p.task IS NULL OR p.version!=(SELECT COALESCE(MAX(seq),0) FROM account_receipts WHERE job=j.id) OR p.cancel_requested!=j.cancel_requested ORDER BY j.seq LIMIT 3");
    }
    private async saveProgress(): Promise<void> {
        for (const row of this.progressChanges()) {
            const delivery = this.delivery(row.id), state = this.queue.inspect(row.id), facts: BusinessStepFact[] = [];
            for (const step of state.steps) {
                if (!['verified','failed','unknown','skipped'].includes(step.state)) continue;
                let result: Json = null;
                if (step.state === 'verified' || step.state === 'failed') {
                    const manual=step.state==='failed'?await readAdjudicationFact(this.db,this.sealed,this.account,row.id,step.ordinal,step.evidence):null;
                    if(manual)result=manual.fact;else{
                    const saved = await this.sealed.get({ id: 'result_' + row.id + '_' + step.ordinal, kind: 'task_snapshot', account: this.account, generation: delivery.generation }) as { outcome: string; result: Json };
                    if (saved.outcome !== step.state) conflict();
                    result = saved.result;
                    }
                }
                facts.push({ ordinal: step.ordinal, kind: step.kind, state: step.state as BusinessStepFact['state'], evidence: step.evidence, result });
            }
            const payload = canonical({ permit: deliveryPermit(delivery), facts });
            // Persist before send. After a crash this is reconstructible from queue and
            // sealed results; unknown never becomes a reason to repeat external writes.
            this.db.rows('INSERT INTO coordinator_progress VALUES (?,?,?,?,?) ON CONFLICT(task) DO UPDATE SET version=excluded.version,cancel_requested=excluded.cancel_requested,payload=excluded.payload,acknowledged=excluded.acknowledged',row.id,row.version,row.cancel_requested,payload,facts.length ? 0 : 1);
        }
    }
    private async sendProgress(): Promise<boolean> {
        if (!this.options.businessEffects) return true;
        await this.saveProgress();
        for (const row of this.db.rows<{ task: string; payload: string }>('SELECT task,payload FROM coordinator_progress WHERE acknowledged=0 LIMIT 3')) {
            try { await this.send('progress',this.account,JSON.parse(row.payload)); } catch { return false; }
            this.db.rows('UPDATE coordinator_progress SET acknowledged=1 WHERE task=? AND payload=?',row.task,row.payload);
        }
        return true;
    }
    private async saveReceipts(): Promise<void> {
        const rows = this.db.rows<{ id: string }>("SELECT j.id FROM account_jobs j JOIN coordinator_inbox i ON i.task=j.id LEFT JOIN coordinator_receipts r ON r.task=j.id WHERE r.task IS NULL AND j.state IN ('succeeded','failed','partial_failed','cancelled','partial_cancelled') ORDER BY j.seq LIMIT 3");
        for (const row of rows) {
            const inspected = this.queue.inspect(row.id);
            const state = { ...inspected, steps: inspected.steps.map(step => ({ ...step })) };
            if (!terminal.has(state.state)) conflict();
            const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.options.digestSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical(['cfauto-account-terminal-v1', row.id, state])));
            const evidence = Array.from(new Uint8Array(signed), b => b.toString(16).padStart(2, '0')).join('');
            const payload = canonical({ permit: deliveryPermit(this.delivery(row.id)), outcome: state.state, evidence });
            this.db.rows('INSERT OR IGNORE INTO coordinator_receipts(task,payload) VALUES (?,?)', row.id, payload);
        }
    }
    tick(): Promise<void> {
        if (this.running) return this.running;
        this.running = this.pass().finally(() => { this.running = undefined; }); return this.running;
    }
    private async pass(): Promise<void> {
        // A pre-mutation unknown (no journaled mutation call for the step) is settled by
        // the account runner as a definite failure, so it must be treated as work even
        // though its job sits in needs_review. Unknowns WITH a journaled mutation are
        // still blocked here and require operator adjudication.
        const healable = this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_calls'").length
            ? this.db.rows<{ id: string }>("SELECT s.job AS id FROM account_steps s WHERE s.state='unknown' AND NOT EXISTS (SELECT 1 FROM execution_calls c WHERE c.job=s.job||'_'||s.ordinal AND c.mutation=1) LIMIT 1")
            : [];
        const work = this.db.rows<{ id: string }>("SELECT j.id FROM account_jobs j JOIN coordinator_inbox i ON i.task=j.id LEFT JOIN coordinator_receipts r ON r.task=j.id WHERE j.state IN ('queued','running') OR (j.state IN ('succeeded','failed','partial_failed','cancelled','partial_cancelled') AND (r.task IS NULL OR r.acknowledged=0)) ORDER BY j.seq LIMIT 1");
        const progressPending = this.options.businessEffects && (this.progressChanges().length || this.db.rows('SELECT task FROM coordinator_progress WHERE acknowledged=0 LIMIT 1').length);
        if ((!work.length && !progressPending && !healable.length) || !await this.retry.beforePass()) return;
        if (!await this.sendProgress()) return;
        await this.saveReceipts();
        const unsent = this.db.rows<{ task: string; payload: string }>('SELECT task,payload FROM coordinator_receipts WHERE acknowledged=0 LIMIT 3');
        for (const row of unsent) {
            try { await this.send('complete', this.account, JSON.parse(row.payload)); }
            catch { return; } // Retry only the receipt, not execution.
            this.db.rows('UPDATE coordinator_receipts SET acknowledged=1 WHERE task=?', row.task);
        }
        const unresolved = this.queue.unresolved();
        if (unresolved.some(s => s.state === 'unknown') && !healable.length) return;
        const active = unresolved[0]?.job ?? this.db.rows<{ id: string }>("SELECT id FROM account_jobs WHERE state IN ('queued','running') ORDER BY seq LIMIT 1")[0]?.id ?? healable[0]?.id;
        if (active) {
            const delivery = this.delivery(active), auth = json(deliveryPermit(delivery));
            const runner = new AccountRunner(this.db, this.queue, this.sealed, { ...this.options, account: this.account, generation: delivery.generation,
                authorize: async job => {
                    if (job !== active || this.queue.inspect(job).cancelRequested) conflict();
                    await this.send('authorize', this.account, auth);
                    if (this.queue.inspect(job).cancelRequested) conflict();
                },
                loadSnapshot: async (snapshot, job) => {
                    if (job !== active || snapshot !== delivery.snapshot) conflict();
                    const context = { id: snapshot, account: this.account, generation: delivery.generation, kind: 'task_snapshot' as const };
                    // Cached plaintext is never persisted. Authorization is refreshed by
                    // AccountRunner before loading and before every actual HTTP mutation.
                    try { return await this.sealed.get(context) as unknown as RunnerSnapshot; }
                    catch (error) { if (!(error instanceof ReliabilityError) || error.code !== 'NOT_READY') throw error; }
                    const frozen = await this.send('snapshot', this.account, auth);
                    await this.sealed.put(context, frozen);
                    return await this.sealed.get(context) as unknown as RunnerSnapshot;
                }
            });
            await runner.tick();
        }
        if (!await this.sendProgress()) return;
        await this.saveReceipts(); // Crash before this point is repaired on the next pass.
        this.retry.succeeded();
    }
}
