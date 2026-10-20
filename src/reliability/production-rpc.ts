import { accountId, shape } from './business-command';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME, accountObjectName, type RpcMethod } from './coordinator-rpc';
import { canonical, ReliabilityError, type Json } from './protocol';
import { MAX_SEALED_BYTES, MAX_SEALED_PLAINTEXT_BYTES } from './sealed-store';

/** Per-method wall budgets. Business admission and automation cycles resolve and
 * seal upstream source synchronously inside the DO (observed >15s in production
 * for a 5.14 MiB source across 9 targets), so they need a longer — still bounded —
 * deadline. A stuck binding must never hang a panel request indefinitely. */
export const RPC_DEADLINE_MS: Partial<Record<RpcMethod, number>> = Object.freeze({ submit_task: 90000, cron_cycle: 90000, read_external: 60000 });

/** Binding-only client; not a public URL proxy. Bound headers/body share a deadline.
 * Lost responses are retried only by persistent inbox/outbox logic, never here. */
export async function sendCoordinatorRpc(namespace: DurableObjectNamespace, rpc: CoordinatorRpc, method: RpcMethod, account: string, body: Json): Promise<Json> {
    accountId(account);
    const businessMethod = ['adjudicate','authorize_adjudication','account_archive','authorize_account_archive','review_observe','authorize_review','read_view','read_external','submit_task','inspect_task','cancel_task','wake_task','list_tasks','read_config','edit_config'].includes(method);
    const name = ['adjudicate','deliver','cancel','probe_drain','release_drain','review_observe','account_archive'].includes(method) ? accountObjectName(account) : GLOBAL_OBJECT_NAME;
    const request = await rpc.request(method, account, body);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadlineMs = RPC_DEADLINE_MS[method] ?? 15000;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ReliabilityError('NOT_READY', 503)); }, deadlineMs); });
    try {
        const pending = namespace.get(namespace.idFromName(name)).fetch(new Request(request, { signal: controller.signal }));
        // A late response must not leak an unread stream after Promise.race timed out.
        void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
        const response = await Promise.race([pending, deadline]);
        reader = response.body?.getReader();
        if (!reader || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('rpc');
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
            const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
            size += chunk.value.length; if (size > (['snapshot','read_external'].includes(method) ? MAX_SEALED_PLAINTEXT_BYTES : MAX_SEALED_BYTES) + 65536) throw new Error('rpc'); chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
        if (!response.ok) {
            // Business refusals are safe protocol codes, not provider errors. Keep
            // 409/maintenance meaningful to the UI instead of silently retrying.
            if (businessMethod) {
                shape(envelope, 'error');
                const allowed: Record<number, string[]> = { 400: ['INVALID'], 403: ['INVALID'], 404: ['NOT_READY'], 409: ['CONFLICT','MAINTENANCE'], 503: ['MAINTENANCE','NOT_READY'] };
                if (allowed[response.status]?.includes(envelope.error)) throw new ReliabilityError(envelope.error, response.status);
            }
            throw new Error('rpc');
        }
        shape(envelope, 'value'); canonical(envelope.value);
        return envelope.value as Json;
    } catch (error) {
        if (businessMethod && error instanceof ReliabilityError) throw error;
        throw new ReliabilityError('NOT_READY', 503);
    }
    finally { if (timer !== undefined) clearTimeout(timer); if (reader) void reader.cancel().catch(() => undefined); }
}
