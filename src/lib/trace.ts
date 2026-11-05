import type { AppEnv } from '../config/env';
import { logger } from './logger';
export interface TraceContext { id: string; source: string; }
/** Invocation-local data, never a mutable global or an incoming caller-controlled ID. */
export function tracedEnv(env: AppEnv, source: string): AppEnv {
    return { ...env, traceContext: { id: 'req_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24), source } };
}
export function traceEvent(env: AppEnv, stage: string, meta: Record<string, unknown> = {}): void {
    if (env.traceContext) logger.info(stage, { ...meta, taskId: env.traceContext.id, source: env.traceContext.source });
}
export function traceResponse(response: Response, env: AppEnv): Response {
    const headers = new Headers(response.headers);
    if (env.traceContext) headers.set('X-Request-ID', env.traceContext.id);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
