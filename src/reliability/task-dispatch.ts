import { DeploymentLedger } from './deployment-ledger';
import { validateDeploymentPlans, type DeploymentPlan } from './deployment-plan';
import { TASK_STEP_KINDS } from './step-kinds';
import type { SqlDatabase } from './config-store';
import { encoded, identifier, ReliabilityError } from './protocol';


export type TerminalTaskState = 'succeeded' | 'failed' | 'partial_failed' | 'cancelled' | 'partial_cancelled';
const terminalStates = new Set<string>(['succeeded', 'failed', 'partial_failed', 'cancelled', 'partial_cancelled']);
export interface TaskTarget { account: string; snapshot: string; steps: string[] }
export interface TaskSubmission { scope: string; key: string; targets: TaskTarget[]; deployment?: {generation:string;plans:DeploymentPlan[]} }
interface TaskRow extends Record<string, unknown> { id: string; receipt: string; digest: string }
interface DeliveryRow extends Record<string, unknown> {
    seq: number; task: string; account: string; snapshot: string; steps: string; digest: string;
    state: string; token: string | null; outcome: string | null; evidence: string | null;
}
export interface TaskDelivery { task: string; account: string; snapshot: string; steps: string[]; digest: string; token: string }
function invalid(): never { throw new ReliabilityError('INVALID', 400); }
function conflict(): never { throw new ReliabilityError('CONFLICT', 409); }
function digestValue(value: string): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); }

/** Global durable outbox. Internal only: caller must authenticate scope, freeze and encrypt
 * snapshots, and coordinate config/credential revisions before submitting.
 * HMAC protects stored request fingerprints; it is NOT RPC authorization.
 * Permits never expire: lost/unknown outcomes cannot silently authorize another executor.
 */
export class TaskDispatch {
    private readonly secret: Uint8Array;
    private readonly ledger: DeploymentLedger;
    constructor(private readonly db: SqlDatabase, secret: Uint8Array) {
        if (!(secret instanceof Uint8Array) || secret.byteLength < 32) invalid();
        this.secret = new Uint8Array(secret);
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS dispatch_key (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS dispatch_tasks (id TEXT PRIMARY KEY, receipt TEXT UNIQUE NOT NULL, digest TEXT NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS dispatch_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, account TEXT NOT NULL, snapshot TEXT NOT NULL, steps TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, token TEXT, outcome TEXT, evidence TEXT, UNIQUE(task,account))');
            db.rows('CREATE TABLE IF NOT EXISTS dispatch_wakeups (task TEXT NOT NULL, account TEXT NOT NULL, request TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task,account))');
            db.rows('CREATE TABLE IF NOT EXISTS dispatch_cancellations (task TEXT NOT NULL, account TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task,account))');
            db.rows('CREATE INDEX IF NOT EXISTS dispatch_account_state ON dispatch_outbox(account,state,seq)');
            db.rows('CREATE INDEX IF NOT EXISTS dispatch_state_seq ON dispatch_outbox(state,seq)');
        });
        this.ledger = new DeploymentLedger(db);
    }
    private async mac(label: string, value: unknown): Promise<string> {
        const key = await crypto.subtle.importKey('raw', new Uint8Array(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded([label, value])));
        return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
    }
    /** Read-only stable identity lookup. Does not initialize a key, reserve permits,
     * create tasks, or claim that absence is a proof about external effects. A caller
     * recovering a manifest must still validate/replay the exact original plan. */
    async lookupReceipt(scope:string,key:string):Promise<{id:string}|null> {
        identifier(scope);identifier(key);
        const fingerprint=await this.mac('cfauto-task-key-check-v1',[]),receipt=await this.mac('cfauto-task-key-v1',[scope,key]);
        return this.db.transaction(()=>{
            const stored=this.db.rows<{fingerprint:string}>('SELECT fingerprint FROM dispatch_key WHERE id=1')[0];
            if(stored&&stored.fingerprint!==fingerprint)conflict();
            if(!stored&&this.db.rows('SELECT id FROM dispatch_tasks LIMIT 1').length)conflict();
            const old=this.db.rows<TaskRow>('SELECT * FROM dispatch_tasks WHERE receipt=?',receipt)[0];
            return old?{id:old.id}:null;
        });
    }
    async submit(input: TaskSubmission, beforeInsert?: () => void): Promise<{ id: string; duplicate: boolean }> {
        if (!input || typeof input !== 'object') invalid();
        identifier(input.scope); identifier(input.key);
        if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 100) invalid();
        // Copy and normalize everything before the first await. Target order is not semantic;
        // step order is semantic. Never persist raw idempotency keys or credential values.
        const scope = input.scope, requestKey = input.key;
        const targets = Array.from(input.targets).map(t => {
            if (!t || typeof t !== 'object') invalid();
            identifier(t.account); identifier(t.snapshot);
            if (!Array.isArray(t.steps) || !t.steps.length || t.steps.length > 100 || Array.from(t.steps).some(s => !TASK_STEP_KINDS.has(s))) invalid();
            return { account: t.account, snapshot: t.snapshot, steps: [...t.steps] };
        }).sort((a, b) => a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
        if (new Set(targets.map(t => t.account)).size !== targets.length) invalid();
        encoded(targets);
        const deployment=input.deployment===undefined?undefined:{generation:input.deployment.generation,plans:validateDeploymentPlans(input.deployment.plans)};
        if (deployment) { identifier(deployment.generation); if (!deployment.plans.length || deployment.plans.some(p=>p.targets.some(t=>!targets.some(owner=>owner.account===t.account && t.steps.every(n=>n<owner.steps.length))))) invalid(); }
        const fingerprint = await this.mac('cfauto-task-key-check-v1', []);
        const receipt = await this.mac('cfauto-task-key-v1', [scope, requestKey]);
        const digest = await this.mac('cfauto-task-request-v1', deployment?[scope,targets,deployment]:[scope,targets]);
        return this.db.transaction(() => {
            const storedKey = this.db.rows<{ fingerprint: string }>('SELECT fingerprint FROM dispatch_key WHERE id=1')[0];
            if (storedKey && storedKey.fingerprint !== fingerprint) conflict();
            if (!storedKey) this.db.rows('INSERT INTO dispatch_key VALUES (1,?)', fingerprint);
            const old = this.db.rows<TaskRow>('SELECT * FROM dispatch_tasks WHERE receipt=?', receipt)[0];
            if (old) { if (old.digest !== digest) conflict(); return { id: old.id, duplicate: true }; }
            // Trusted local integration only. Must share this DB and stay synchronous.
            // Exact duplicate receipts bypass the barrier: returning an existing task
            // does not authorize new work after a later config change/maintenance.
            if (beforeInsert) {
                const result: unknown = beforeInsert();
                if (result !== undefined) invalid();
            }
            const active = this.db.rows<{ n: number }>("SELECT COUNT(DISTINCT task) AS n FROM dispatch_outbox WHERE state!='terminal'")[0].n;
            if (active >= 500) conflict();
            for (const target of targets) {
                const count = this.db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM dispatch_outbox WHERE account=? AND state!='terminal'", target.account)[0].n;
                if (count >= 50) conflict();
            }
            const id = crypto.randomUUID();
            this.db.rows('INSERT INTO dispatch_tasks VALUES (?,?,?)', id, receipt, digest);
            for (const target of targets) this.db.rows("INSERT INTO dispatch_outbox (task,account,snapshot,steps,digest,state) VALUES (?,?,?,?,?,'pending')", id, target.account, target.snapshot, encoded(target.steps), digest);
            if (deployment) this.ledger.registerInTransaction(id,deployment.generation,deployment.plans);
            return { id, duplicate: false };
        });
    }
    /** Resends unacknowledged deliveries with exactly the same token. At most three
     * accounts hold a permit, including deliveries awaiting reconciliation. */
    reserve(): TaskDelivery[] {
        return this.db.transaction(() => {
            let count = this.db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM dispatch_outbox WHERE state IN ('sending','accepted')")[0].n;
            while (count < 3) {
                const row = this.db.rows<DeliveryRow>("SELECT p.* FROM dispatch_outbox p WHERE p.state='pending' AND NOT EXISTS (SELECT 1 FROM dispatch_outbox a WHERE a.account=p.account AND a.state IN ('sending','accepted')) ORDER BY p.seq LIMIT 1")[0];
                if (!row) break;
                this.db.rows("UPDATE dispatch_outbox SET state='sending',token=? WHERE seq=?", crypto.randomUUID(), row.seq);
                count++;
            }
            return this.db.rows<DeliveryRow>("SELECT * FROM dispatch_outbox WHERE state='sending' ORDER BY seq").map(row => ({ task: row.task, account: row.account, snapshot: row.snapshot, steps: JSON.parse(row.steps) as string[], digest: row.digest, token: row.token! }));
        });
    }
    private delivery(task: string, account: string, token: string): DeliveryRow {
        identifier(task); identifier(account); identifier(token);
        const row = this.db.rows<DeliveryRow>('SELECT * FROM dispatch_outbox WHERE task=? AND account=?', task, account)[0];
        if (!row || row.token !== token) conflict();
        return row;
    }
    /** Synchronous guard for a config CAS on this same DB. Pending snapshots also
     * reference credentials, so freeze edits until all such work is terminal. */
    assertAccountsIdle(accounts: string[]): void {
        if (!Array.isArray(accounts) || accounts.length > 1000) invalid();
        for (const account of accounts) {
            identifier(account);
            if (this.db.rows("SELECT seq FROM dispatch_outbox WHERE account=? AND state!='terminal' LIMIT 1", account).length) conflict();
        }
    }
    /** Internal authorization primitive, not an RPC authentication mechanism. */
    assertPermit(task: string, account: string, token: string, snapshot: string): void {
        identifier(snapshot);
        const row = this.delivery(task, account, token);
        if (!['sending', 'accepted'].includes(row.state) || row.snapshot !== snapshot) conflict();
    }
    acknowledge(task: string, account: string, token: string): void {
        this.db.transaction(() => {
            const row = this.delivery(task, account, token);
            if (row.state === 'sending') this.db.rows("UPDATE dispatch_outbox SET state='accepted' WHERE seq=?", row.seq);
            else if (row.state !== 'accepted' && row.state !== 'terminal') conflict();
        });
    }
    /** Only trusted account terminal receipts may call this; unknown/running are not
     * terminal. Token rejects stale local callbacks, not external Cloudflare writes. */
    complete(task: string, account: string, token: string, outcome: TerminalTaskState, evidence: string): void {
        if (!terminalStates.has(outcome)) invalid();
        digestValue(evidence);
        this.db.transaction(() => {
            const row = this.delivery(task, account, token);
            if (row.state === 'terminal') { if (row.outcome !== outcome || row.evidence !== evidence) conflict(); this.ledger.completeInTransaction(task); return; }
            if (row.state !== 'accepted' && row.state !== 'sending') conflict();
            this.db.rows("UPDATE dispatch_outbox SET state='terminal',outcome=?,evidence=? WHERE seq=?", outcome, evidence, row.seq);
            this.ledger.completeInTransaction(task);
        });
    }
    /** Wake only the original durable delivery; never reset steps or release a permit. */
    requestWake(task: string): void {
        identifier(task);
        this.db.transaction(() => {
            // Pending targets only need the global alarm. Existing permits also need
            // an acknowledged, replay-safe delivery to wake a parked account alarm.
            for (const target of this.inspect(task)) if (target.state === 'sending' || target.state === 'accepted') {
                this.db.rows('INSERT INTO dispatch_wakeups VALUES (?,?,?,0) ON CONFLICT(task,account) DO UPDATE SET request=excluded.request,acknowledged=0',task,target.account,crypto.randomUUID());
            }
        });
    }
    pendingWakes(): (TaskDelivery & { request: string })[] {
        return this.db.rows<DeliveryRow & { request: string }>("SELECT d.*,w.request FROM dispatch_outbox d JOIN dispatch_wakeups w ON w.task=d.task AND w.account=d.account WHERE w.acknowledged=0 AND d.state IN ('sending','accepted') ORDER BY d.seq").map(row => ({task:row.task,account:row.account,snapshot:row.snapshot,steps:JSON.parse(row.steps),digest:row.digest,token:row.token!,request:row.request}));
    }
    acknowledgeWake(task: string, account: string, token: string, request: string): void {
        identifier(request);
        this.db.transaction(() => {
            this.delivery(task,account,token);
            // A late ACK cannot erase a newer explicit wake request.
            this.db.rows('UPDATE dispatch_wakeups SET acknowledged=1 WHERE task=? AND account=? AND request=?',task,account,request);
        });
    }
    /** A cancellation request does not release a permit or assert that execution stopped. */
    requestCancel(task: string): void {
        identifier(task);
        this.db.transaction(() => {
            const targets = this.inspect(task);
            for (const target of targets) if (target.state !== 'terminal') this.db.rows('INSERT OR IGNORE INTO dispatch_cancellations(task,account) VALUES (?,?)',task,target.account);
        });
    }
    cancelRequested(task: string, account: string): boolean {
        return this.db.rows('SELECT task FROM dispatch_cancellations WHERE task=? AND account=?',task,account).length > 0;
    }
    pendingCancels(): TaskDelivery[] {
        return this.db.rows<DeliveryRow>("SELECT d.* FROM dispatch_outbox d JOIN dispatch_cancellations c ON c.task=d.task AND c.account=d.account WHERE c.acknowledged=0 AND d.state IN ('sending','accepted') ORDER BY d.seq").map(row => ({task:row.task,account:row.account,snapshot:row.snapshot,steps:JSON.parse(row.steps),digest:row.digest,token:row.token!}));
    }
    acknowledgeCancel(task: string, account: string, token: string): void {
        this.db.transaction(() => {
            this.delivery(task,account,token);
            this.db.rows('UPDATE dispatch_cancellations SET acknowledged=1 WHERE task=? AND account=?',task,account);
        });
    }
    inspect(task: string): { account: string; state: string; outcome: string | null }[] {
        identifier(task);
        if (!this.db.rows('SELECT id FROM dispatch_tasks WHERE id=?', task).length) throw new ReliabilityError('NOT_READY', 404);
        return this.db.rows<DeliveryRow>('SELECT account,state,outcome FROM dispatch_outbox WHERE task=? ORDER BY seq', task).map(r => ({ account: r.account, state: r.state, outcome: r.outcome }));
    }
}

/** One bounded outbox pass. The receiver must durably deduplicate before resolving.
 * No execution side effects or timers here; RPC failure retains the permit and delivery.
 * Raw transport errors are intentionally not returned (may contain credentials). */
export async function dispatchOnce(store: TaskDispatch, receive: (delivery: TaskDelivery) => Promise<void>): Promise<{ acknowledged: number; retryPending: number }> {
    const deliveries = store.reserve();
    const outcomes = await Promise.all(deliveries.map(async delivery => {
        try {
            await receive(delivery);
            store.acknowledge(delivery.task, delivery.account, delivery.token);
            return true;
        } catch { return false; }
    }));
    return { acknowledged: outcomes.filter(Boolean).length, retryPending: outcomes.filter(v => !v).length };
}
