import type { AccountEntry } from '../lib/types';
import { ConfigStore, type SqlDatabase } from './config-store';
import { TaskDispatch } from './task-dispatch';
import { readCredentialAccounts, writeCredentialAccounts } from './credential-accounts';
import type { KeyRing } from './credential-envelope';
import { canonical, identifier, revision, ReliabilityError, type Json, type ConfigChange } from './protocol';

interface PolicyRow extends Record<string, unknown> { generation: string; observation_until: number }
export interface CredentialWrite { generation: string; epoch: number; expectedRevision: number; accounts: AccountEntry[] }
export interface CredentialPermit { generation: string; task: string; account: string; token: string; snapshot: string; credentialRevision: number }
const conflict = (): never => { throw new ReliabilityError('CONFLICT', 409); };
/** Global-only business adapter; all three stores MUST share this SQLite DB.
 * No HTTP/RPC surface. It does not establish caller identity or activate a generation.
 * The production coordinator must route ALL account commits through this boundary. */
export class CredentialAuthority {
    private readonly ring: KeyRing;
    constructor(private readonly db: SqlDatabase, private readonly config: ConfigStore, private readonly dispatch: TaskDispatch, ring: KeyRing, private readonly now: () => number = Date.now) {
        this.ring = { ...ring, keys: { ...ring.keys } };
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS credential_policy (generation TEXT PRIMARY KEY, observation_until INTEGER NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS credential_revocations (generation TEXT NOT NULL, account TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(generation,account,revision))');
        });
    }
    /** Only after verified import, while still in maintenance. The policy is immutable;
     * replays must match and cannot shorten the observation period. */
    async initialize(generation: string, epoch: number): Promise<{ observationUntil: number }> {
        identifier(generation); revision(epoch);
        const view = this.config.read(['accounts']);
        if (view.generation !== generation || view.epoch !== epoch || !view.records[0].revision) conflict();
        await readCredentialAccounts(view.records[0].value as unknown as AccountEntry[], this.ring);
        return this.db.transaction(() => {
            const meta = this.config.status();
            if (meta.generation !== generation || meta.epoch !== epoch || !meta.maintenance) conflict();
            const row = this.db.rows<{ revision: number }>('SELECT revision FROM config_records WHERE generation=? AND domain=?', generation, 'accounts')[0];
            if (row?.revision !== view.records[0].revision) conflict();
            // No queued/executing task may predate policy initialization.
            if (this.db.rows("SELECT seq FROM dispatch_outbox WHERE state!='terminal' LIMIT 1").length) conflict();
            const old = this.db.rows<PolicyRow>('SELECT * FROM credential_policy WHERE generation=?', generation)[0];
            if (old) return { observationUntil: old.observation_until };
            const now = this.now(); revision(now);
            const observationUntil = now + 7 * 24 * 60 * 60 * 1000; revision(observationUntil);
            this.db.rows('INSERT INTO credential_policy VALUES (?,?)', generation, observationUntil);
            return { observationUntil };
        });
    }
    private policy(generation: string): PolicyRow {
        const policy = this.db.rows<PolicyRow>('SELECT * FROM credential_policy WHERE generation=?', generation)[0];
        if (!policy) throw new ReliabilityError('NOT_READY', 503);
        return policy;
    }
    /** Import is a bulk credential operation, blocked for the entire observation
     * window even if its values happen to match. Callable inside the CAS transaction. */
    assertImportAllowed(generation: string, epoch: number): void {
        identifier(generation); revision(epoch);
        const meta = this.config.status(), now = this.now(); revision(now);
        if (meta.generation !== generation || meta.epoch !== epoch) conflict();
        if (meta.maintenance || now < this.policy(generation).observation_until) throw new ReliabilityError('MAINTENANCE', 409);
    }
    async write(input: CredentialWrite, beforeCommit?: () => void): Promise<{ revision: number }> {
        // Scalar authority comes from the authenticated coordinator, never from a
        // browser-provided CredentialPolicy or mutable reference after WebCrypto awaits.
        const { generation, epoch, expectedRevision } = input;
        identifier(generation); revision(epoch); revision(expectedRevision);
        const policy = this.policy(generation), view = this.config.read(['accounts']);
        if (view.generation !== generation || view.epoch !== epoch || view.records[0].revision !== expectedRevision) conflict();
        const existing = view.records[0].value as unknown as AccountEntry[];
        const all = this.config.readAll(); // Complete snapshot for removed-account override cleanup.
        const next = await writeCredentialAccounts(input.accounts, existing, { ring: this.ring, now: this.now(), observationUntil: policy.observation_until });
        const changed = new Set<string>();
        for (const old of existing) if (!next.some(a => a.accountId === old.accountId && a.credentialRevision === old.credentialRevision)) changed.add(old.accountId);
        for (const account of next) if (!existing.some(a => a.accountId === account.accountId && a.credentialRevision === account.credentialRevision)) changed.add(account.accountId);
        const removed = new Set(existing.filter(a => !next.some(n => n.accountId === a.accountId)).map(a => a.accountId));
        const cleanup: ConfigChange[] = all.records.filter(r => r.value !== null && r.domain.startsWith('override:') && removed.has(r.domain.split(':')[2]))
            .map(r => ({ domain: r.domain, expectedRevision: r.revision, value: null }));
        const records = this.config.compareAndSet(generation, [{ domain: 'accounts', expectedRevision, value: next as unknown as Json }, ...cleanup], {
            epoch, expected: [{ domain: 'accounts', revision: expectedRevision }, ...cleanup.map(r => ({ domain: r.domain, revision: r.expectedRevision }))],
            ...(removed.size ? { watermark: all.watermark } : {})
        }, () => {
            if (this.policy(generation).observation_until !== policy.observation_until) conflict();
            this.dispatch.assertAccountsIdle([...changed]);
            // Trusted synchronous application receipt, inside the credential CAS transaction.
            if (beforeCommit && beforeCommit() !== undefined) throw new ReliabilityError('INVALID', 400);
        });
        return { revision: records[0].revision };
    }
    private account(generation: string, account: string, credentialRevision: number): void {
        identifier(generation); identifier(account); revision(credentialRevision);
        if (!credentialRevision) throw new ReliabilityError('INVALID', 400);
        const meta = this.config.status();
        if (meta.generation !== generation) conflict();
        const row = this.db.rows<{ payload: string }>('SELECT payload FROM config_records WHERE generation=? AND domain=?', generation, 'accounts')[0];
        const accounts = row ? JSON.parse(row.payload) as AccountEntry[] : null;
        if (!Array.isArray(accounts) || !accounts.some(a => a.accountId === account && a.credentialRevision === credentialRevision)) conflict();
        this.policy(generation);
    }
    /** Revocation remains available during observation/maintenance. It neither deletes
     * credentials nor releases the permit; unknown work still requires reconciliation. */
    revoke(generation: string, account: string, credentialRevision: number): void {
        this.db.transaction(() => {
            this.account(generation, account, credentialRevision);
            this.db.rows('INSERT OR IGNORE INTO credential_revocations VALUES (?,?,?)', generation, account, credentialRevision);
        });
    }
    /** Internal read-only boundary, not a task permit or permission to mutate.
     * Reads are allowed in maintenance, but revoked/replaced credentials and stale
     * generation/epoch/account snapshots cannot start another external request. */
    authorizeRead(generation:string,epoch:number,accountsRevision:number,accounts:ReadonlyArray<{account:string;credentialRevision:number}>):void {
        identifier(generation);revision(epoch);revision(accountsRevision);
        this.db.transaction(()=>{
            const meta=this.config.status();
            const row=this.db.rows<{revision:number}>('SELECT revision FROM config_records WHERE generation=? AND domain=?',generation,'accounts')[0];
            if(meta.generation!==generation||meta.epoch!==epoch||row?.revision!==accountsRevision)conflict();
            this.policy(generation);
            for(const item of accounts){
                this.account(generation,item.account,item.credentialRevision);
                if(this.db.rows('SELECT revision FROM credential_revocations WHERE generation=? AND account=? AND revision=?',generation,item.account,item.credentialRevision).length)conflict();
            }
        });
    }
    /** Internal authorization for an independently authenticated read-only review.
     * Unlike mutation authorization it works in maintenance, but only for the original
     * outstanding permit and the captured current authority revision. It grants neither
     * an executor replay nor permission to settle/release the task. Call immediately
     * before each fixed GET and again before committing observation evidence. */
    authorizeReview(input: CredentialPermit, epoch: number, accountsRevision: number): void {
        const value: CredentialPermit = JSON.parse(canonical(input));
        if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'account,credentialRevision,generation,snapshot,task,token') throw new ReliabilityError('INVALID', 400);
        identifier(value.generation); identifier(value.task); identifier(value.account);
        identifier(value.token); identifier(value.snapshot); revision(value.credentialRevision);
        revision(epoch); revision(accountsRevision);
        if (!value.credentialRevision) throw new ReliabilityError('INVALID', 400);
        this.db.transaction(() => {
            const meta = this.config.status();
            const row = this.db.rows<{ revision: number }>('SELECT revision FROM config_records WHERE generation=? AND domain=?', value.generation, 'accounts')[0];
            if (meta.generation !== value.generation || meta.epoch !== epoch || row?.revision !== accountsRevision) conflict();
            this.account(value.generation, value.account, value.credentialRevision);
            this.dispatch.assertPermit(value.task, value.account, value.token, value.snapshot);
            if (this.db.rows('SELECT revision FROM credential_revocations WHERE generation=? AND account=? AND revision=?', value.generation, value.account, value.credentialRevision).length) conflict();
        });
    }
    /** To be called from the role-authenticated global RPC before each external write.
     * Maintenance blocks new mutation authorization. This is not a Cloudflare fence. */
    authorize(input: CredentialPermit): void {
        const value: CredentialPermit = JSON.parse(canonical(input));
        this.db.transaction(() => {
            this.account(value.generation, value.account, value.credentialRevision);
            if (this.config.status().maintenance) throw new ReliabilityError('MAINTENANCE', 503);
            this.dispatch.assertPermit(value.task, value.account, value.token, value.snapshot);
            if (this.db.rows('SELECT revision FROM credential_revocations WHERE generation=? AND account=? AND revision=?', value.generation, value.account, value.credentialRevision).length) conflict();
        });
    }
}
