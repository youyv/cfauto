import { AccountQueue } from './account-queue';
import { ExecutionJournal, ExecutionUnknown } from './execution-journal';
import { withExecution, type FrozenExecutionInput } from './execution-context';
import { SealedStore, type SealedContext } from './sealed-store';
import type { SqlDatabase } from './config-store';
import { canonical, identifier, ReliabilityError, type Json } from './protocol';

export interface RunnerSnapshot { input: FrozenExecutionInput; operation: Json }
export interface RunnerOptions {
    account: string;
    generation: string;
    digestSecret: string;
    transport: (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
    loadSnapshot: (snapshot: string, job: string) => Promise<RunnerSnapshot>;
    /** Validate persisted global permit + current credential revision/revocation. */
    authorize: (job: string) => Promise<void>;
    /** Only invoked within execution context. Must use fetchWithTimeout. */
    execute: (operation: Json, step: { ordinal: number; kind: string }) => Promise<{ outcome: 'verified' | 'failed'; result: Json }>;
}
/** A bounded account alarm pass; one logical step per invocation. All actual HTTP calls
 * are separately journaled. In-flight outer steps replay only authenticated receipts;
 * an unknown inner write prevents replay from issuing any further network writes. */
export class AccountRunner {
    private running: Promise<{ job: string; state: string } | null> | undefined;
    private readonly options: RunnerOptions;
    constructor(private readonly db: SqlDatabase, private readonly queue: AccountQueue, private readonly sealed: SealedStore, options: RunnerOptions) {
        identifier(options.account); identifier(options.generation);
        if (typeof options.digestSecret !== 'string' || new TextEncoder().encode(options.digestSecret).length < 32) throw new ReliabilityError('INVALID', 400);
        this.options = { ...options };
    }
    /** A caller cannot invoke two passes concurrently on one object instance. */
    tick(): Promise<{ job: string; state: string } | null> {
        if (this.running) return this.running;
        this.running = this.pass().finally(() => { this.running = undefined; });
        return this.running;
    }
    private async evidence(value: Json): Promise<string> {
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.options.digestSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical(['cfauto-runner-evidence-v1', value])));
        return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
    }
    /** Narrow, machine-verified exception to "an unknown step is never auto-resolved":
     * when the account journal proves that NO mutation call was ever recorded for an
     * unknown step, nothing can have been written to the provider, so the step is a
     * definite failure (code NO_MUTATION_RECORDED) instead of an unreconcilable operator
     * question. Unknown steps that DO carry a journaled mutation still require human
     * adjudication; this path issues no provider call and retries no external write.
     * Without it a pre-mutation unknown can hold the account permit forever, which also
     * starves every other account of the global delivery budget. */
    private async settleNoMutationUnknowns(): Promise<void> {
        if (!this.db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_calls'").length) return;
        this.db.rows('CREATE TABLE IF NOT EXISTS no_mutation_settlements (job TEXT NOT NULL,ordinal INTEGER NOT NULL,token TEXT NOT NULL,evidence TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(job,ordinal))');
        const pending = this.db.rows<{ job: string; ordinal: number; kind: string; token: string | null }>("SELECT job,ordinal,kind,token FROM account_steps WHERE state='unknown' ORDER BY job,ordinal LIMIT 3");
        for (const step of pending) {
            if (typeof step.token !== 'string' || !step.token) continue;
            if (this.db.rows('SELECT 1 FROM no_mutation_settlements WHERE job=? AND ordinal=?', step.job, step.ordinal).length) continue;
            const journalJob = step.job + '_' + step.ordinal;
            if (this.db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM execution_calls WHERE job=? AND mutation=1', journalJob)[0].n !== 0) continue;
            const context: SealedContext = { id: 'result_' + step.job + '_' + step.ordinal, kind: 'task_snapshot', account: this.options.account, generation: this.options.generation };
            try { await this.sealed.get(context); continue; } // an existing artifact is never overwritten
            catch (error) { if (!(error instanceof ReliabilityError) || error.code !== 'NOT_READY') throw error; }
            const evidence = await this.evidence(['cfauto-no-mutation-settlement-v1', step.job, step.ordinal, step.kind, this.options.account]);
            await this.sealed.put(context, { outcome: 'failed', result: { kind: step.kind, code: 'NO_MUTATION_RECORDED' } } as unknown as Json);
            const unwritten = () => { if (this.db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM execution_calls WHERE job=? AND mutation=1', journalJob)[0].n !== 0) throw new ReliabilityError('CONFLICT', 409); };
            this.queue.reconcile(step.job, step.ordinal, step.token, 'failed', evidence, () => {
                unwritten();
                if (this.db.rows('SELECT 1 FROM no_mutation_settlements WHERE job=? AND ordinal=?', step.job, step.ordinal).length) throw new ReliabilityError('CONFLICT', 409);
                this.db.rows('INSERT INTO no_mutation_settlements VALUES (?,?,?,?,?)', step.job, step.ordinal, step.token, evidence, Date.now());
            }, unwritten);
        }
    }
    private async pass(): Promise<{ job: string; state: string } | null> {
        await this.settleNoMutationUnknowns();
        const unresolved = this.queue.unresolved();
        if (unresolved.some(s => s.state === 'unknown')) return null;
        // Only one in-flight step is allowed by the account queue. Restart does not
        // change token or reset it to planned, and no second job can bypass it.
        const prior = unresolved[0];
        if (unresolved.length > 1) throw new ReliabilityError('CONFLICT', 409);
        const step = prior ? { job: prior.job, ordinal: prior.ordinal, kind: prior.kind, token: prior.token!, snapshot: this.db.rows<{ snapshot: string }>('SELECT snapshot FROM account_jobs WHERE id=?', prior.job)[0].snapshot } : this.queue.claim();
        if (!step) return null;
        const context: SealedContext = { id: 'result_' + step.job + '_' + step.ordinal, kind: 'task_snapshot', account: this.options.account, generation: this.options.generation };
        try {
            let saved: { outcome: 'verified' | 'failed'; result: Json } | undefined;
            try { saved = await this.sealed.get(context) as unknown as typeof saved; }
            catch (error) { if (!(error instanceof ReliabilityError) || error.code !== 'NOT_READY') throw error; }
            if (!saved) {
                await this.options.authorize(step.job);
                const snapshot = await this.options.loadSnapshot(step.snapshot, step.job);
                // Ordinal is part of the journal ID so multi-step tasks do not replay
                // the previous logical step's response sequence.
                const journal = new ExecutionJournal(this.db, this.sealed, { job: step.job + '_' + step.ordinal, account: this.options.account, generation: this.options.generation }, {
                    digestSecret: this.options.digestSecret, transport: this.options.transport,
                    authorizeMutation: () => this.options.authorize(step.job)
                });
                let value: { outcome: 'verified' | 'failed'; result: Json } | undefined;
                try { value = await withExecution(journal, snapshot.input, () => this.options.execute(snapshot.operation, step)); }
                finally { await journal.finish(); }
                if (!value || !['verified', 'failed'].includes(value.outcome)) throw new ExecutionUnknown();
                // Freeze result before async sealing/evidence. No handler-held object
                // may change the receipt after journal.finish has checked its calls.
                saved = JSON.parse(canonical(value));
                await this.sealed.put(context, saved as unknown as Json);
            }
            if (!saved || !['verified', 'failed'].includes(saved.outcome)) throw new ExecutionUnknown();
            this.queue.finish(step.job, step.ordinal, step.token, saved.outcome, await this.evidence(saved as unknown as Json));
        } catch {
            // No automatic rollback/retry of uncertain writes. Even authorization or
            // local persistence failures retain the account permit until reviewed.
            this.queue.finish(step.job, step.ordinal, step.token, 'unknown', await this.evidence({ job: step.job, ordinal: step.ordinal, state: 'needs_review' }));
        }
        return { job: step.job, state: this.queue.inspect(step.job).state };
    }
}
