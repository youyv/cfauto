import {copyPreparedTask} from './prepared-task-copy';
import { validateDeploymentPlans, type DeploymentPlan } from './deployment-plan';
import { TASK_STEP_KINDS } from './step-kinds';
import { ConfigStore } from './config-store';
import { SealedStore, type SealedContext } from './sealed-store';
import { TaskDispatch } from './task-dispatch';
import { canonical, domainName, identifier, revision, ReliabilityError, type Json, type ConfigChange } from './protocol';

export interface PreparedTaskInput {
    scope: string;
    key: string;
    generation: string;
    epoch: number;
    /** Include every read dependency; accounts is mandatory until per-account credential
     * records replace the aggregate. Never accept this list unvalidated from a browser. */
    expected: { domain: string; revision: number }[];
    /** Trusted planner's user-intent changes, committed atomically with first admission. */
    changes?: ConfigChange[];
    /** Static planner's full/subset source/target ledger, sealed in admission manifest. */
    deployment?: DeploymentPlan[];
    targets: { account: string; steps: string[]; operation: Json }[];
}
/** Trusted planner boundary; not an HTTP endpoint. The business planner is responsible
 * for authorization, complete read dependencies and frozen upstream code in operation.
 * All stores MUST use the same global SQLite DB. No external writes occur here. */
export class TaskPreparation {
    private readonly secret: Uint8Array;
    constructor(private readonly config: ConfigStore, private readonly sealed: SealedStore, private readonly dispatch: TaskDispatch, secret: Uint8Array) {
        if (!(secret instanceof Uint8Array) || secret.length < 32) throw new ReliabilityError('INVALID', 400);
        this.secret = new Uint8Array(secret);
    }
    private async id(scope: string, request: string, account: string): Promise<string> {
        const key = await crypto.subtle.importKey('raw', new Uint8Array(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical(['cfauto-prepared-task-v1', scope, request, account])));
        return 'snapshot_' + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    }
    async submit(input: PreparedTaskInput, admissionGuard?: () => void): Promise<{ id: string; duplicate: boolean }> {
        // Snapshot ALL caller-owned values synchronously before hashing/encryption.
        let value: PreparedTaskInput;
        try { value = copyPreparedTask(input); } catch { throw new ReliabilityError('INVALID', 400); }
        identifier(value.scope); identifier(value.key); identifier(value.generation); revision(value.epoch);
        if (!Array.isArray(value.expected) || !value.expected.length || value.expected.length > 100 || new Set(value.expected.map(r => r.domain)).size !== value.expected.length) throw new ReliabilityError('INVALID', 400);
        value.expected.forEach(r => { domainName(r.domain); revision(r.revision); });
        if (!value.expected.some(r => r.domain === 'accounts' && r.revision > 0)) throw new ReliabilityError('INVALID', 400);
        value.expected.sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
        if (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 100 || new Set(value.targets.map(t => t.account)).size !== value.targets.length) throw new ReliabilityError('INVALID', 400);

        for (const target of value.targets) {
            identifier(target.account);
            if (!Array.isArray(target.steps) || !target.steps.length || target.steps.length > 100 || target.steps.some(s => !TASK_STEP_KINDS.has(s))) throw new ReliabilityError('INVALID', 400);
        }
        if (value.changes !== undefined) {
            if (!Array.isArray(value.changes) || !value.changes.length || value.changes.length > 100 || new Set(value.changes.map(c=>c.domain)).size !== value.changes.length) throw new ReliabilityError('INVALID',400);
            for (const c of value.changes) {
                domainName(c.domain); revision(c.expectedRevision);
                if (Object.keys(c).sort().join(',') !== 'domain,expectedRevision,value' || !value.expected.some(r=>r.domain===c.domain && r.revision===c.expectedRevision)) throw new ReliabilityError('INVALID',400);
            }
            value.changes.sort((a,b)=>a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
        }
        if (value.deployment !== undefined) value.deployment = validateDeploymentPlans(value.deployment,value.targets);
        else if (value.targets.some(t=>{const operation=(t.operation as any)?.operation;return [1,2].includes(operation?.schema) && Array.isArray(operation.commands) && operation.commands.some((c:any)=>['upload','manual_upload','create_worker','replace_worker','repair_worker'].includes(c.kind));})) throw new ReliabilityError('INVALID',400);
        const contexts: SealedContext[] = [];
        const targets = [];
        for (const target of value.targets) {
            const context: SealedContext = { id: await this.id(value.scope, value.key, target.account), kind: 'task_snapshot', account: target.account, generation: value.generation };
            const snapshot = { schema: 1, account: target.account, generation: value.generation, epoch: value.epoch, expected: value.expected, ...(value.changes ? {changes:value.changes} : {}), steps: target.steps, operation: target.operation };
            await this.sealed.put(context, snapshot as unknown as Json);
            // Validate an existing immutable object's ciphertext too, not only metadata.
            if (canonical(await this.sealed.get(context)) !== canonical(snapshot)) throw new ReliabilityError('CONFLICT', 409);
            contexts.push(context); targets.push({ account: target.account, snapshot: context.id, steps: target.steps });
        }
        return this.dispatch.submit({ scope: value.scope, key: value.key, targets, ...(value.deployment?.length ? {deployment:{generation:value.generation,plans:value.deployment}} : {}) }, () => {
            admissionGuard?.();
            this.config.assertBarrier(value.generation, value.epoch, value.expected);
            for (const context of contexts) this.sealed.info(context);
            if (value.changes) this.config.compareAndSetInTransaction(value.generation,value.changes);
        });
    }
}
