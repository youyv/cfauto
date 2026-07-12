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
    userTokenVerify:()                               => `${CF_API}/user/tokens/verify`,
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

/** 标准化错误码 — 便于前端区分错误类型 */
export type ErrorCode = 'AUTH_FAILED' | 'KV_NOT_BOUND' | 'GITHUB_API_ERROR' | 'CF_API_ERROR' | 'VALIDATION_ERROR' | 'RATE_LIMITED';

/** 安全解析 JSON，支持泛型类型推断 */
export async function safeJson<T = any>(req: Request): Promise<T> {
    try { return await req.json() as T; }
    catch (e) { console.error('[safeJson] JSON parse failed:', e); throw new Response(JSON.stringify({ success: false, msg: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
}

/** 统一 JSON 错误响应 */
export function jsonError(msg: string, status = 500, code?: ErrorCode) {
    const body = { success: false, msg, ...(code ? { code } : {}) };
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
}
/** 统一 JSON 成功响应 */
export function json(data: unknown, statusOrInit?: number | ResponseInit): Response {
    if (typeof statusOrInit === 'number') {
        return new Response(JSON.stringify(data), {
            status: statusOrInit,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
    const init = statusOrInit || {} as ResponseInit;
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (!headers.has('Access-Control-Allow-Origin')) {
        headers.set('Access-Control-Allow-Origin', '*');
    }
    return new Response(JSON.stringify(data), { ...init, headers });
}
