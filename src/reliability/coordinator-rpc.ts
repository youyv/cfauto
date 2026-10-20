import { businessJson, MAX_SUBMIT_RPC_BYTES } from './business-limits';
import { canonical, identifier, revision, ReliabilityError, type Json } from './protocol';

export type RpcMethod = 'adjudicate' | 'authorize_adjudication' | 'account_archive' | 'authorize_account_archive' | 'review_observe' | 'authorize_review' | 'probe_drain' | 'release_drain' | 'read_external' | 'read_view' | 'cron_cycle' | 'deliver' | 'authorize' | 'snapshot' | 'progress' | 'complete' | 'submit_task' | 'inspect_task' | 'cancel_task' | 'wake_task' | 'list_tasks' | 'read_config' | 'edit_config' | 'cancel';
export type RpcDirection = 'global-account' | 'account-global' | 'gateway-global' | 'scheduler-global';
export interface RpcMessage { version: 1; direction: RpcDirection; account: string; method: RpcMethod; at: number; nonce: string; body: Json }
export interface AuthenticatedRpc extends RpcMessage { signature: string }
export type CoordinatorRole = { role: 'global' } | { role: 'account'; account: string };
export const GLOBAL_OBJECT_NAME = 'reliability-global-v1';
export function accountObjectName(account: string): string { identifier(account); return 'reliability-account-v1-' + account; }
const encoder = new TextEncoder();
function denied(): never { throw new ReliabilityError('INVALID', 403); }
const directions: Record<RpcMethod, RpcDirection> = { adjudicate:'global-account', authorize_adjudication:'account-global', account_archive:'global-account', authorize_account_archive:'account-global', review_observe: 'global-account', authorize_review: 'account-global', probe_drain: 'global-account', release_drain: 'global-account', read_external: 'gateway-global', read_view: 'gateway-global', cron_cycle: 'scheduler-global', deliver: 'global-account', authorize: 'account-global', snapshot: 'account-global', progress: 'account-global', complete: 'account-global', submit_task: 'gateway-global', inspect_task: 'gateway-global', cancel_task: 'gateway-global', wake_task: 'gateway-global', list_tasks: 'gateway-global', read_config: 'gateway-global', edit_config: 'gateway-global', cancel: 'global-account' };
function rpcJson(input: unknown): string {
    const limit = input && typeof input === 'object' && ['submit_task','read_external'].includes((input as RpcMessage).method) ? MAX_SUBMIT_RPC_BYTES : 131072;
    return businessJson(input, limit);
}
function validate(value: RpcMessage): void {
    if (!value || value.version !== 1 || !Object.hasOwn(directions, value.method) || directions[value.method] !== value.direction) denied();
    identifier(value.account); identifier(value.nonce); revision(value.at);
}
/** Binding-only authentication. The HMAC is domain/direction/account scoped and is not
 * a user session or an external fencing token. Replays in the 60s window are intentional:
 * receivers MUST durably deduplicate mutations and recheck permits on every read/write.
 * Never forward public requests to this endpoint or give the RPC secret to browsers. */
export class CoordinatorRpc {
    private readonly secret: string;
    constructor(secret: string, private readonly now: () => number = Date.now) {
        if (typeof secret !== 'string' || encoder.encode(secret).length < 32) denied();
        this.secret = secret;
    }
    private async key(direction: RpcDirection, account: string): Promise<CryptoKey> {
        const base = await crypto.subtle.importKey('raw', encoder.encode(this.secret), 'HKDF', false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('cfauto:coordinator-rpc:v1'), info: encoder.encode(canonical([direction, account])) }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    }
    async sign(method: RpcMethod, account: string, body: Json): Promise<AuthenticatedRpc> {
        const value: RpcMessage = JSON.parse(rpcJson({ version: 1, direction: directions[method], account, method, at: this.now(), nonce: crypto.randomUUID(), body }));
        validate(value);
        const bytes = await crypto.subtle.sign('HMAC', await this.key(value.direction, value.account), encoder.encode(canonical(value)));
        return { ...value, signature: Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('') };
    }
    async verify(input: unknown, isObject: (name: string) => boolean): Promise<{ message: RpcMessage; role: CoordinatorRole }> {
        try {
            const value = JSON.parse(rpcJson(input)) as AuthenticatedRpc;
            if (Object.keys(value).sort().join(',') !== 'account,at,body,direction,method,nonce,signature,version') denied();
            validate(value);
            const { signature, ...message } = value;
            if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) denied();
            const role: CoordinatorRole = value.direction === 'global-account' ? { role: 'account', account: value.account } : { role: 'global' };
            if (!isObject(role.role === 'global' ? GLOBAL_OBJECT_NAME : accountObjectName(role.account))) denied();
            const bytes = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
            if (!await crypto.subtle.verify('HMAC', await this.key(value.direction, value.account), bytes, encoder.encode(canonical(message)))) denied();
            // Recheck time after crypto awaits; do not return a signature, key or raw error.
            if (Math.abs(this.now() - value.at) > 60_000) denied();
            return { message, role };
        } catch { denied(); }
    }
    async request(method: RpcMethod, account: string, body: Json): Promise<Request> {
        return new Request('https://coordinator.internal/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await this.sign(method, account, body)) });
    }
}
/** Bounded streaming read: Content-Length is not trusted. Snapshot responses are not
 * accepted here. submit_task additionally carries a bounded user intent; all other
 * methods retain the original 128 KiB budget, before signature verification. */
export async function readRpcRequest(request: Request): Promise<unknown> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.origin !== 'https://coordinator.internal' || url.pathname !== '/v1' || url.search || request.headers.get('content-type') !== 'application/json' || !request.body) denied();
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.length;
            if (size > MAX_SUBMIT_RPC_BYTES) { await reader.cancel(); denied(); }
            chunks.push(value);
        }
        const all = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
        const input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(all));
        // Canonicalization removes whitespace; enforce the original raw-stream
        // bound too, so only submit_task/read_external can consume the expanded transport.
        if (!['submit_task','read_external'].includes(input?.method) && size > 131072) denied();
        rpcJson(input);
        return input;
    } catch { denied(); } finally { reader.releaseLock(); }
}
