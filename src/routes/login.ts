/**
 * 路由: 登录 — ACCESS_CODE 验证 + 速率限制
 */
import { jsonError, json, safeJson } from '../lib/cloudflare-api';
import { generateAuthToken } from '../middleware/auth';
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";

/** 速率限制配置 */
const LOGIN_RATE_LIMIT = { MAX_ATTEMPTS: 5, WINDOW_SECONDS: 300 };

export async function handleLogin(req: Request, env: AppEnv): Promise<Response> {
    try {
        // 速率限制：基于 CF-Connecting-IP（仅信任 Cloudflare 边缘节点传入的真实 IP）
        const clientIp = req.headers.get('CF-Connecting-IP') || 'unknown';
        const rateKey = 'RATE_LIMIT_' + clientIp;

        const attemptStr = await env.CONFIG_KV.get(rateKey);
        const attempts = attemptStr ? parseInt(attemptStr, 10) : 0;
        if (attempts >= LOGIN_RATE_LIMIT.MAX_ATTEMPTS) {
            return jsonError('登录尝试过于频繁，请 5 分钟后再试', 429);
        }
        await env.CONFIG_KV.put(rateKey, String(attempts + 1), { expirationTtl: LOGIN_RATE_LIMIT.WINDOW_SECONDS });

        const body = await safeJson(req);
        const correctCode = env.ACCESS_CODE;
        if (!correctCode) {
            return jsonError('未配置 ACCESS_CODE，请在 Cloudflare Dashboard → Workers & Pages → 设置 → 变量 中设置 ACCESS_CODE 密钥', 500);
        }
        if (body.code === correctCode) {
            const token = await generateAuthToken(correctCode);
            await env.CONFIG_KV.delete(rateKey);
            return json({ success: true }, {
                headers: {
                    'Set-Cookie': `__Host-auth=${token}; Path=/; HttpOnly; Secure; Max-Age=86400; SameSite=Lax`
                }
            });
        }
        return jsonError('密码错误', 401);
    } catch (err: any) {
        logger.error('Login error', err instanceof Error ? err : new Error(String(err)), { module: 'login' });
        return jsonError('登录服务异常', 500);
    }
}
