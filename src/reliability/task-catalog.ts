import { BusinessAdmission } from './business-admission';
import { shape } from './business-command';
import type { SqlDatabase } from './config-store';
import { readTaskDeployments } from './deployment-ledger';
import { canonical, identifier, sha256, ReliabilityError, type Json } from './protocol';
import type { TaskDispatch } from './task-dispatch';

const invalid = (): never => { throw new ReliabilityError('INVALID', 400); };
interface TargetRow extends Record<string, unknown> {
    task: string; account: string; state: string; outcome: string | null; steps: string; cancelled: number;
}
interface StepRow extends Record<string, unknown> {
    task: string; account: string; ordinal: number; state: string; payload: string | null;
}
interface AutomationRow extends Record<string, unknown> {
    task: string; cycle: string; template: string; state: string; notice: string | null;
}
/** Installation-owned task reads, including Cron. No taskId grants access and no
 * snapshot, executable intent, permit, credential or raw provider body is exposed. */
export class TaskCatalog {
    private readonly secret: Uint8Array;
    constructor(private readonly db: SqlDatabase, _dispatch: TaskDispatch, private readonly admission: Pick<BusinessAdmission<any>, 'ownerForCatalog'>, secret: Uint8Array, private readonly automationOwner = 'manager') {
        if (secret.length < 32) invalid();
        this.secret = secret.slice();
    }
    private async mac(scope: string, position: number): Promise<string> {
        const key = await crypto.subtle.importKey('raw', this.secret as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical(['cfauto-task-catalog-v1', scope, position])));
        return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    }
    private owned(id: string, owner: string, scope: string): boolean {
        return this.db.rows('SELECT id FROM dispatch_tasks t WHERE id=? AND (EXISTS (SELECT 1 FROM business_admissions b WHERE b.task=t.id AND b.owner=?) OR (?=1 AND EXISTS (SELECT 1 FROM automation_lanes a WHERE a.task=t.id)))', id, owner, Number(scope === this.automationOwner)).length === 1;
    }
    /** Called synchronously inside the caller's read transaction, only after ownership
     * filtering. Four bounded reads per page; no per-account/per-step SQL or DDL. */
    private snapshots(ids: string[]): Map<string, Record<string, Json>> {
        const snapshots = new Map<string, Record<string, Json>>();
        if (!ids.length) return snapshots;
        const placeholders = ids.map(() => '?').join(',');
        const targetsByTask = new Map(ids.map(id => [id, [] as TargetRow[]]));
        for (const row of this.db.rows<TargetRow>(
            'SELECT d.task,d.account,d.state,d.outcome,d.steps,CASE WHEN c.task IS NULL THEN 0 ELSE 1 END AS cancelled FROM dispatch_outbox d LEFT JOIN dispatch_cancellations c ON c.task=d.task AND c.account=d.account WHERE d.task IN (' + placeholders + ') ORDER BY d.seq', ...ids)) {
            targetsByTask.get(row.task)!.push(row);
        }
        const steps = new Map(this.db.rows<StepRow>(
            'SELECT s.task,s.account,s.ordinal,s.state,f.payload FROM business_step_state s LEFT JOIN business_facts f ON f.task=s.task AND f.account=s.account AND f.ordinal=s.ordinal AND f.state=s.state WHERE s.task IN (' + placeholders + ')', ...ids)
            .map(row => [row.task + ':' + row.account + ':' + row.ordinal, row]));
        const automations = new Map<string, AutomationRow>();
        for (const row of this.db.rows<AutomationRow>('SELECT task,cycle,template,state,notice FROM automation_lanes WHERE task IN (' + placeholders + ')', ...ids)) {
            if (!automations.has(row.task)) automations.set(row.task, row);
        }
        const deployments = readTaskDeployments(this.db, ids);
        for (const id of ids) {
            const targets = targetsByTask.get(id)!.map(target => ({
                account: target.account, state: target.state, outcome: target.outcome,
                cancellationRequested: !!target.cancelled,
                steps: (JSON.parse(target.steps) as string[]).map((kind, ordinal) => {
                    const row = steps.get(id + ':' + target.account + ':' + ordinal), state = row?.state ?? 'pending';
                    const result = row?.payload ? JSON.parse(row.payload)?.result : null;
                    // Facts were validated at ingress. Re-project only explicitly safe fields.
                    const safe: Record<string, Json> = {};
                    if (result && typeof result === 'object') {
                        if (typeof result.worker === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(result.worker)) safe.worker = result.worker;
                        if (['PROVIDER_REJECTED', 'RESOURCE_CONFLICT', 'PROVIDER_STATE_ABSENT', 'NO_MUTATION_RECORDED', 'ROTATION_NOT_APPLIED'].includes(result.code)) safe.code = result.code;
                        if (result.code === 'OPERATOR_CLOSED_UNCONFIRMED') {
                            if (state !== 'failed' || typeof result.adjudication !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(result.adjudication)) throw new ReliabilityError('NOT_READY', 503);
                            Object.assign(safe, { code: result.code, adjudication: result.adjudication, settlement: 'operator_attested', machineVerified: false, externalSuccessClaimed: false });
                        }
                        for (const field of ['scriptVerified', 'bindingsVerified', 'bindingsAccepted', 'domainsVerified', 'subdomainVerified', 'confirmed']) if (result[field] === true) safe[field] = true;
                        if (['deleted', 'retained_shared'].includes(result.disposition)) safe.disposition = result.disposition;
                    }
                    return { ordinal, kind, state, result: Object.keys(safe).length ? safe : null };
                })
            }));
            const allTerminal = targets.length > 0 && targets.every(t => t.state === 'terminal');
            const unknown = targets.some(t => t.steps.some(s => s.state === 'unknown'));
            // Durable partial outcomes already prove some progress, even if the
            // optional per-step read projection is not available.
            const success = targets.some(t => ['succeeded', 'partial_failed', 'partial_cancelled'].includes(t.outcome ?? '') || t.steps.some(s => s.state === 'verified'));
            const failed = targets.some(t => ['failed', 'partial_failed'].includes(t.outcome ?? ''));
            const state = unknown ? 'needs_review' : allTerminal ? (targets.every(t => t.outcome === 'succeeded') ? 'succeeded' : failed ? (success ? 'partial_failed' : 'failed') : (success ? 'partial_cancelled' : 'cancelled')) : targets.some(t => t.state !== 'pending') ? 'running' : 'queued';
            const automation = automations.get(id);
            // Notification delivery remains independent of terminal task success.
            const notification = automation ? (automation.state === 'notification_unknown' ? 'unknown' : automation.state === 'notification_rejected' ? 'rejected' : automation.state === 'notification_unsupported' ? 'unsupported' : allTerminal && ['failed', 'partial_failed', 'cancelled', 'partial_cancelled'].includes(state) ? 'not_sent' : automation.state === 'succeeded' ? (automation.notice ? 'delivered' : 'not_requested') : 'pending') : null;
            const humanSettlements = targets.reduce((n, target) => n + target.steps.filter(step => step.result?.code === 'OPERATOR_CLOSED_UNCONFIRMED').length, 0);
            snapshots.set(id, {
                id, state, terminal: allTerminal, ...(humanSettlements ? { humanSettlements } : {}), trigger: automation ? 'automation' : 'manual',
                ...(automation ? { cycle: automation.cycle, template: automation.template, automationState: automation.state, notification } : {}),
                targets: targets as unknown as Json, deployments: deployments.get(id)!
            });
        }
        return snapshots;
    }
    async inspect(scope: string, id: string): Promise<Json> {
        identifier(scope); identifier(id);
        const owner = await this.admission.ownerForCatalog(scope);
        const value = this.db.transaction(() => {
            if (!this.owned(id, owner, scope)) throw new ReliabilityError('NOT_READY', 404);
            return this.snapshots([id]).get(id)!;
        });
        return { ...value, revision: await sha256(canonical(value)) };
    }
    async list(scope: string, input: unknown): Promise<Json> {
        identifier(scope); shape(input, 'limit,cursor');
        const limit = input.limit, cursor = input.cursor;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (cursor !== null && typeof cursor !== 'string')) return invalid();
        let before = Number.MAX_SAFE_INTEGER;
        if (cursor !== null) {
            const match = /^v2\.([1-9][0-9]{0,15})\.([a-f0-9]{64})$/.exec(cursor);
            if (!match || !Number.isSafeInteger(Number(match[1])) || match[2] !== await this.mac(scope, Number(match[1]))) return invalid();
            before = Number(match[1]);
        }
        const owner = await this.admission.ownerForCatalog(scope);
        const page = this.db.transaction(() => {
            const rows = this.db.rows<{ position: number; id: string }>('SELECT t.rowid AS position,t.id FROM dispatch_tasks t WHERE t.rowid<? AND (EXISTS (SELECT 1 FROM business_admissions b WHERE b.task=t.id AND b.owner=?) OR (?=1 AND EXISTS (SELECT 1 FROM automation_lanes a WHERE a.task=t.id))) ORDER BY t.rowid DESC LIMIT ?', before, owner, Number(scope === this.automationOwner), limit + 1);
            const selected = rows.slice(0, limit), snapshots = this.snapshots(selected.map(row => row.id));
            return { items: selected.map(row => snapshots.get(row.id)!), last: selected.at(-1)?.position, more: rows.length > limit };
        });
        return { items: page.items, cursor: page.more && page.last !== undefined ? 'v2.' + page.last + '.' + await this.mac(scope, page.last) : null };
    }
}
