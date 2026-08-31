/**
 * 测试辅助：内存 KV mock + env 构造 + Request 构造
 *
 * 所有测试都从这里取 KV mock，语义与 Cloudflare KVNamespace 一致
 * （包括 list 的 prefix 过滤与 expirationTtl 记录），从而可以直接 import
 * 真实的 src/ 模块而非在测试里复刻一份逻辑。
 */
import type { AppEnv, KVNamespace } from '../src/config/env';

export interface MockKV extends KVNamespace {
    _store: Map<string, { value: string; ttl?: number }>;
    _puts: number;
    _gets: number;
    _deletes: string[];
    /** 单次 list 返回的键数上限，模拟真实 KV 的 1000 条分页（测试里调小以便覆盖翻页） */
    _listPageSize: number;
}

export function mockKV(initial: Record<string, unknown> = {}): MockKV {
    const store = new Map<string, { value: string; ttl?: number }>();
    for (const [k, v] of Object.entries(initial)) {
        store.set(k, { value: typeof v === 'string' ? v : JSON.stringify(v) });
    }
    const kv: MockKV = {
        _store: store,
        _puts: 0,
        _gets: 0,
        _deletes: [],
        _listPageSize: 1000,
        async get(key: string) {
            kv._gets++;
            return store.has(key) ? store.get(key)!.value : null;
        },
        async put(key: string, value: string, opts?: { expirationTtl?: number }) {
            kv._puts++;
            store.set(key, { value, ttl: opts?.expirationTtl });
        },
        async delete(key: string) { kv._deletes.push(key); store.delete(key); },
        /**
         * 语义对齐真实 KV：按前缀过滤 + 分页（`list_complete` / `cursor`）。
         * 此前这里一次性返回全部键且不带 list_complete，任何「只读第一页」的 bug
         * 在测试里都是绿的 —— backup 与 KV 回收都依赖完整枚举。
         */
        async list(opts?: { prefix?: string; cursor?: string }) {
            const prefix = opts?.prefix || '';
            const all = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
            const start = opts?.cursor ? parseInt(opts.cursor, 10) || 0 : 0;
            const page = all.slice(start, start + kv._listPageSize);
            const end = start + page.length;
            const complete = end >= all.length;
            return {
                keys: page.map(name => ({ name })),
                list_complete: complete,
                ...(complete ? {} : { cursor: String(end) })
            };
        }
    };
    return kv;
}

/** 读取 mock KV 中的 JSON 值（测试断言用） */
export function readKV<T = any>(kv: MockKV, key: string): T | null {
    const entry = kv._store.get(key);
    if (!entry) return null;
    try { return JSON.parse(entry.value) as T; } catch { return entry.value as unknown as T; }
}

export function mockEnv(kv: MockKV, extra: Partial<AppEnv> = {}): AppEnv {
    return { CONFIG_KV: kv, ACCESS_CODE: 'test-secret', ...extra } as AppEnv;
}

export function jsonReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Request {
    return new Request(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
}

/** 把 Response 的 Set-Cookie 头合并成一个字符串（跨运行时兼容） */
export function joinSetCookies(res: Response): string {
    const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
    const list = typeof anyHeaders.getSetCookie === 'function' ? anyHeaders.getSetCookie() : [];
    return list.length ? list.join(' | ') : (res.headers.get('Set-Cookie') || '');
}

/** 构造一个 CF API 风格的成功响应 */
export function cfOk(result: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        status: 200, headers: { 'Content-Type': 'application/json' }, ...init
    });
}

/** 构造一个 CF API 风格的失败响应 */
export function cfErr(status: number, message: string, code = 1000): Response {
    return new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), {
        status, headers: { 'Content-Type': 'application/json' }
    });
}

/** 构造一个 HTML 错误页响应（模拟网关/限流页，res.json() 会抛错） */
export function htmlErr(status: number): Response {
    return new Response('<html><body>Gateway Error</body></html>', {
        status, headers: { 'Content-Type': 'text/html' }
    });
}

/** 请求记录 */
export interface FetchCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

/**
 * 安装 fetch 桩：按 URL 子串匹配的路由表决定响应。
 * 返回 { calls, restore }，测试结束务必 restore()。
 */
export function stubFetch(
    routes: Array<{ match: string | RegExp; respond: (call: FetchCall) => Response | Promise<Response> }>,
    fallback?: (call: FetchCall) => Response | Promise<Response>
) {
    const calls: FetchCall[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const headers: Record<string, string> = {};
        const rawHeaders = (init && init.headers) || {};
        if (rawHeaders instanceof Headers) rawHeaders.forEach((v, k) => { headers[k] = v; });
        else Object.entries(rawHeaders as Record<string, string>).forEach(([k, v]) => { headers[k] = String(v); });
        const call: FetchCall = {
            url,
            method: ((init && init.method) || 'GET').toUpperCase(),
            headers,
            body: typeof init?.body === 'string' ? init.body : undefined
        };
        calls.push(call);
        for (const r of routes) {
            const hit = typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url);
            if (hit) return r.respond(call);
        }
        if (fallback) return fallback(call);
        throw new Error('stubFetch: 未匹配的请求 ' + call.method + ' ' + url);
    }) as typeof fetch;
    return {
        calls,
        restore() { globalThis.fetch = original; }
    };
}
