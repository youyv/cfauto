import { loginHtml } from '../config/login-html';
import { jsonError } from '../lib/cloudflare-api';
import type { AppEnv } from "../config/env";
/**
 * 认证中间件 — 登录页 + Cookie 认证 + CSRF
 */

export function requireAccessCode(env: AppEnv): Response | null {
    if (!env.ACCESS_CODE) {
        return jsonError(
            '未配置 ACCESS_CODE，请在 Cloudflare Dashboard → Workers & Pages → 设置 → 变量 中设置 ACCESS_CODE 密钥',
            500
        );
    }
    return null;
}

/** SHA-256 摘要 — 用于生成/验证 auth token，避免 Cookie 中直接存储明文密码 */
export async function generateAuthToken(accessCode: string): Promise<string> {
    const data = new TextEncoder().encode(accessCode);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 检查 Cookie 是否包含有效 auth token — 提取 auth 值，与 ACCESS_CODE 的 SHA-256 摘要精确比对，防止前缀绕过 */
export async function requireCookie(request: Request, env: AppEnv): Promise<Response | null> {
    const cookieHeader = request.headers.get('Cookie') || '';
    // 提取 auth= 的值进行精确比对，避免子串/前缀绕过
    const match = cookieHeader.match(/(?:^|;\s*)__Host-auth=([^;]*)/);
    const cookieValue = match ? match[1] : null;
    const expectedToken = await generateAuthToken(env.ACCESS_CODE!);
    if (cookieValue !== expectedToken) {
        return new Response(loginHtml(), {
            headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store, must-revalidate' }
        });
    }
    return null;
}

/** CSRF 防护 — 多层校验：Sec-Fetch-* 头 + Origin */
export function checkCsrf(request: Request, url: URL): Response | null {
    const WRITE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (WRITE_METHODS.includes(request.method)) {
        const secSite = request.headers.get('Sec-Fetch-Site');
        if (secSite && secSite !== 'same-origin' && secSite !== 'none') return jsonError('CSRF rejected (Sec-Fetch-Site)', 403);
        const origin = request.headers.get('Origin');
        try {
            if (origin && new URL(origin).host !== url.host) return jsonError('CSRF rejected (Origin)', 403);
        } catch (e) { console.error('[checkCsrf] Invalid Origin header:', e); return jsonError('CSRF rejected (Invalid Origin)', 403); }
    }
    return null;
}
