import {SourceInterner} from './shared-source';
import { parseBusinessRequest, type BusinessRequest } from './business-planner';
import { ConfigStore, type SqlDatabase } from './config-store';
import { SealedStore, type SealedContext } from './sealed-store';
import { businessJson, MAX_SUBMIT_RPC_BYTES } from './business-limits';
import { encoded, identifier, ReliabilityError, type Json } from './protocol';
import { shape, invalid } from './business-command';
import type { PreparedTaskInput } from './task-preparation';
import { TaskDispatch } from './task-dispatch';

interface AdmissionRow extends Record<string, unknown> { id: string; receipt: string; digest: string; owner: string; generation: string; task: string | null; error: string | null }
interface Manifest extends Omit<PreparedTaskInput, 'targets'> { targets: { account: string; ordinal: number }[] }
const conflict = (): never => { throw new ReliabilityError('CONFLICT', 409); };
const unavailable = (): never => { throw new ReliabilityError('NOT_READY', 503); };
const context = (row: AdmissionRow): SealedContext => ({ id: row.id, kind: 'artifact', account: 'admission', generation: row.generation });
const targetContext = (row: AdmissionRow, account: string, ordinal: number): SealedContext => ({ id: row.id + '_' + ordinal, kind: 'artifact', account, generation: row.generation });

/** Authenticated intent boundary on the GLOBAL DB. Durable HMAC intent identity is
 * checked before config reads, source resolution, random values or snapshot creation.
 * A finalized manifest precedes task submission. After a lost ACK/restart the SAME
 * plan is submitted, never a fresh latest/config snapshot. A crash before the manifest
 * is finalized fails closed (no accepted task); an operator may use a NEW intent key.
 * All retained admissions/artifacts are immutable; no timeout cleanup or KV fallback.
 * Scope is a trusted installation principal, NOT a browser field or raw session token. */
export class BusinessAdmission<Intent extends { key: string } = BusinessRequest> {
    private readonly secret: Uint8Array;
    private readonly inflight = new Map<string, Promise<{ id: string; duplicate: boolean }>>();
    constructor(private readonly db: SqlDatabase, private readonly config: ConfigStore, private readonly sealed: SealedStore,
        private readonly dispatch: TaskDispatch, private readonly planner: { prepare(scope: string, input: Intent): Promise<PreparedTaskInput> },
        private readonly submitPlan: (input: PreparedTaskInput) => Promise<{ id: string; duplicate: boolean }>, secret: Uint8Array, private readonly parseInput: (input: unknown) => Intent = parseBusinessRequest as unknown as (input: unknown) => Intent) {
        if (!(secret instanceof Uint8Array) || secret.length < 32) throw new ReliabilityError('INVALID', 400);
        this.secret = new Uint8Array(secret);
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS business_admission_key (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL)');
            db.rows('CREATE TABLE IF NOT EXISTS business_admissions (id TEXT PRIMARY KEY, receipt TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, owner TEXT NOT NULL, generation TEXT NOT NULL, task TEXT UNIQUE, error TEXT)');
            db.rows('CREATE INDEX IF NOT EXISTS business_admission_listing ON business_admissions(owner)');
            db.rows('CREATE INDEX IF NOT EXISTS business_admission_owner ON business_admissions(owner,task)');
        });
    }
    private async mac(label: string, value: unknown): Promise<string> {
        const key = await crypto.subtle.importKey('raw', new Uint8Array(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(businessJson(['cfauto-business-admission-v1', label, value], MAX_SUBMIT_RPC_BYTES)));
        return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    }
    private async identity(scope: string): Promise<{ owner: string; fingerprint: string }> {
        identifier(scope);
        return { owner: await this.mac('owner', scope), fingerprint: await this.mac('key-check', []) };
    }
    private checkKey(fingerprint: string): void {
        const saved = this.db.rows<{ fingerprint: string }>('SELECT fingerprint FROM business_admission_key WHERE id=1')[0];
        if (saved && saved.fingerprint !== fingerprint) conflict();
        if (!saved) this.db.rows('INSERT INTO business_admission_key VALUES (1,?)', fingerprint);
    }
    async submit(scope: string, input: unknown): Promise<{ id: string; duplicate: boolean }> {
        identifier(scope);
        const request = this.parseInput(input);
        const { owner, fingerprint } = await this.identity(scope);
        const receipt = await this.mac('receipt', [scope, request.key]), digest = await this.mac('intent', [scope, request]);
        const reservation = this.db.transaction(() => {
            this.checkKey(fingerprint);
            const old = this.db.rows<AdmissionRow>('SELECT * FROM business_admissions WHERE receipt=?', receipt)[0];
            if (old) { if (old.digest !== digest || old.owner !== owner) conflict(); return { row: old, fresh: false }; }
            const status = this.config.status();
            if (status.maintenance) throw new ReliabilityError('MAINTENANCE', 503);
            if (!status.generation) return unavailable();
            if (this.db.rows<{ n: number }>('SELECT COUNT(*) AS n FROM business_admissions WHERE task IS NULL AND error IS NULL')[0].n >= 500) conflict();
            const row: AdmissionRow = { id: 'admission_' + crypto.randomUUID(), receipt, digest, owner, generation: status.generation, task: null, error: null };
            this.db.rows('INSERT INTO business_admissions VALUES (?,?,?,?,?,NULL,NULL)', row.id, receipt, digest, owner, row.generation);
            return { row, fresh: true };
        });
        if (reservation.row.task) return { id: reservation.row.task, duplicate: true };
        if (reservation.row.error) this.failure(reservation.row.error);
        const running = this.inflight.get(receipt);
        if (running) { const result = await running; return { id: result.id, duplicate: true }; }
        const pending = this.finish(scope, request, reservation.row, reservation.fresh);
        this.inflight.set(receipt, pending);
        try { return await pending; } finally { if (this.inflight.get(receipt) === pending) this.inflight.delete(receipt); }
    }
    private failure(code: string): never {
        if (code === 'INVALID') throw new ReliabilityError('INVALID', 400);
        if (code === 'CONFLICT') conflict();
        if (code === 'MAINTENANCE') throw new ReliabilityError('MAINTENANCE', 503);
        return unavailable();
    }
    private async restore(row: AdmissionRow): Promise<PreparedTaskInput | null> {
        if (!this.db.rows('SELECT id FROM sealed_objects WHERE id=?', row.id).length) return null;
        const value = await this.sealed.get(context(row));
        const manifest = value as unknown as Manifest;
        shape(manifest, 'scope,key,generation,epoch,expected,targets' + (Object.hasOwn(manifest,'changes') ? ',changes' : '') + (Object.hasOwn(manifest,'deployment') ? ',deployment' : ''));
        if (manifest.generation !== row.generation || !Array.isArray(manifest.targets) || !manifest.targets.length || manifest.targets.length > 20) conflict();
        const targets: PreparedTaskInput['targets'] = [];
        const interner = new SourceInterner();
        for (const [ordinal, ref] of manifest.targets.entries()) {
            shape(ref, 'account,ordinal'); if (ref.ordinal !== ordinal) conflict();
            const target = await this.sealed.get(targetContext(row, ref.account, ordinal)) as unknown as PreparedTaskInput['targets'][number];
            if (!target || target.account !== ref.account) conflict();
            interner.apply(target); targets.push(target);
        }
        return { ...manifest, targets };
    }
    private async finish(scope: string, request: Intent, row: AdmissionRow, fresh: boolean): Promise<{ id: string; duplicate: boolean }> {
        let plan = await this.restore(row);
        if (!plan) {
            if (!fresh) return unavailable(); // Interrupted pre-manifest attempt, never re-plan it.
            try {
                plan = await this.planner.prepare(scope, request);
                if (plan.generation !== row.generation) conflict();
                const refs: Manifest['targets'] = [];
                for (const [ordinal, target] of plan.targets.entries()) {
                    await this.sealed.put(targetContext(row, target.account, ordinal), target as unknown as Json);
                    refs.push({ account: target.account, ordinal });
                }
                await this.sealed.put(context(row), { ...plan, targets: refs } as unknown as Json);
            } catch (error) {
                // No task has been submitted yet. Preserve a stable, non-secret refusal.
                const code = error instanceof ReliabilityError ? error.code : 'NOT_READY';
                this.db.rows('UPDATE business_admissions SET error=? WHERE id=? AND task IS NULL', code, row.id);
                return this.failure(code);
            }
        }
        if (plan.scope !== scope || plan.key !== request.key) conflict();
        const result = await this.submitPlan(plan);
        this.db.transaction(() => {
            const current = this.db.rows<AdmissionRow>('SELECT * FROM business_admissions WHERE id=?',row.id)[0];
            if (!current || (current.task !== null && current.task !== result.id)) conflict();
            this.db.rows('UPDATE business_admissions SET task=? WHERE id=?', result.id, row.id);
        });
        return result;
    }
    /** Keyset pagination over recorded admissions. Status is live, not a historical
     * snapshot. Cursor MAC binds the principal and position; no offset/SQL/raw key. */
    async list(scope: string, input: unknown): Promise<Json> {
        let copied: unknown;
        try { copied = JSON.parse(encoded(input)); } catch { return invalid(); }
        shape(copied,'limit,cursor');
        if (!Number.isSafeInteger(copied.limit) || copied.limit < 1 || copied.limit > 50 || (copied.cursor !== null && typeof copied.cursor !== 'string')) invalid();
        const { owner, fingerprint } = await this.identity(scope);
        let before = Number.MAX_SAFE_INTEGER;
        if (copied.cursor !== null) {
            const cursor = /^v1\.([1-9][0-9]{0,15})\.([a-f0-9]{64})$/.exec(copied.cursor);
            if (!cursor) return invalid();
            if (!Number.isSafeInteger(Number(cursor[1])) || cursor[2] !== await this.mac('list-cursor',[owner,Number(cursor[1])])) invalid();
            before = Number(cursor[1]);
        }
        const rows = this.db.transaction(() => {
            this.checkKey(fingerprint);
            return this.db.rows<{ position: number; task: string }>('SELECT rowid AS position,task FROM business_admissions WHERE owner=? AND task IS NOT NULL AND rowid<? ORDER BY rowid DESC LIMIT ?',owner,before,copied.limit+1)
                .map(row => ({...row,targets:this.dispatch.inspect(row.task).map(target=>({...target,cancellationRequested:this.dispatch.cancelRequested(row.task,target.account)}))}));
        });
        const more = rows.length > copied.limit, page = rows.slice(0,copied.limit), position = page.at(-1)?.position;
        const cursor = more && position !== undefined ? 'v1.'+position+'.'+await this.mac('list-cursor',[owner,position]) : null;
        return { items:page.map(row=>({id:row.task,targets:row.targets})),cursor };
    }
    /** Maintenance inventory, separately scoped from normal task pagination. Stored
     * root existence is NOT a claim that all manifest chunks validate or no task ran. */
    async listIncomplete(scope:string,input:unknown):Promise<Json> {
        const value=JSON.parse(encoded(input));shape(value,'limit,cursor');
        if(!Number.isSafeInteger(value.limit)||value.limit<1||value.limit>50||(value.cursor!==null&&typeof value.cursor!=='string'))invalid();
        const {owner,fingerprint}=await this.identity(scope);this.readKey(fingerprint);
        let before=Number.MAX_SAFE_INTEGER;
        if(value.cursor!==null){const match=/^pending1\.([1-9][0-9]{0,15})\.([a-f0-9]{64})$/.exec(value.cursor);if(!match||!Number.isSafeInteger(Number(match[1]))||match[2]!==await this.mac('pending-cursor',[owner,Number(match[1])]))invalid();before=Number(match![1]);}
        const rows=this.db.transaction(()=>{this.readKey(fingerprint);return this.db.rows<AdmissionRow&{position:number;stored:number}>('SELECT a.rowid AS position,a.*,EXISTS(SELECT 1 FROM sealed_objects s WHERE s.id=a.id) AS stored FROM business_admissions a WHERE a.owner=? AND a.task IS NULL AND a.rowid<? ORDER BY a.rowid DESC LIMIT ?',owner,before,value.limit+1);});
        const page=rows.slice(0,value.limit),last=page.at(-1)?.position,cursor=rows.length>value.limit&&last!==undefined?'pending1.'+last+'.'+await this.mac('pending-cursor',[owner,last]):null;
        return {items:page.map(r=>({id:r.id,generation:r.generation,error:r.error,manifestStored:!!r.stored,taskBackfillMissing:true})),cursor};
    }
    private readKey(fingerprint:string):void {
        const stored=this.db.rows<{fingerprint:string}>('SELECT fingerprint FROM business_admission_key WHERE id=1')[0];
        if(stored?stored.fingerprint!==fingerprint:this.db.rows('SELECT id FROM business_admissions LIMIT 1').length>0)conflict();
    }
    /** Explicitly authenticated maintenance recovery; never calls the planner. Missing
     * manifests retain their reservation/error. A complete plan is replayed with its
     * original source, random identities and CAS, even if task backfill lost its ACK. */
    async recover(scope:string,id:string):Promise<{id:string;duplicate:boolean}> {
        identifier(id);const {owner,fingerprint}=await this.identity(scope);this.readKey(fingerprint);
        const row=this.db.rows<AdmissionRow>('SELECT * FROM business_admissions WHERE id=? AND owner=?',id,owner)[0];
        if(!row)throw new ReliabilityError('NOT_READY',404);if(row.task)return {id:row.task,duplicate:true};
        const active=this.inflight.get(row.receipt);if(active){const result=await active;return {id:result.id,duplicate:true};}
        const pending=this.recoverOnce(scope,row,fingerprint);this.inflight.set(row.receipt,pending);
        try{return await pending;}finally{if(this.inflight.get(row.receipt)===pending)this.inflight.delete(row.receipt);}
    }
    private async recoverOnce(scope:string,row:AdmissionRow,fingerprint:string):Promise<{id:string;duplicate:boolean}> {
        const plan=await this.restore(row);if(!plan)return unavailable();
        if(plan.scope!==scope||row.receipt!==await this.mac('receipt',[scope,plan.key]))conflict();
        // Resolve the old stable identity before any submission, not by interpreting
        // task=NULL as never admitted. Exact submit verifies frozen snapshots/digest;
        // only genuinely unsubmitted plans encounter the original config CAS barrier.
        const existing=await this.dispatch.lookupReceipt(scope,plan.key);
        this.readKey(fingerprint);
        const current=this.db.rows<AdmissionRow>('SELECT * FROM business_admissions WHERE id=?',row.id)[0];
        if(!current||current.owner!==row.owner||current.receipt!==row.receipt||current.digest!==row.digest||current.generation!==row.generation)conflict();
        if(current.task){if(existing?.id!==current.task)conflict();return {id:current.task,duplicate:true};}
        const result=await this.submitPlan(plan);if(existing&&result.id!==existing.id)conflict();
        this.db.transaction(()=>{this.readKey(fingerprint);const latest=this.db.rows<AdmissionRow>('SELECT * FROM business_admissions WHERE id=?',row.id)[0];if(!latest||latest.receipt!==row.receipt||latest.owner!==row.owner||(latest.task!==null&&latest.task!==result.id))conflict();this.db.rows('UPDATE business_admissions SET task=? WHERE id=?',result.id,row.id);});
        return result;
    }
    /** Internal catalog ownership key; never forwarded to an HTTP response. */
    async ownerForCatalog(scope:string):Promise<string> { const identity=await this.identity(scope);this.checkKey(identity.fingerprint);return identity.owner; }
    async inspect(scope: string, id: string): Promise<Json> {
        identifier(scope); identifier(id);
        const { owner, fingerprint } = await this.identity(scope);
        return this.db.transaction(() => {
            this.checkKey(fingerprint);
            // Uniform 404: task IDs do not confer access, even on this internal boundary.
            if (!this.db.rows('SELECT id FROM business_admissions WHERE task=? AND owner=?', id, owner).length) throw new ReliabilityError('NOT_READY', 404);
            const targets = this.dispatch.inspect(id).map(target => {
                const row = this.db.rows<{ steps: string }>('SELECT steps FROM dispatch_outbox WHERE task=? AND account=?',id,target.account)[0];
                const facts = this.db.rows<{ ordinal: number; state: string }>('SELECT ordinal,state FROM business_step_state WHERE task=? AND account=? ORDER BY ordinal',id,target.account);
                return { ...target, cancellationRequested: this.dispatch.cancelRequested(id,target.account), steps: (JSON.parse(row.steps) as string[]).map((kind,ordinal) => ({ ordinal, kind, state: facts.find(f => f.ordinal === ordinal)?.state || 'pending' })) };
            });
            return { id, targets };
        });
    }
}
