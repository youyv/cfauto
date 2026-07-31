import { describe, it, expect } from 'vitest';
import { generateRandomToken, timingSafeEqualStr, sha256Hex, sessionKey, requireCookie, checkCsrf, SESSION_TTL_SECONDS } from '../src/middleware/auth';
import { handleLogin } from '../src/routes/login';

// ============================================================
// 安全架构测试：会话 token / CSRF / 恒定时间比较 / 速率限制
// ============================================================

/** 内存 KV mock（模拟 Cloudflare KVNamespace） */
function mockKV(initial: Record<string, string> = {}) {
    const store = new Map<string, { value: string; ttl?: number }>();
    for (const [k, v] of Object.entries(initial)) store.set(k, { value: v });
    return {
        async get(key: string) { return store.has(key) ? store.get(key)!.value : null; },
        async put(key: string, value: string, opts?: { expirationTtl?: number }) {
            store.set(key, { value, ttl: opts?.expirationTtl });
        },
        async delete(key: string) { store.delete(key); },
        _store: store,
    };
}

function mockEnv(kv: any, accessCode = 'test-secret') {
    return { CONFIG_KV: kv, ACCESS_CODE: accessCode };
}

function jsonReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

describe('generateRandomToken / sessionKey', () => {
    it('生成 64 位 hex（32 字节）随机 token', () => {
        const t = generateRandomToken();
        expect(t).toMatch(/^[0-9a-f]{64}$/);
    });
    it('两次生成不同（随机性）', () => {
        expect(generateRandomToken()).not.toBe(generateRandomToken());
    });
    it('sessionKey 有唯一前缀', () => {
        expect(sessionKey('abc')).toBe('SESSION_abc');
    });
});

describe('timingSafeEqualStr', () => {
    it('相同字符串返回 true', () => {
        expect(timingSafeEqualStr('hello', 'hello')).toBe(true);
    });
    it('不同字符串返回 false', () => {
        expect(timingSafeEqualStr('hello', 'hellp')).toBe(false);
    });
    it('长度不同直接 false（不抛错）', () => {
        expect(timingSafeEqualStr('a', 'aa')).toBe(false);
    });
    it('空串处理', () => {
        expect(timingSafeEqualStr('', '')).toBe(true);
        expect(timingSafeEqualStr('', 'a')).toBe(false);
    });
});

describe('sha256Hex', () => {
    it('输出 64 位 hex 且确定性', async () => {
        const h1 = await sha256Hex('abc');
        const h2 = await sha256Hex('abc');
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('handleLogin — 会话与 CSRF 发放', () => {
    it('密码正确：返回 success + 双 cookie + KV 存会话（TTL 7 天）', async () => {
        const kv = mockKV();
        const res = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), mockEnv(kv) as any);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);

        const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        const cookieHeader = res.headers.get('Set-Cookie') || '';
        const joined = setCookies.length ? setCookies.join(' | ') : cookieHeader;
        expect(joined).toContain('__Host-auth=');
        expect(joined).toContain('__Host-csrf=');
        expect(joined).toContain('HttpOnly');
        expect(joined).toContain('SameSite=Lax');
        expect(joined).toContain('Max-Age=' + SESSION_TTL_SECONDS);

        const authToken = (joined.match(/__Host-auth=([^;]+)/) || [])[1];
        const csrfToken = (joined.match(/__Host-csrf=([^;]+)/) || [])[1];
        expect(authToken).toMatch(/^[0-9a-f]{64}$/);
        expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);
        expect(await kv.get(sessionKey(authToken))).toBe(csrfToken);
        expect(kv._store.get(sessionKey(authToken))?.ttl).toBe(SESSION_TTL_SECONDS);
    });

    it('密码错误：401 + 递增限流计数', async () => {
        const kv = mockKV();
        const env = mockEnv(kv) as any;
        const res = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'wrong' }), env);
        expect(res.status).toBe(401);
        expect(await kv.get('RATE_LIMIT_unknown')).toBe('1');
    });

    it('连续 5 次错误后 429 限流', async () => {
        const kv = mockKV();
        const env = mockEnv(kv) as any;
        for (let i = 0; i < 5; i++) {
            const r = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'wrong' }), env);
            expect(r.status).toBe(401);
        }
        const r6 = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'wrong' }), env);
        expect(r6.status).toBe(429);
    });

    it('登录成功后清空限流计数', async () => {
        const kv = mockKV({ RATE_LIMIT_unknown: '3' });
        const env = mockEnv(kv) as any;
        await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), env);
        expect(await kv.get('RATE_LIMIT_unknown')).toBeNull();
    });

    it('非法 JSON 不消耗限流配额（safeJson 先于计数）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv) as any;
        const req = new Request('https://x/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
        const res = await handleLogin(req, env);
        expect(res.status).toBe(400);
        expect(await kv.get('RATE_LIMIT_unknown')).toBeNull();
    });
});

describe('requireCookie — KV 会话校验', () => {
    it('无 cookie → 返回登录页', async () => {
        const kv = mockKV();
        const res = await requireCookie(jsonReq('GET', 'https://x/'), mockEnv(kv) as any);
        expect(res).not.toBeNull();
        expect(res!.headers.get('Content-Type')).toContain('text/html');
        expect(res!.headers.get('Content-Security-Policy')).toContain('frame-ancestors');
    });

    it('无效会话（token 不在 KV）→ 返回登录页', async () => {
        const kv = mockKV();
        const req = jsonReq('GET', 'https://x/', undefined, { Cookie: '__Host-auth=' + '0'.repeat(64) });
        const res = await requireCookie(req, mockEnv(kv) as any);
        expect(res).not.toBeNull();
    });

    it('有效会话 → 通过', async () => {
        const kv = mockKV();
        const env = mockEnv(kv) as any;
        const loginRes = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), env);
        const joined = (loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('Set-Cookie') || '']).join(' | ');
        const authToken = (joined.match(/__Host-auth=([^;]+)/) || [])[1];
        const req = jsonReq('GET', 'https://x/', undefined, { Cookie: '__Host-auth=' + authToken });
        const res = await requireCookie(req, env);
        expect(res).toBeNull();
    });
});

describe('checkCsrf — 写请求 token 校验', () => {
    async function loginAndGetTokens(kv: any) {
        const env = mockEnv(kv) as any;
        const loginRes = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), env);
        const joined = (loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('Set-Cookie') || '']).join(' | ');
        const authToken = (joined.match(/__Host-auth=([^;]+)/) || [])[1];
        const csrfToken = (joined.match(/__Host-csrf=([^;]+)/) || [])[1];
        return { env, authToken, csrfToken };
    }

    it('GET 请求跳过校验', async () => {
        const kv = mockKV();
        const { env } = await loginAndGetTokens(kv);
        const res = await checkCsrf(jsonReq('GET', 'https://x/api/stats'), new URL('https://x/'), env);
        expect(res).toBeNull();
    });

    it('写请求无 X-CSRF-Token → 403', async () => {
        const kv = mockKV();
        const { env, authToken } = await loginAndGetTokens(kv);
        const req = jsonReq('POST', 'https://x/api/deploy', {}, { Cookie: '__Host-auth=' + authToken });
        const res = await checkCsrf(req, new URL('https://x/'), env);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
    });

    it('写请求带错误 token → 403', async () => {
        const kv = mockKV();
        const { env, authToken } = await loginAndGetTokens(kv);
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': 'f'.repeat(64)
        });
        const res = await checkCsrf(req, new URL('https://x/'), env);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
    });

    it('写请求带正确 token → 通过', async () => {
        const kv = mockKV();
        const { env, authToken, csrfToken } = await loginAndGetTokens(kv);
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': csrfToken
        });
        const res = await checkCsrf(req, new URL('https://x/'), env);
        expect(res).toBeNull();
    });

    it('会话登出（KV 删除）后 token 失效 → 403', async () => {
        const kv = mockKV();
        const { env, authToken, csrfToken } = await loginAndGetTokens(kv);
        await kv.delete(sessionKey(authToken));
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': csrfToken
        });
        const res = await checkCsrf(req, new URL('https://x/'), env);
        expect(res).not.toBeNull();
        expect(res!.status).toBe(403);
    });
});
