/**
 * 路由: 登录 — ACCESS_CODE 验证 + 速率限制 + 会话/CSRF token 发放
 */
import { jsonError, json, safeJson } from '../lib/cloudflare-api';
import { generateRandomToken, sha256Hex, timingSafeEqualStr, SESSION_TTL_SECONDS, sessionKey } from '../middleware/auth';
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";

/** 速率限制配置 */
const LOGIN_RATE_LIMIT = { MAX_ATTEMPTS: 5, WINDOW_SECONDS: 300 };

export async function handleLogin(req: Request, env: AppEnv): Promise<Response> {
    try {
        const body = await safeJson(req);
        const correctCode = env.ACCESS_CODE;
        if (!correctCode) {
            return jsonError('未配置 ACCESS_CODE，请在 Cloudflare Dashboard → Workers & Pages → 设置 → 变量 中设置 ACCESS_CODE 密钥', 500);
        }

        // 恒定时间比较：双方 SHA-256 摘要后逐字节异或，避免时序侧信道
        const [h1, h2] = await Promise.all([sha256Hex(String(body.code || '')), sha256Hex(correctCode)]);
        const ok = timingSafeEqualStr(h1, h2);
        if (!ok) {
            // 限流计数只在密码错误时递增（解析失败/垃圾请求不消耗配额，防跨站表单耗尽受害者配额）
            const clientIp = req.headers.get('CF-Connecting-IP') || 'unknown';
            const rateKey = 'RATE_LIMIT_' + clientIp;
            const attemptStr = await env.CONFIG_KV.get(rateKey);
            const attempts = attemptStr ? parseInt(attemptStr, 10) : 0;
            if (attempts >= LOGIN_RATE_LIMIT.MAX_ATTEMPTS) {
                return jsonError('登录尝试过于频繁，请 5 分钟后再试', 429);
            }
            await env.CONFIG_KV.put(rateKey, String(attempts + 1), { expirationTtl: LOGIN_RATE_LIMIT.WINDOW_SECONDS });
            return jsonError('密码错误', 401);
        }

        // 成功：生成会话 token + CSRF token，会话存 KV（TTL 7 天，登出可撤销）
        const authToken = generateRandomToken();
        const csrfToken = generateRandomToken();
        await env.CONFIG_KV.put(sessionKey(authToken), csrfToken, { expirationTtl: SESSION_TTL_SECONDS });

        // 清空限流计数
        const clientIp = req.headers.get('CF-Connecting-IP') || 'unknown';
        await env.CONFIG_KV.delete('RATE_LIMIT_' + clientIp).catch(() => { /* 无计数则忽略 */ });

        return json({ success: true }, {
            headers: [
                ['Set-Cookie', `__Host-auth=${authToken}; Path=/; HttpOnly; Secure; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax`],
                ['Set-Cookie', `__Host-csrf=${csrfToken}; Path=/; Secure; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax`]
            ]
        });
    } catch (err: any) {
        // 保留 safeJson 抛出的 400 Response
        if (err instanceof Response) return err;
        logger.error('Login error', err instanceof Error ? err : new Error(String(err)), { module: 'login' });
        return jsonError('登录服务异常', 500);
    }
}
