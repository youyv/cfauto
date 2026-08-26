import { logger } from './logger';
/**
 * Cloudflare API 工具 — URL 构建器 + 认证头
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

export const cf = {
    workerScript:   (aid: string, name: string)      => `${CF_API}/accounts/${aid}/workers/scripts/${name}`,
    workerBindings: (aid: string, name: string)      => `${CF_API}/accounts/${aid}/workers/scripts/${name}/bindings`,
    workerSubdomain:(aid: string, name: string)      => `${CF_API}/accounts/${aid}/workers/scripts/${name}/subdomain`,
    workerDomains:  (aid: string)                    => `${CF_API}/accounts/${aid}/workers/domains`,
    acctSubdomain:  (aid: string)                    => `${CF_API}/accounts/${aid}/workers/subdomain`,
    workerScripts:  (aid: string)                    => `${CF_API}/accounts/${aid}/workers/scripts`,
    kvNamespaces:   (aid: string)                    => `${CF_API}/accounts/${aid}/storage/kv/namespaces`,
    kvNamespace:    (aid: string, nsId: string)      => `${CF_API}/accounts/${aid}/storage/kv/namespaces/${nsId}`,
    kvValue:        (aid: string, nsId: string, key: string) => `${CF_API}/accounts/${aid}/storage/kv/namespaces/${nsId}/values/${key}`,
    zones:          (aid: string)                    => `${CF_API}/zones?account.id=${aid}&per_page=50`,
    /** 账号详情 — 支持 Global API Key 认证，可同时验证凭据有效性与 accountId 归属。
     *  注意：不要用 /user/tokens/verify，它只支持 API Token（Bearer），
     *  用 X-Auth-Key 调用会返回 400 "Missing Authorization header"。 */
    account:        (aid: string)                    => `${CF_API}/accounts/${aid}`,
    graphql:        ()                               => `${CF_API}/graphql`,
};


/** 带超时的 fetch 封装 — 默认 15s，防止挂起耗尽 Worker CPU 预算 */
export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 15000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

/** 获取 CF API 认证头，upload=true 时不含 Content-Type（由 FormData 自动设置） */
export function getAuthHeaders(email: string, key: string, upload = false) {
    const base = { "X-Auth-Email": email, "X-Auth-Key": key };
    return upload ? base : { ...base, "Content-Type": "application/json" };
}

/**
 * 读取上游 API 响应体 — 非 2xx 或非 JSON 一律抛出带上游错误消息的 Error。
 *
 * 直接 `await res.json()` 而不判 res.ok 是本项目历史上最常见的静默失败源：
 * CF/GitHub 出错时返回的 HTML 错误页会让 json() 抛 TypeError，被外层 catch 吞掉后
 * 只剩一句无信息的 "xxx failed"。此处统一解析 CF 的 errors[0].message 作为诊断。
 */
export async function readApiJson<T = any>(res: Response, context: string): Promise<T> {
    if (!res.ok) {
        let detail = 'HTTP ' + res.status;
        try {
            const body: any = await res.json();
            const upstream = body?.errors?.[0]?.message || body?.message;
            if (upstream) detail = upstream + ' (HTTP ' + res.status + ')';
        } catch (e) {
            // 错误响应非 JSON（HTML 错误页/网关页），保留 HTTP 状态码作为唯一线索
            logger.warn('readApiJson: error response is not JSON', { context, status: res.status });
        }
        throw new Error(context + ': ' + detail);
    }
    try {
        return await res.json() as T;
    } catch (e) {
        throw new Error(context + ': 上游返回的不是合法 JSON');
    }
}

/** 读取 CF API 的 `result` 字段 — 包装 readApiJson，省去每处的 `as any).result` */
export async function readApiResult<T = any>(res: Response, context: string): Promise<T> {
    const body = await readApiJson<{ result?: T }>(res, context);
    return body.result as T;
}

/** 标准化错误码 — 便于前端区分错误类型 */
export type ErrorCode = 'AUTH_FAILED' | 'KV_NOT_BOUND' | 'GITHUB_API_ERROR' | 'CF_API_ERROR' | 'VALIDATION_ERROR' | 'RATE_LIMITED';

/** 安全解析 JSON，支持泛型类型推断 */
export async function safeJson<T = any>(req: Request): Promise<T> {
    try { return await req.json() as T; }
    catch (e) { logger.error('JSON parse failed', e instanceof Error ? e : new Error(String(e)), { module: 'cloudflare-api' }); throw new Response(JSON.stringify({ success: false, msg: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
}

/** 统一 JSON 错误响应 */
export function jsonError(msg: string, status = 500, code?: ErrorCode) {
    const body = { success: false, msg, ...(code ? { code } : {}) };
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }
    });
}
/** 统一 JSON 成功响应 */
export function json(data: unknown, statusOrInit?: number | ResponseInit): Response {
    if (typeof statusOrInit === 'number') {
        return new Response(JSON.stringify(data), {
            status: statusOrInit,
            headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }
        });
    }
    const init = statusOrInit || {} as ResponseInit;
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
    if (!headers.has('X-Frame-Options')) headers.set('X-Frame-Options', 'DENY');
    return new Response(JSON.stringify(data), { ...init, headers });
}
