/**
 * Worker 智能中控 — 前后端分离版 入口
 * ${FRONTEND_VERSION}
 */

import { requireAccessCode, requireCookie, checkCsrf, generateAuthToken } from './middleware/auth';
import { jsonError, json, safeJson } from './lib/cloudflare-api';
import { getRoute } from './routes/index';
import { handleCronJob } from './cron';
import { TEMPLATES, ECH_PROXIES, MANIFEST } from './config/templates';
import { FRONTEND_HTML, FRONTEND_CSS, FRONTEND_JS, FRONTEND_VERSION, FRONTEND_SWEETALERT2 } from './frontend-bundle';
import { logger } from './lib/logger';
import type { AppEnv } from "./config/env";

export default {
    // === 定时任务：自动更新 & 熔断轮换 ===
    async scheduled(_event: ScheduledEvent, env: AppEnv, ctx: ExecutionContext) {
        if (env.CONFIG_KV) {
            ctx.waitUntil(handleCronJob(env));
        }
    },

    // === HTTP 请求入口 ===
    // 请求流程：公开路由 → 登录 → 认证 → CSRF → 路由分发 → 回退主页
    async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
        try {
            // KV 未绑定时拒绝所有请求
            if (!env.CONFIG_KV) {
                return jsonError('KV Not Bound (Error 1001)', 500);
            }

            const url = new URL(request.url);

            // [公开] PWA manifest，无需认证
            if (url.pathname === '/manifest.json') {
                return new Response(JSON.stringify(MANIFEST), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
            }

            // [公开] 登录接口 — 验证 ACCESS_CODE + 速率限制（5次/5分钟/IP）
            if (url.pathname === '/api/login' && request.method === 'POST') {
                // 速率限制：基于 IP 最多 5 次/5分钟
                const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
                const rateKey = 'RATE_LIMIT_' + clientIp;
                            // 登录速率限制配置
            const LOGIN_RATE_LIMIT = { MAX_ATTEMPTS: 5, WINDOW_SECONDS: 300 };

            const attemptStr = await env.CONFIG_KV.get(rateKey);
                const attempts = attemptStr ? parseInt(attemptStr, 10) : 0;
                if (attempts >= LOGIN_RATE_LIMIT.MAX_ATTEMPTS) {
                    return jsonError('登录尝试过于频繁，请 5 分钟后再试', 429);
                }
                await env.CONFIG_KV.put(rateKey, String(attempts + 1), { expirationTtl: LOGIN_RATE_LIMIT.WINDOW_SECONDS });

                const body = await safeJson(request);
                const correctCode = env.ACCESS_CODE;
                if (!correctCode) {
                    return jsonError('未配置 ACCESS_CODE，请在 Cloudflare Dashboard → Workers & Pages → 设置 → 变量 中设置 ACCESS_CODE 密钥', 500);
                }
                if (body.code === correctCode) {
                    const token = await generateAuthToken(correctCode!);
                    await env.CONFIG_KV.delete(rateKey);
                    return json({ success: true }, {
                        headers: {
                        'Set-Cookie': `__Host-auth=${token}; Path=/; HttpOnly; Secure; Max-Age=86400; SameSite=Lax`
                    }
                    });
                }
                return jsonError('密码错误', 401);
            }
            // [认证] 中间件链 — 任一检查不通过即返回对应错误
            const syncCheck = requireAccessCode(env) || checkCsrf(request, url);
            if (syncCheck) return syncCheck;
            const cookieCheck = await requireCookie(request, env);
            if (cookieCheck) return cookieCheck;

            // [核心] 路由分发 — 按 METHOD + PATH 查找处理器（模块级缓存，仅构建一次）
            const handler = getRoute(request.method, url.pathname);
            if (handler) return await handler(request, env);

            // [回退] 无匹配路由 → 返回管理面板 HTML
            return new Response(mainHtml(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store, must-revalidate', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.cloudflare.com; connect-src 'self'" } });

        } catch (err: any) {
            // 保留 Response 对象（如 safeJson 的 400、resolveCredentials 的 404）
            if (err instanceof Response) return err;
            logger.error('Unhandled error', err instanceof Error ? err : new Error(String(err)), { module: 'index' });
            return jsonError('Internal server error', 500);
        }
    }
};

// ==========================================
// 前端页面（构建时由 frontend/ 拼接）
// ==========================================
let _htmlCache: string | null = null;
let _htmlCacheVersion: string | null = null;
function mainHtml() {
    if (_htmlCache && _htmlCacheVersion === FRONTEND_VERSION) return _htmlCache;
    const TEMPLATES_JSON = JSON.stringify(
        Object.fromEntries(
            Object.entries(TEMPLATES).map(([k, v]) => [k, { defaultVars: v.defaultVars, uuidField: v.uuidField, name: v.name }])
        )
    );
    const ECH_PROXIES_JSON = JSON.stringify(ECH_PROXIES);

const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="manifest" href="/manifest.json">
  <title>Worker 智能中控 (${FRONTEND_VERSION})</title>
  <script src="https://cdn.tailwindcss.com" onerror="document.getElementById('tailwind_fallback')&&(document.getElementById('tailwind_fallback').style.display='block')"></script>
  ${FRONTEND_SWEETALERT2 ? `<script>${FRONTEND_SWEETALERT2}</script>` : '<script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>'}
  <style id="tailwind_fallback" style="display:none">
    body{font-family:system-ui,sans-serif}button{padding:6px 12px;border-radius:4px;cursor:pointer}
    .bg-white{background:#fff}.bg-slate-100{background:#f1f5f9}.rounded{border-radius:6px}
    .shadow{box-shadow:0 1px 3px rgba(0,0,0,.1)}.p-2{padding:8px}.p-4{padding:16px}
    .flex{display:flex}.grid{display:grid}.hidden{display:none}.min-h-screen{min-height:100vh}
  </style>
  <style>
    ${FRONTEND_CSS}
  </style>
</head>
<body class="p-2 md:p-4 min-h-screen text-slate-700">
  <canvas id="starfield"></canvas>
  ${FRONTEND_HTML}
  <script>
    const TEMPLATES = ${TEMPLATES_JSON};
    const ECH_PROXIES = ${ECH_PROXIES_JSON};
    ${FRONTEND_JS}
  </script>
</body></html>`;
  
    _htmlCache = html;
    _htmlCacheVersion = FRONTEND_VERSION;
    return html;
}
