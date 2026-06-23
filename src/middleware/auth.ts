import { loginHtml } from '../config/login-html';
import type { AppEnv } from "../config/env";
/**
 * 认证中间件 — 登录页 + Cookie 认证 + CSRF
 */

export function requireAccessCode(env: AppEnv): Response | null {
    if (!env.ACCESS_CODE) {
        return new Response(
            '未配置 ACCESS_CODE，请在 Cloudflare Dashboard → Workers & Pages → 设置 → 变量 中设置 ACCESS_CODE 密钥',
            { status: 503 }
        );
    }
    return null;
}

/** 检查 Cookie 是否包含有效 auth token — 精确比对 auth 值，防止前缀绕过 */
export function requireCookie(request: Request, env: AppEnv): Response | null {
    const cookieHeader = request.headers.get('Cookie') || '';
    // 提取 auth= 的值进行精确比对，避免子串/前缀绕过
    const match = cookieHeader.match(/(?:^|;\s*)auth=([^;]*)/);
    const cookieValue = match ? match[1] : null;
    if (cookieValue !== env.ACCESS_CODE) {
        return new Response(loginHtml(), {
            headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store, must-revalidate' }
        });
    }
    return null;
}

/** CSRF 防护 — POST 请求校验 Origin 与 Host 一致 */
export function checkCsrf(request: Request, url: URL): Response | null {
    if (request.method === 'POST') {
        const origin = request.headers.get('Origin');
        if (origin && new URL(origin).host !== url.host) {
            return new Response(JSON.stringify({ success: false, msg: 'CSRF rejected' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
    return null;
}
