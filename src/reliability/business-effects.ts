import { DeploymentLedger } from './deployment-ledger';
import { SCRIPT_COMMANDS } from './deployment-plan';
import { TEMPLATES } from '../config/templates';
import { artifactIdentity } from './source-artifact';
import type { SqlDatabase } from './config-store';
import type { CredentialPermit } from './credential-authority';
import { accountId, parseBusinessOperation, shape, invalid, type BusinessCommand } from './business-command';
import { canonical, encoded, identifier, ReliabilityError, type Json } from './protocol';
import type { AccountEntry } from '../lib/types';

export interface BusinessStepFact { ordinal: number; kind: string; state: 'verified' | 'failed' | 'unknown' | 'skipped'; evidence: string | null; result: Json }
function conflict(): never { throw new ReliabilityError('CONFLICT', 409); }
function project(command: BusinessCommand, fact: BusinessStepFact): Json {
    const result = fact.result as Record<string, Json>;
    if (fact.state === 'unknown' || fact.state === 'skipped') { if (fact.result !== null) invalid(); return null; }
    if (fact.state === 'failed') {
        if(result?.code==='OPERATOR_CLOSED_UNCONFIRMED'){shape(result,'kind,code,adjudication');if(result.kind!==command.kind||typeof result.adjudication!=='string')invalid();identifier(result.adjudication as string);return result;}
        shape(result, 'kind,code');
        // PROVIDER_STATE_ABSENT: the provider positively reported the pre-mutation
        // resource absent, so no write was attempted. NO_MUTATION_RECORDED: the account
        // journal proves no mutation call was ever issued for the unknown step.
        // ROTATION_NOT_APPLIED: the subdomain replacement was refused or did not hold and
        // the provider's own readback confirms the previous name is in place again.
        if (result.kind !== command.kind || !['PROVIDER_REJECTED','RESOURCE_CONFLICT','PROVIDER_STATE_ABSENT','NO_MUTATION_RECORDED','ROTATION_NOT_APPLIED'].includes(result.code as string)) invalid();
        return { kind: command.kind, code: result.code };
    }
    if(command.kind==='cleanup_kv') {
        shape(result,'kind,worker,namespace,disposition');
        if(result.kind!==command.kind || result.worker!==command.worker || result.namespace!==command.namespace || !['deleted','retained_shared'].includes(result.disposition as string)) invalid();
        return result;
    }
    if (command.kind === 'repair_worker') {
        shape(result,'kind,worker,commit,scriptVerified,bindingsVerified,domainsVerified,subdomainVerified');
        if (result.kind!==command.kind || result.worker!==command.worker || result.commit!==command.artifact.commit || result.scriptVerified!==true || result.bindingsVerified!==true || result.domainsVerified!==true || result.subdomainVerified!==true) invalid();
        return result;
    }
    if (command.kind === 'manual_upload') {
        shape(result,'kind,worker,source,scriptVerified,bindingsVerified');
        if (result.kind!==command.kind || result.worker!==command.worker || result.scriptVerified!==true || result.bindingsVerified!==true || canonical(result.source)!==canonical(artifactIdentity(command.artifact))) invalid();
        return result;
    }
    if (command.kind === 'upload' || command.kind === 'create_worker' || command.kind === 'replace_worker') {
        shape(result, command.kind === 'upload' ? 'kind,worker,commit,scriptVerified,bindingsAccepted' : 'kind,worker,commit,scriptVerified,bindingsAccepted,namespace,bindingsVerified');
        if (result.kind !== command.kind || result.worker !== command.worker || result.commit !== command.artifact.commit || result.scriptVerified !== true || result.bindingsAccepted !== true) invalid();
        if (command.kind !== 'upload') {
            if (result.bindingsVerified !== true || (command.namespaceTitle ? !result.namespace : result.namespace !== '')) invalid();
            if (result.namespace) accountId(result.namespace);
        }
        return result;
    }
    shape(result, 'kind,confirmed' + ('worker' in command ? ',worker' : ''));
    if (result.kind !== command.kind || result.confirmed !== true || ('worker' in command && result.worker !== command.worker)) invalid();
    return result;
}
/** Trusted global-only fact consumer, on the SAME SQLite DB as ConfigStore/TaskDispatch.
 * It merges external facts into CURRENT encrypted accounts, not the execution snapshot.
 * Maintenance/revocation cannot erase completed writes. No credential decryption, KV
 * fallback, secret-bearing logs, arbitrary config patch, HTTP call or await lives here. */
export class BusinessEffects {
    private readonly ledger: DeploymentLedger;
    constructor(private readonly db: SqlDatabase) {
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS business_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, account TEXT NOT NULL, ordinal INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(task,account,ordinal,state))');
            db.rows('CREATE TABLE IF NOT EXISTS business_step_state (task TEXT NOT NULL, account TEXT NOT NULL, ordinal INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(task,account,ordinal))');
        });
        this.ledger = new DeploymentLedger(db);
    }
    apply(permit: CredentialPermit, input: Json, facts: unknown): void {
        const operation = parseBusinessOperation(input, permit.account);
        identifier(permit.task); identifier(permit.generation); identifier(permit.snapshot); identifier(permit.token);
        if (!Array.isArray(facts) || facts.length > operation.commands.length) return invalid();
        const seen = new Set<number>();
        const prepared = facts.map((input: unknown) => {
            const fact = JSON.parse(canonical(input)) as BusinessStepFact;
            shape(fact,'ordinal,kind,state,evidence,result');
            if (!Number.isSafeInteger(fact.ordinal) || fact.ordinal < 0 || seen.has(fact.ordinal) || operation.commands[fact.ordinal]?.kind !== fact.kind || !['verified','failed','unknown','skipped'].includes(fact.state)) invalid();
            seen.add(fact.ordinal);
            if (fact.state === 'skipped' ? fact.evidence !== null : typeof fact.evidence !== 'string' || !/^[a-f0-9]{64}$/.test(fact.evidence)) invalid();
            return { ...fact, result: project(operation.commands[fact.ordinal], fact) };
        }).sort((a,b) => a.ordinal-b.ordinal);
        this.db.transaction(() => {
            const meta = this.db.rows<{ generation: string }>('SELECT generation FROM config_meta WHERE id=1')[0];
            const delivery = this.db.rows<{ token: string; snapshot: string; state: string; steps: string }>('SELECT token,snapshot,state,steps FROM dispatch_outbox WHERE task=? AND account=?',permit.task,permit.account)[0];
            if (meta?.generation !== permit.generation || !delivery || delivery.token !== permit.token || delivery.snapshot !== permit.snapshot || !['sending','accepted','terminal'].includes(delivery.state) || delivery.steps !== canonical(operation.commands.map(c => c.kind))) conflict();
            for (const fact of prepared) {
                const payload = encoded(fact);
                const prior = this.db.rows<{ payload: string }>('SELECT payload FROM business_facts WHERE task=? AND account=? AND ordinal=? AND state=?',permit.task,permit.account,fact.ordinal,fact.state)[0];
                if (prior) { if (prior.payload !== payload) conflict(); continue; }
                if (delivery.state === 'terminal') conflict();
                if(fact.state==='failed'&&(fact.result as any)?.code==='OPERATOR_CLOSED_UNCONFIRMED'){
                    const id=(fact.result as any).adjudication;
                    if(!this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='maintenance_receipts'").length)conflict();
                    const record=this.db.rows<{intent:string;state:string}>('SELECT intent,state FROM maintenance_receipts WHERE id=?',id)[0];if(!record||!['pending','complete'].includes(record.state))conflict();const intent=JSON.parse(record.intent),cmd=intent.command,args=cmd?.args;if(cmd?.id!==id||cmd.action!=='review_close_failed'||cmd.expected?.generation!==permit.generation||args?.task!==permit.task||args.account!==permit.account||args.step!==fact.ordinal)conflict();
                    const att=this.db.rows<{intent:string;state:string;result:string|null}>('SELECT intent,state,result FROM maintenance_receipts WHERE id=?',args.attestation)[0];if(!att||att.state!=='complete'||att.result===null)conflict();const prior=JSON.parse(att.intent),proof=JSON.parse(att.result);if(prior.command.action!=='review_attest'||proof.proof!==args.proof||prior.operator===intent.operator||prior.command.args.task!==permit.task||prior.command.args.account!==permit.account||prior.command.args.step!==fact.ordinal||prior.command.args.call!==args.call)conflict();
                }
                const previous = this.db.rows<{ state: string }>('SELECT state FROM business_step_state WHERE task=? AND account=? AND ordinal=?',permit.task,permit.account,fact.ordinal)[0];
                if (previous && (previous.state !== 'unknown' || !['verified','failed'].includes(fact.state))) conflict();
                // Facts arrive in execution order. A later verified effect cannot leap
                // over a missing, failed, unknown or cancelled predecessor.
                if (fact.state === 'verified' && fact.ordinal > 0) {
                    const before = this.db.rows<{ state: string }>('SELECT state FROM business_step_state WHERE task=? AND account=? AND ordinal<? ORDER BY ordinal',permit.task,permit.account,fact.ordinal);
                    if (before.length !== fact.ordinal || before.some(s => s.state !== 'verified')) conflict();
                }
                if (fact.state === 'verified') {
                    const command=operation.commands[fact.ordinal];
                    this.mergeWorker(permit,command);
                    if (SCRIPT_COMMANDS.has(command.kind)) this.ledger.recordScriptInTransaction(permit.task,permit.generation,permit.account,fact.ordinal);
                    this.ledger.recordRemovalInTransaction(permit.generation,permit.account,command);
                }
                this.db.rows('INSERT INTO business_facts(task,account,ordinal,state,payload) VALUES (?,?,?,?,?)',permit.task,permit.account,fact.ordinal,fact.state,payload);
                this.db.rows('INSERT INTO business_step_state VALUES (?,?,?,?) ON CONFLICT(task,account,ordinal) DO UPDATE SET state=excluded.state',permit.task,permit.account,fact.ordinal,fact.state);
            }
            this.ledger.progressInTransaction(permit.task);
        });
    }
    private mergeWorker(permit: CredentialPermit, command: BusinessCommand): void {
        if (command.kind !== 'create_worker' && command.kind !== 'delete_worker' && command.kind !== 'remove_worker') return;
        const row = this.db.rows<{ revision: number; payload: string }>("SELECT revision,payload FROM config_records WHERE generation=? AND domain='accounts'",permit.generation)[0];
        if (!row) conflict();
        const accounts = JSON.parse(row.payload) as AccountEntry[];
        if (!Array.isArray(accounts) || accounts.filter(a => a.accountId === permit.account).length !== 1) conflict();
        const account = accounts.find(a => a.accountId === permit.account)!;
        if(command.kind==='remove_worker') {
            let changed=false;
            for(const template of Object.keys(TEMPLATES)) {
                const key=('workers_'+template) as `workers_${string}`;
                const old=account[key] ?? []; if(!Array.isArray(old) || old.some(v=>typeof v!=='string')) conflict();
                const next=old.filter(v=>v!==command.worker);
                if(next.length!==old.length){account[key]=next;changed=true;}
            }
            if(!changed) return;
            this.writeRecord(permit.generation,'accounts',row.revision,accounts as unknown as Json);
            for(const guard of command.cleanup) {
                const [kind,template]=guard.domain.split(':');
                const remaining=kind==='override' ? [account] : accounts;
                if(remaining.some(a=>(a[('workers_'+template) as `workers_${string}`] ?? []).length)) continue;
                const current=this.db.rows<{revision:number;payload:string}>('SELECT revision,payload FROM config_records WHERE generation=? AND domain=?',permit.generation,guard.domain)[0];
                // Never erase a configuration edit accepted since admission, even when
                // the last worker disappears. Receipt replay cannot retry this reset.
                if((current?.revision ?? 0)!==guard.revision) continue;
                const value:Json=kind==='override'?null:kind==='deploy'?{mode:'latest'}:[];
                if(!current || current.payload===canonical(value)) continue;
                this.writeRecord(permit.generation,guard.domain,current.revision,value);
            }
            return;
        }
        const key = 'workers_' + command.template as `workers_${string}`;
        const old = account[key] ?? [];
        if (!Array.isArray(old) || old.some(v => typeof v !== 'string')) conflict();
        const next = command.kind === 'create_worker' ? [...new Set([...old,command.worker])] : old.filter(v => v !== command.worker);
        if (canonical(next) === canonical(old)) return;
        account[key] = next;
        const payload = encoded(accounts);
        if (!Number.isSafeInteger(row.revision + 1)) conflict();
        this.db.rows("UPDATE config_records SET revision=revision+1,payload=? WHERE generation=? AND domain='accounts'",payload,permit.generation);
        this.db.rows("INSERT INTO config_outbox(generation,domain,revision) VALUES (?,'accounts',?)",permit.generation,row.revision + 1);
    }
    private writeRecord(generation:string,domain:string,old:number,value:Json):void {
        if(!Number.isSafeInteger(old+1)) conflict();
        this.db.rows('UPDATE config_records SET revision=revision+1,payload=? WHERE generation=? AND domain=?',encoded(value),generation,domain);
        this.db.rows('INSERT INTO config_outbox(generation,domain,revision) VALUES (?,?,?)',generation,domain,old+1);
    }
    assertComplete(task: string, account: string, steps: number, outcome: string): void {
        const facts = this.db.rows<{ state: string }>('SELECT state FROM business_step_state WHERE task=? AND account=? ORDER BY ordinal',task,account);
        if (facts.length !== steps || facts.some(f => !['verified','failed','skipped'].includes(f.state))) conflict();
        const success = facts.some(f => f.state === 'verified'), failed = facts.some(f => f.state === 'failed');
        const expected = facts.every(f => f.state === 'verified') ? 'succeeded' : failed ? success ? 'partial_failed' : 'failed' : success ? 'partial_cancelled' : 'cancelled';
        if (outcome !== expected) conflict();
    }
}
