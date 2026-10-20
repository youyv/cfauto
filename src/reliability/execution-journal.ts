import { MAX_SCRIPT_RESPONSE_BYTES } from './payload-limits';
import { emptyWorkerDeleteResponse } from './cloudflare-response-contract';
import type { SqlDatabase } from './config-store';
import { SealedStore, type SealedContext } from './sealed-store';
import { canonical, identifier, ReliabilityError, type Json } from './protocol';

const encoder = new TextEncoder();
export class ExecutionUnknown extends Error { constructor() { super('EXECUTION_NEEDS_REVIEW'); } }
export class ExecutionReadFailure extends Error { constructor() { super('EXECUTION_READ_FAILED'); } }
interface CallRow extends Record<string, unknown> { job: string; ordinal: number; digest: string; mutation: number; state: string }
interface RecordedResponse { digest: string; status: number; statusText: string; headers: [string, string][]; body: string }
export interface JournalIdentity { job: string; account: string; generation: string }
/** Sensitive decrypted evidence for trusted review code only; never a public response. */
export interface JournalCallEvidence { identity: JournalIdentity; ordinal: number; digest: string; mutation: boolean; state: string; request: Json }
export interface JournalOptions {
    /** Stable, independent HMAC key; retain while this journal is referenced. */
    digestSecret: string;
    transport: (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
    /** Verify the persisted global permit and credential revision immediately before writes. */
    authorizeMutation: () => Promise<void>;
}
function encode64(bytes: Uint8Array): string {
    let s = ''; for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096)); return btoa(s);
}
function decode64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
/** Normalize multipart entries rather than random HTTP boundary bytes. Preserve order,
 * file names/types and every byte; auth/query/body enter only a secret-keyed digest. */
async function requestValue(url: string, init: RequestInit = {}): Promise<Json> {
    const headers = Array.from(new Headers(init.headers).entries()).sort((a, b) => a[0].localeCompare(b[0]));
    let body: Json = null;
    if (init.body instanceof FormData) {
        const entries: Json[] = [];
        for (const [name, value] of init.body.entries()) entries.push(typeof value === 'string'
            ? [name, 'text', value]
            : [name, 'file', value.name, value.type, encode64(new Uint8Array(await value.arrayBuffer()))]);
        body = entries;
    } else if (init.body !== undefined && init.body !== null) {
        if (typeof init.body === 'string') body = ['text', init.body];
        else if (init.body instanceof URLSearchParams) body = ['urlencoded', init.body.toString()];
        else if (init.body instanceof Blob) body = ['blob', init.body.type, encode64(new Uint8Array(await init.body.arrayBuffer()))];
        else if (init.body instanceof ArrayBuffer) body = ['bytes', encode64(new Uint8Array(init.body))];
        else if (ArrayBuffer.isView(init.body)) body = ['bytes', encode64(new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength))];
        else throw new ReliabilityError('INVALID', 400); // Streaming requests cannot be replayed safely.
    }
    return [url, (init.method || 'GET').toUpperCase(), headers, body] as Json;
}
function isMutation(url: URL, init: RequestInit): boolean {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return false;
    // Existing stats use GraphQL POST queries. Mutations must not hide here.
    if (url.origin === 'https://api.cloudflare.com' && url.pathname === '/client/v4/graphql' && method === 'POST' && typeof init.body === 'string') {
        try { const value = JSON.parse(init.body); if (typeof value.query === 'string' && !/\bmutation\b/i.test(value.query)) return false; } catch { /* reject below */ }
    }
    return true;
}
function freezeInit(init: RequestInit): RequestInit {
    let body = init.body;
    if (body instanceof FormData) { const copy = new FormData(); for (const [name, value] of body.entries()) copy.append(name, value); body = copy; }
    else if (body instanceof URLSearchParams) body = new URLSearchParams(body);
    else if (body instanceof ArrayBuffer) body = body.slice(0);
    else if (ArrayBuffer.isView(body)) body = new Uint8Array(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return { ...init, headers: new Headers(init.headers), body, redirect: 'manual' };
}
function replay(value: RecordedResponse): Response {
    return new Response([101, 204, 205, 304].includes(value.status) ? null : decode64(value.body), { status: value.status, statusText: value.statusText, headers: value.headers });
}
/** Per-account deterministic HTTP journal. A replay returns saved responses, NEVER
 * repeats a recorded write. An in-flight write without an authenticated response is
 * unknown and blocks every subsequent call until explicit reconciliation.
 * Must execute from one immutable input snapshot. No production route is exposed here. */
export class ExecutionJournal {
    private cursor = 0;
    private tail: Promise<unknown> = Promise.resolve();
    private blocked = false;
    private readonly identity: JournalIdentity;
    private readonly options: JournalOptions;
    constructor(private readonly db: SqlDatabase, private readonly sealed: SealedStore, identity: JournalIdentity, options: JournalOptions) {
        identifier(identity.job); identifier(identity.account); identifier(identity.generation);
        if (typeof options.digestSecret !== 'string' || encoder.encode(options.digestSecret).length < 32) throw new ReliabilityError('INVALID', 400);
        this.identity = { ...identity }; this.options = { ...options };
        db.transaction(() => {
            db.rows('CREATE TABLE IF NOT EXISTS execution_calls (job TEXT NOT NULL, ordinal INTEGER NOT NULL, digest TEXT NOT NULL, mutation INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(job,ordinal))');
        });
    }
    private context(ordinal: number): SealedContext {
        return { id: 'response_' + this.identity.job + '_' + ordinal, kind: 'task_snapshot', account: this.identity.account, generation: this.identity.generation };
    }
    private requestContext(ordinal: number): SealedContext {
        return { ...this.context(ordinal), id: 'request_' + this.identity.job + '_' + ordinal };
    }
    /** Read evidence without executor replay, HTTP, state repair, or permission changes.
     * Legacy calls without captured evidence fail closed; do not reconstruct them by
     * running the executor. The caller must independently check current review authority. */
    async readCallEvidence(ordinal: number): Promise<JournalCallEvidence> {
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 500) throw new ReliabilityError('INVALID', 400);
        const row = this.db.rows<CallRow>('SELECT * FROM execution_calls WHERE job=? AND ordinal=?', this.identity.job, ordinal)[0];
        if (!row) throw new ReliabilityError('NOT_READY', 404);
        const saved = await this.sealed.get(this.requestContext(ordinal)) as { schema: number; identity: Json; ordinal: number; digest: string; mutation: boolean; request: Json };
        if (!saved || saved.schema !== 1 || canonical(saved.identity) !== canonical(this.identity) || saved.ordinal !== ordinal || saved.digest !== row.digest || Number(saved.mutation) !== row.mutation || await this.digest(saved.request) !== row.digest) throw new ReliabilityError('CONFLICT', 409);
        const current = this.db.rows<CallRow>('SELECT * FROM execution_calls WHERE job=? AND ordinal=?', this.identity.job, ordinal)[0];
        // Crypto awaits must not produce evidence for a changed journal row.
        if (!current || canonical({ ...current }) !== canonical({ ...row })) throw new ReliabilityError('CONFLICT', 409);
        return { identity: { ...this.identity }, ordinal, digest: row.digest, mutation: !!row.mutation, state: row.state, request: saved.request };
    }
    private async digest(value: Json): Promise<string> {
        const key = await crypto.subtle.importKey('raw', encoder.encode(this.options.digestSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(canonical(['cfauto-http-journal-v1', this.identity, value])));
        return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    }
    private block(): never { this.blocked = true; throw new ExecutionUnknown(); }
    private async saved(ordinal: number, digest: string): Promise<Response | null> {
        try { this.sealed.info(this.context(ordinal)); }
        catch (error) { if (error instanceof ReliabilityError && error.code === 'NOT_READY') return null; return this.block(); }
        let value: RecordedResponse;
        try { value = await this.sealed.get(this.context(ordinal)) as unknown as RecordedResponse; }
        catch { return this.block(); }
        if (value.digest !== digest) return this.block();
        try {
            const response = replay(value);
            this.db.rows("UPDATE execution_calls SET state='done' WHERE job=? AND ordinal=?", this.identity.job, ordinal);
            return response;
        } catch { return this.block(); }
    }
    /** Serialize callbacks too: old business helpers may launch a Promise.all. Their
     * deterministic iteration order becomes journal order, not network completion order. */
    request(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
            this.blocked = true;
            return Promise.reject(new ReliabilityError('INVALID', 400));
        }
        const ordinal = this.cursor++;
        init = freezeInit(init);
        const result = this.tail.then(() => this.execute(ordinal, url, init, timeoutMs));
        this.tail = result.catch(() => undefined);
        return result;
    }
    private async execute(ordinal: number, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        if (this.blocked || ordinal >= 500) return this.block();
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return this.block();
        const mutation = isMutation(parsed, init);
        if (mutation && !(parsed.origin === 'https://api.cloudflare.com' && parsed.pathname.startsWith('/client/v4/accounts/' + this.identity.account + '/'))) return this.block();
        const request = await requestValue(url, init);
        const digest = await this.digest(request);
        const row = this.db.rows<CallRow>('SELECT * FROM execution_calls WHERE job=? AND ordinal=?', this.identity.job, ordinal)[0];
        if (row) {
            if (row.digest !== digest || row.mutation !== Number(mutation)) return this.block();
            if (row.state === 'read_failed') throw new ExecutionReadFailure();
            const response = await this.saved(ordinal, digest);
            if (response) return response;
            if (row.state === 'done' || row.state === 'unknown' || mutation) return this.block();
            // Interrupted read has no external side effect and can safely be issued again.
        }
        // Capture original URL/method/headers/body as encrypted evidence BEFORE send.
        // A captured request alone never proves transport started or an effect occurred.
        try {
            await this.sealed.put(this.requestContext(ordinal), { schema: 1, identity: { ...this.identity }, ordinal, digest, mutation, request });
        } catch { return this.block(); }
        if (mutation) {
            // Recheck after sealing: encryption may yield to revocation/maintenance.
            try { await this.options.authorizeMutation(); } catch { return this.block(); }
        }
        const current = this.db.rows<CallRow>('SELECT * FROM execution_calls WHERE job=? AND ordinal=?', this.identity.job, ordinal)[0];
        if (canonical(current ? { ...current } : null) !== canonical(row ? { ...row } : null)) return this.block();
        this.db.rows("INSERT INTO execution_calls VALUES (?,?,?,?,'in_flight') ON CONFLICT(job,ordinal) DO UPDATE SET state='in_flight'", this.identity.job, ordinal, digest, Number(mutation));
        // One wall-clock deadline covers headers AND body. Abort is best effort: a
        // timed-out write remains unknown even if the transport ignores cancellation.
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (init.signal?.aborted) controller.abort();
        else init.signal?.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeoutMs);
        });
        const cleanup = () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); };
        let response: Response;
        try { response = await Promise.race([this.options.transport(url, { ...init, signal: controller.signal }, timeoutMs), deadline]); }
        catch {
            cleanup();
            this.db.rows('UPDATE execution_calls SET state=? WHERE job=? AND ordinal=?', mutation ? 'unknown' : 'read_failed', this.identity.job, ordinal);
            if (mutation) return this.block();
            throw new ExecutionReadFailure();
        }
        let body: Uint8Array;
        const reader = response.body?.getReader();
        try {
            // Bound response storage while streaming, including a lying/missing Content-Length.
            const chunks: Uint8Array[] = []; let size = 0;
            if (reader) while (true) {
                const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
                size += chunk.value.length;
                const scriptRead=(init.method||'GET').toUpperCase()==='GET'&&new URL(url).origin==='https://api.cloudflare.com'&&/^\/client\/v4\/accounts\/[a-f0-9]{32}\/workers\/scripts\/[a-z0-9][a-z0-9-]{0,62}(?:\/content)?$/.test(new URL(url).pathname);
                if (size > (scriptRead ? MAX_SCRIPT_RESPONSE_BYTES : 3 * 1024 * 1024)) throw new Error('size');
                chunks.push(chunk.value);
            }
            cleanup();
            body = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
            if (mutation) {
                // Gateway failure/timeout does not prove that a write was rejected.
                if (response.status >= 500 || response.status === 408) return this.block();
                if (response.ok && !emptyWorkerDeleteResponse(url,init.method || 'GET',response.status,body.byteLength)) {
                    const result = JSON.parse(new TextDecoder().decode(body));
                    if (typeof result?.success !== 'boolean') return this.block();
                }
            }
            const recorded: RecordedResponse = { digest, status: response.status, statusText: response.statusText, headers: Array.from(response.headers.entries()), body: encode64(body) };
            await this.sealed.put(this.context(ordinal), recorded as unknown as Json);
            this.db.rows("UPDATE execution_calls SET state='done' WHERE job=? AND ordinal=?", this.identity.job, ordinal);
            return replay(recorded);
        } catch {
            if (mutation) return this.block();
            // A local persistence failure must not be hidden as a successful read.
            return this.block();
        } finally {
            cleanup();
            // Never await an uncooperative underlying source cancellation.
            if (reader) void reader.cancel().catch(() => undefined);
        }
    }
    /** Call after the handler, even if it caught exceptions. Detects early-return replay
     * drift and unacknowledged writes instead of letting legacy catches report success. */
    async finish(): Promise<void> {
        await this.tail;
        const rows = this.db.rows<CallRow>('SELECT * FROM execution_calls WHERE job=? ORDER BY ordinal', this.identity.job);
        if (this.blocked || rows.length !== this.cursor || rows.some(r => !['done', 'read_failed'].includes(r.state))) this.block();
    }
    unresolved(): { ordinal: number; mutation: boolean; state: string }[] {
        return this.db.rows<CallRow>("SELECT ordinal,mutation,state FROM execution_calls WHERE job=? AND state NOT IN ('done','read_failed') ORDER BY ordinal", this.identity.job).map(r => ({ ordinal: r.ordinal, mutation: !!r.mutation, state: r.state }));
    }
}
