import { loginResponse } from '../config/login-html';
import { jsonError } from '../lib/cloudflare-api';
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";
/**
 * 认证中间件 — 登录页 + Cookie 会话认证 + CSRF token
 *
 * 会话模型：
 *  - 登录成功生成 32B 随机 auth token + 32B 随机 CSRF token
 *  - KV: SESSION_<authToken> = <csrfToken>（TTL 7 天），登出时删除
 *  - Cookie: __Host-auth（HttpOnly，仅认证用）
 *  - CSRF: 前端从非 HttpOnly 的 __Host-csrf cookie 读取，写请求带 X-CSRF-Token 头
 */

/** 会话 TTL：7 天 */
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

/** KV 会话键 */
export function sessionKey(authToken: string): string {
    return 'SESSION_' + authToken;
}

/** 生成 32B 加密安全随机 token（hex） */
export function generateRandomToken(): string {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 恒定时间字符串比较（Web Crypto 无 timingSafeEqual，用不短路的逐字节异或） */
export function timingSafeEqualStr(a: string, b: string): boolean {
    const ba = new TextEncoder().encode(a);
    const bb = new TextEncoder().encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

/** SHA-256 摘要（hex）— 用于登录密码与存储值的安全比较 */
export async function sha256Hex(input: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 从 Cookie 提取 __Host-auth 值，避免子串/前缀绕过 */
function extractAuthCookie(request: Request): string | null {
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/(?:^|;\s*)__Host-auth=([^;]*)/);
    return match ? match[1] : null;
}

export function requireAccessCode(env: AppEnv): Response | null {
    if (!env.ACCESS_CODE) {
        return jsonError(
            '未配置 ACCESS_CODE，请在 Cloudflare Dashboard → Workers & Pages → 设置 → 变量 中设置 ACCESS_CODE 密钥',
            500
        );
    }
    return null;
}

/** 检查 Cookie 会话是否有效 — 查 KV SESSION_<token>（TTL 自动过期，登出可撤销） */
export async function requireCookie(request: Request, env: AppEnv): Promise<Response | null> {
    const cookieValue = extractAuthCookie(request);
    // 无 cookie 或会话已失效 → 返回登录页。
    // API 请求返回 401 JSON 而不是 HTML：前端 apiFetch 会 r.json()，收到 HTML 会报
    // 「不是合法 JSON」这种误导性错误，而不是「请重新登录」。
    if (!cookieValue) return unauthenticated(request);
    const session = await env.CONFIG_KV.get(sessionKey(cookieValue));
    if (!session) return unauthenticated(request);
    return null;
}

/** 未认证响应：API 路径给 JSON 401，页面路径给登录页 */
function unauthenticated(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
        return jsonError('会话已过期，请重新登录', 401, 'AUTH_FAILED');
    }
    return loginResponse();
}

/**
 * CSRF 防护 — 双层：
 *  1) 主防线：写请求必须带 X-CSRF-Token 头，且与会话绑定的 CSRF token 恒定时间比对
 *  2) 纵深：Sec-Fetch-Site / Origin 头存在时校验（头缺失由第 1 层兜底）
 */
export async function checkCsrf(request: Request, url: URL, env: AppEnv): Promise<Response | null> {
    const WRITE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (!WRITE_METHODS.includes(request.method)) return null;

    // 纵深防御：头存在时校验（不再"缺失即跳过"，缺失由 CSRF token 层兜底）
    const secSite = request.headers.get('Sec-Fetch-Site');
    if (secSite && secSite !== 'same-origin' && secSite !== 'none') return jsonError('CSRF rejected (Sec-Fetch-Site)', 403);
    const origin = request.headers.get('Origin');
    try {
        if (origin && new URL(origin).host !== url.host) return jsonError('CSRF rejected (Origin)', 403);
    } catch (e) { logger.error('Invalid Origin header', e instanceof Error ? e : new Error(String(e)), { module: 'auth' }); return jsonError('CSRF rejected (Invalid Origin)', 403); }

    // 主防线：X-CSRF-Token 与会话绑定值比对
    const cookieValue = extractAuthCookie(request);
    if (!cookieValue) return jsonError('CSRF rejected (no session)', 403);
    const expected = await env.CONFIG_KV.get(sessionKey(cookieValue));
    const header = request.headers.get('X-CSRF-Token');
    if (!expected || !header || !timingSafeEqualStr(expected, header)) {
        return jsonError('CSRF rejected (token mismatch)', 403);
    }
    return null;
}
