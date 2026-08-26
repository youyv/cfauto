import { describe, it, expect } from 'vitest';
import { generateRandomToken, timingSafeEqualStr, sha256Hex, sessionKey, requireCookie, checkCsrf, requireAccessCode, SESSION_TTL_SECONDS } from '../src/middleware/auth';
import { handleLogin } from '../src/routes/login';
import { loginResponse } from '../src/config/login-html';
import { mockKV, mockEnv, jsonReq, joinSetCookies, type MockKV } from './helpers';

// ============================================================
// 安全架构测试：会话 token / CSRF / 恒定时间比较 / 速率限制
// ============================================================

describe('generateRandomToken / sessionKey', () => {
    it('生成 64 位 hex（32 字节）随机 token', () => {
        expect(generateRandomToken()).toMatch(/^[0-9a-f]{64}$/);
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
    it('多字节字符按字节比较（不因编码长度差异抛错）', () => {
        expect(timingSafeEqualStr('世界', '世界')).toBe(true);
        expect(timingSafeEqualStr('世界', '世昦')).toBe(false);
    });
});

describe('sha256Hex', () => {
    it('输出 64 位 hex 且确定性', async () => {
        const h1 = await sha256Hex('abc');
        expect(h1).toBe(await sha256Hex('abc'));
        expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('requireAccessCode', () => {
    it('未配置 ACCESS_CODE → 500 且给出可操作提示', async () => {
        const res = requireAccessCode(mockEnv(mockKV(), { ACCESS_CODE: undefined }));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(500);
        expect((await res!.json() as any).msg).toContain('ACCESS_CODE');
    });
    it('已配置 → 通过', () => {
        expect(requireAccessCode(mockEnv(mockKV()))).toBeNull();
    });
});

describe('handleLogin — 会话与 CSRF 发放', () => {
    it('密码正确：返回 success + 双 cookie + KV 存会话（TTL 7 天）', async () => {
        const kv = mockKV();
        const res = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), mockEnv(kv));
        expect(res.status).toBe(200);
        expect((await res.json() as any).success).toBe(true);

        const joined = joinSetCookies(res);
        expect(joined).toContain('__Host-auth=');
        expect(joined).toContain('__Host-csrf=');
        expect(joined).toContain('HttpOnly');
        expect(joined).toContain('Secure');
        expect(joined).toContain('SameSite=Lax');
        expect(joined).toContain('Max-Age=' + SESSION_TTL_SECONDS);

        const authToken = (joined.match(/__Host-auth=([^;]+)/) || [])[1];
        const csrfToken = (joined.match(/__Host-csrf=([^;]+)/) || [])[1];
        expect(authToken).toMatch(/^[0-9a-f]{64}$/);
        expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);
        expect(authToken).not.toBe(csrfToken);
        expect(await kv.get(sessionKey(authToken))).toBe(csrfToken);
        expect(kv._store.get(sessionKey(authToken))?.ttl).toBe(SESSION_TTL_SECONDS);
    });

    it('CSRF cookie 不带 HttpOnly（前端 JS 需要读它）', async () => {
        const res = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), mockEnv(mockKV()));
        const cookies = joinSetCookies(res).split(' | ');
        const csrfCookie = cookies.find(c => c.includes('__Host-csrf='));
        expect(csrfCookie).toBeDefined();
        expect(csrfCookie).not.toContain('HttpOnly');
    });

    it('两次登录生成不同会话（不复用 token）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        const a = joinSetCookies(await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), env));
        const b = joinSetCookies(await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), env));
        expect((a.match(/__Host-auth=([^;]+)/) || [])[1]).not.toBe((b.match(/__Host-auth=([^;]+)/) || [])[1]);
    });

    it('密码错误：401 + 递增限流计数', async () => {
        const kv = mockKV();
        const res = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'wrong' }), mockEnv(kv));
        expect(res.status).toBe(401);
        expect(await kv.get('RATE_LIMIT_unknown')).toBe('1');
    });

    it('连续 5 次错误后 429 限流', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        for (let i = 0; i < 5; i++) {
            expect((await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'wrong' }), env)).status).toBe(401);
        }
        expect((await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'wrong' }), env)).status).toBe(429);
    });

    it('限流按 CF-Connecting-IP 分桶（不同 IP 互不影响）', async () => {
        const kv = mockKV();
        const env = mockEnv(kv);
        for (let i = 0; i < 5; i++) {
            await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'wrong' }, { 'CF-Connecting-IP': '1.1.1.1' }), env);
        }
        // 另一个 IP 仍可尝试
        const other = await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'wrong' }, { 'CF-Connecting-IP': '2.2.2.2' }), env);
        expect(other.status).toBe(401);
    });

    it('登录成功后清空限流计数', async () => {
        const kv = mockKV({ RATE_LIMIT_unknown: '3' });
        await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), mockEnv(kv));
        expect(await kv.get('RATE_LIMIT_unknown')).toBeNull();
    });

    it('非法 JSON 不消耗限流配额（防跨站表单耗尽受害者配额）', async () => {
        const kv = mockKV();
        const req = new Request('https://x/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
        const res = await handleLogin(req, mockEnv(kv));
        expect(res.status).toBe(400);
        expect(await kv.get('RATE_LIMIT_unknown')).toBeNull();
    });

    it('未配置 ACCESS_CODE → 500 而非放行', async () => {
        const res = await handleLogin(
            jsonReq('POST', 'https://x/api/login', { code: 'anything' }),
            mockEnv(mockKV(), { ACCESS_CODE: undefined })
        );
        expect(res.status).toBe(500);
    });

    it('code 缺失/非字符串不会误通过', async () => {
        const env = mockEnv(mockKV());
        expect((await handleLogin(jsonReq('POST', 'https://x/api/login', {}), env)).status).toBe(401);
        expect((await handleLogin(jsonReq('POST', 'https://x/api/login', { code: null }), env)).status).toBe(401);
    });
});

describe('requireCookie — KV 会话校验', () => {
    async function login(kv: MockKV) {
        const env = mockEnv(kv);
        const joined = joinSetCookies(await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), env));
        return {
            env,
            authToken: (joined.match(/__Host-auth=([^;]+)/) || [])[1],
            csrfToken: (joined.match(/__Host-csrf=([^;]+)/) || [])[1]
        };
    }

    it('页面请求无 cookie → 返回登录页 HTML', async () => {
        const res = await requireCookie(jsonReq('GET', 'https://x/'), mockEnv(mockKV()));
        expect(res).not.toBeNull();
        expect(res!.headers.get('Content-Type')).toContain('text/html');
        expect(res!.headers.get('Content-Security-Policy')).toContain('frame-ancestors');
    });

    it('API 请求无 cookie → 401 JSON（而非 HTML，避免前端 r.json() 报误导性错误）', async () => {
        const res = await requireCookie(jsonReq('GET', 'https://x/api/accounts'), mockEnv(mockKV()));
        expect(res).not.toBeNull();
        expect(res!.status).toBe(401);
        expect(res!.headers.get('Content-Type')).toContain('application/json');
        const body: any = await res!.json();
        expect(body.success).toBe(false);
        expect(body.code).toBe('AUTH_FAILED');
    });

    it('无效会话（token 不在 KV）→ 拦截', async () => {
        const req = jsonReq('GET', 'https://x/', undefined, { Cookie: '__Host-auth=' + '0'.repeat(64) });
        expect(await requireCookie(req, mockEnv(mockKV()))).not.toBeNull();
    });

    it('cookie 前缀绕过无效（__Host-authX 不被当作 __Host-auth）', async () => {
        const kv = mockKV();
        const { env, authToken } = await login(kv);
        const req = jsonReq('GET', 'https://x/', undefined, { Cookie: '__Host-authX=' + authToken });
        expect(await requireCookie(req, env)).not.toBeNull();
    });

    it('有效会话 → 通过', async () => {
        const kv = mockKV();
        const { env, authToken } = await login(kv);
        const req = jsonReq('GET', 'https://x/', undefined, { Cookie: '__Host-auth=' + authToken });
        expect(await requireCookie(req, env)).toBeNull();
    });

    it('多 cookie 场景下能正确提取', async () => {
        const kv = mockKV();
        const { env, authToken, csrfToken } = await login(kv);
        const req = jsonReq('GET', 'https://x/', undefined, {
            Cookie: 'other=1; __Host-auth=' + authToken + '; __Host-csrf=' + csrfToken
        });
        expect(await requireCookie(req, env)).toBeNull();
    });
});

describe('checkCsrf — 写请求 token 校验', () => {
    async function loginAndGetTokens(kv: MockKV) {
        const env = mockEnv(kv);
        const joined = joinSetCookies(await handleLogin(jsonReq('POST', 'https://x/api/login', { code: 'test-secret' }), env));
        return {
            env,
            authToken: (joined.match(/__Host-auth=([^;]+)/) || [])[1],
            csrfToken: (joined.match(/__Host-csrf=([^;]+)/) || [])[1]
        };
    }

    it('GET / HEAD 请求跳过校验', async () => {
        const { env } = await loginAndGetTokens(mockKV());
        expect(await checkCsrf(jsonReq('GET', 'https://x/api/stats'), new URL('https://x/'), env)).toBeNull();
        expect(await checkCsrf(jsonReq('HEAD', 'https://x/api/stats'), new URL('https://x/'), env)).toBeNull();
    });

    it('写请求无 X-CSRF-Token → 403', async () => {
        const { env, authToken } = await loginAndGetTokens(mockKV());
        const req = jsonReq('POST', 'https://x/api/deploy', {}, { Cookie: '__Host-auth=' + authToken });
        const res = await checkCsrf(req, new URL('https://x/'), env);
        expect(res!.status).toBe(403);
    });

    it('写请求带错误 token → 403', async () => {
        const { env, authToken } = await loginAndGetTokens(mockKV());
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': 'f'.repeat(64)
        });
        expect((await checkCsrf(req, new URL('https://x/'), env))!.status).toBe(403);
    });

    it('写请求无会话 cookie → 403', async () => {
        const { env, csrfToken } = await loginAndGetTokens(mockKV());
        const req = jsonReq('POST', 'https://x/api/deploy', {}, { 'X-CSRF-Token': csrfToken });
        expect((await checkCsrf(req, new URL('https://x/'), env))!.status).toBe(403);
    });

    it('写请求带正确 token → 通过', async () => {
        const { env, authToken, csrfToken } = await loginAndGetTokens(mockKV());
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': csrfToken
        });
        expect(await checkCsrf(req, new URL('https://x/'), env)).toBeNull();
    });

    it('跨站 Sec-Fetch-Site → 403（纵深防御，早于 token 校验）', async () => {
        const { env, authToken, csrfToken } = await loginAndGetTokens(mockKV());
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': csrfToken,
            'Sec-Fetch-Site': 'cross-site'
        });
        const res = await checkCsrf(req, new URL('https://x/'), env);
        expect(res!.status).toBe(403);
        expect((await res!.json() as any).msg).toContain('Sec-Fetch-Site');
    });

    it('Origin 不匹配 → 403', async () => {
        const { env, authToken, csrfToken } = await loginAndGetTokens(mockKV());
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': csrfToken,
            Origin: 'https://evil.example.com'
        });
        expect((await checkCsrf(req, new URL('https://x/'), env))!.status).toBe(403);
    });

    it('Origin 非法字符串 → 403（不因 URL 解析异常放行）', async () => {
        const { env, authToken, csrfToken } = await loginAndGetTokens(mockKV());
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': csrfToken,
            Origin: 'not-a-url'
        });
        expect((await checkCsrf(req, new URL('https://x/'), env))!.status).toBe(403);
    });

    it('same-origin 与 none 放行（正常同源请求与地址栏直达）', async () => {
        const { env, authToken, csrfToken } = await loginAndGetTokens(mockKV());
        for (const site of ['same-origin', 'none']) {
            const req = jsonReq('POST', 'https://x/api/deploy', {}, {
                Cookie: '__Host-auth=' + authToken,
                'X-CSRF-Token': csrfToken,
                'Sec-Fetch-Site': site
            });
            expect(await checkCsrf(req, new URL('https://x/'), env)).toBeNull();
        }
    });

    it('会话登出（KV 删除）后 token 失效 → 403', async () => {
        const kv = mockKV();
        const { env, authToken, csrfToken } = await loginAndGetTokens(kv);
        await kv.delete(sessionKey(authToken));
        const req = jsonReq('POST', 'https://x/api/deploy', {}, {
            Cookie: '__Host-auth=' + authToken,
            'X-CSRF-Token': csrfToken
        });
        expect((await checkCsrf(req, new URL('https://x/'), env))!.status).toBe(403);
    });

    it('PUT / DELETE / PATCH 同样受保护', async () => {
        const { env, authToken } = await loginAndGetTokens(mockKV());
        for (const m of ['PUT', 'DELETE', 'PATCH']) {
            const req = jsonReq(m, 'https://x/api/x', {}, { Cookie: '__Host-auth=' + authToken });
            expect((await checkCsrf(req, new URL('https://x/'), env))!.status, m).toBe(403);
        }
    });
});

// ============================================================
// 登录页：CSP nonce 而非 unsafe-inline
// ============================================================
describe('loginResponse — CSP', () => {
    it('内联脚本用 nonce 授权，CSP 不含 unsafe-inline', async () => {
        const res = loginResponse();
        const csp = res.headers.get('Content-Security-Policy')!;
        expect(csp).not.toContain('unsafe-inline');
        expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9]+'/);
        const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9]+)'/)![1];
        const html = await res.text();
        expect(html).toContain('<script nonce="' + nonce + '">');
        expect(html).toContain('<style nonce="' + nonce + '">');
    });

    it('每次响应 nonce 不同（防重放固定 nonce）', () => {
        const a = loginResponse().headers.get('Content-Security-Policy')!;
        const b = loginResponse().headers.get('Content-Security-Policy')!;
        expect(a).not.toBe(b);
    });

    it('带完整安全头且不可缓存', () => {
        const res = loginResponse();
        expect(res.headers.get('X-Frame-Options')).toBe('DENY');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(res.headers.get('Cache-Control')).toContain('no-store');
    });
});
