import { TASK_STEP_KINDS } from './step-kinds';
import type { SqlDatabase } from './config-store';
import { canonical, identifier, ReliabilityError } from './protocol';
export type StepOutcome = 'verified' | 'failed' | 'unknown';
interface Job extends Record<string, unknown> { id: string; digest: string; snapshot: string; state: string; cancel_requested: number; seq: number }
interface Step extends Record<string, unknown> { job: string; ordinal: number; kind: string; state: string; token: string | null; evidence: string | null }

/** Account-local durable execution ledger. Never performs external writes itself.
 * Execution tokens reject stale local callbacks, NOT a fence at Cloudflare's API. */
export class AccountQueue {
    constructor(private readonly db: SqlDatabase) {
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS account_jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, snapshot TEXT NOT NULL, state TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0)');
            db.rows('CREATE TABLE IF NOT EXISTS account_steps (job TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, token TEXT, evidence TEXT, PRIMARY KEY(job,ordinal))');
            db.rows('CREATE TABLE IF NOT EXISTS account_receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, ordinal INTEGER NOT NULL, outcome TEXT NOT NULL, evidence TEXT NOT NULL)');
            db.rows('CREATE INDEX IF NOT EXISTS account_receipts_job_seq ON account_receipts(job,seq)');
        });
    }
    enqueue(id: string, digest: string, snapshot: string, steps: string[], beforeCommit?: () => void, cancelRequested = false): { duplicate: boolean } {
        identifier(id); identifier(snapshot);
        if (typeof cancelRequested !== 'boolean') throw new ReliabilityError('INVALID', 400);
        if (!/^[a-f0-9]{64}$/.test(digest) || !Array.isArray(steps) || !steps.length || steps.length > 100 || steps.some(s => !TASK_STEP_KINDS.has(s))) throw new ReliabilityError('INVALID', 400);
        return this.db.transaction(() => {
            // Trusted same-DB inbox hook, including duplicate deliveries. No nested
            // transaction and no async callback may split inbox from queue admission.
            const guard = () => {
                if (beforeCommit && (beforeCommit() as unknown) !== undefined) throw new ReliabilityError('INVALID', 400);
            };
            const existing = this.db.rows<Job>('SELECT * FROM account_jobs WHERE id=?', id)[0];
            if (existing) {
                const stored = this.db.rows<Step>('SELECT kind FROM account_steps WHERE job=? ORDER BY ordinal', id).map(s => s.kind);
                if (existing.digest !== digest || existing.snapshot !== snapshot || canonical(stored) !== canonical(steps)) throw new ReliabilityError('CONFLICT', 409);
                guard();
                if (cancelRequested) this.cancelLocal(id);
                return { duplicate: true };
            }
            const count = this.db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM account_jobs WHERE state IN ('queued','running','needs_review')")[0].n;
            if (count >= 50) throw new ReliabilityError('CONFLICT', 409);
            this.db.rows("INSERT INTO account_jobs (id,digest,snapshot,state) VALUES (?,?,?,'queued')", id, digest, snapshot);
            steps.forEach((kind, ordinal) => this.db.rows("INSERT INTO account_steps VALUES (?,?,?,'planned',NULL,NULL)", id, ordinal, kind));
            guard();
            if (cancelRequested) this.cancelLocal(id);
            return { duplicate: false };
        });
    }
    private job(id: string): Job {
        const job = this.db.rows<Job>('SELECT * FROM account_jobs WHERE id=?', id)[0];
        if (!job) throw new ReliabilityError('NOT_READY', 404);
        return job;
    }
    inspect(id: string): { state: string; cancelRequested: boolean; steps: Step[] } {
        identifier(id);
        return this.db.transaction(() => {
            const job = this.job(id);
            return { state: job.state, cancelRequested: !!job.cancel_requested, steps: this.db.rows<Step>('SELECT * FROM account_steps WHERE job=? ORDER BY ordinal', id) };
        });
    }
    /** Persist in_flight BEFORE handing work to an executor. An uncertain step blocks the account. */
    claim(): { job: string; ordinal: number; kind: string; token: string; snapshot: string } | null {
        return this.db.transaction(() => {
            if (this.db.rows("SELECT 1 AS blocked FROM account_steps WHERE state IN ('in_flight','unknown') LIMIT 1").length) return null;
            const job = this.db.rows<Job>("SELECT * FROM account_jobs WHERE state IN ('queued','running') AND cancel_requested=0 ORDER BY seq LIMIT 1")[0];
            if (!job) return null;
            const step = this.db.rows<Step>("SELECT * FROM account_steps WHERE job=? AND state='planned' ORDER BY ordinal LIMIT 1", job.id)[0];
            if (!step) throw new ReliabilityError('CONFLICT', 409);
            const token = crypto.randomUUID();
            this.db.rows("UPDATE account_steps SET state='in_flight',token=? WHERE job=? AND ordinal=?", token, job.id, step.ordinal);
            this.db.rows("UPDATE account_jobs SET state='running' WHERE id=?", job.id);
            return { job: job.id, ordinal: step.ordinal, kind: step.kind, token, snapshot: job.snapshot };
        });
    }
    /** Hash/reference to restricted evidence only. No upstream response or secret text stored here. */
    finish(jobId: string, ordinal: number, token: string, outcome: StepOutcome, evidence: string): void {
        this.transition(jobId, ordinal, token, outcome, evidence, false);
    }
    /** Executor must obtain read-back evidence; unknown/in_flight is never reset to planned. */
    reconcile(jobId: string, ordinal: number, token: string, outcome: StepOutcome, evidence: string, commit?: () => void, before?: () => void): void {
        this.transition(jobId, ordinal, token, outcome, evidence, true, commit, before);
    }
    private transition(jobId: string, ordinal: number, token: string, outcome: StepOutcome, evidence: string, reconciliation: boolean, commit?: () => void, before?: () => void): void {
        identifier(jobId); identifier(token);
        if ((commit || before) && (!reconciliation || outcome !== 'failed')) throw new ReliabilityError('INVALID',400);
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !['verified','failed','unknown'].includes(outcome) || !/^[a-f0-9]{64}$/.test(evidence)) throw new ReliabilityError('INVALID', 400);
        this.db.transaction(() => {
            if (before) { const result: unknown = before(); if (result !== undefined) throw new ReliabilityError('INVALID',400); }
            this.job(jobId);
            const step = this.db.rows<Step>('SELECT * FROM account_steps WHERE job=? AND ordinal=?', jobId, ordinal)[0];
            if (!step || step.token !== token) throw new ReliabilityError('CONFLICT', 409);
            if (step.state === outcome && step.evidence === evidence) { if (commit) { const result: unknown = commit(); if (result !== undefined) throw new ReliabilityError('INVALID',400); } return; } // duplicate delivery
            if (!(step.state === 'in_flight' || reconciliation && step.state === 'unknown')) throw new ReliabilityError('CONFLICT', 409);
            this.db.rows('UPDATE account_steps SET state=?,evidence=? WHERE job=? AND ordinal=?', outcome, evidence, jobId, ordinal);
            this.db.rows('INSERT INTO account_receipts (job,ordinal,outcome,evidence) VALUES (?,?,?,?)', jobId, ordinal, outcome, evidence);
            if (outcome === 'unknown') { this.db.rows("UPDATE account_jobs SET state='needs_review' WHERE id=?", jobId); return; }
            if (outcome === 'failed') this.db.rows("UPDATE account_steps SET state='skipped' WHERE job=? AND state='planned'", jobId);
            this.summarize(jobId);
            if (commit) { const result: unknown = commit(); if (result !== undefined) throw new ReliabilityError('INVALID',400); }
        });
    }
    private summarize(id: string): void {
        const job = this.job(id);
        const steps = this.db.rows<Step>('SELECT state FROM account_steps WHERE job=? ORDER BY ordinal', id);
        const states = steps.map(s => s.state);
        const success = states.includes('verified');
        const unfinished = states.includes('planned') || states.includes('in_flight');
        const state = states.includes('unknown') ? 'needs_review' : unfinished ? 'running'
            : states.every(s => s === 'verified') ? 'succeeded'
            : states.includes('failed') ? (success ? 'partial_failed' : 'failed')
            : job.cancel_requested ? (success ? 'partial_cancelled' : 'cancelled') : 'failed';
        this.db.rows('UPDATE account_jobs SET state=? WHERE id=?', state, id);
    }
    cancel(id: string): void {
        identifier(id);
        this.db.transaction(() => this.cancelLocal(id));
    }
    private cancelLocal(id: string): void {
        const job = this.job(id);
        if (!['queued','running','needs_review'].includes(job.state)) return;
        this.db.rows('UPDATE account_jobs SET cancel_requested=1 WHERE id=?', id);
        this.db.rows("UPDATE account_steps SET state='skipped' WHERE job=? AND state='planned'", id);
        this.summarize(id);
    }
    unresolved(): Step[] {
        return this.db.rows<Step>("SELECT * FROM account_steps WHERE state IN ('in_flight','unknown') ORDER BY job,ordinal");
    }
}
