/**
 * Worker 智能中控 — 前后端分离版 入口
 * V10.14.0
 */

import { requireAccessCode, requireCookie, checkCsrf, generateAuthToken } from './middleware/auth';
import { jsonError } from './lib/cloudflare-api';
import { getRoute } from './routes/index';
import { handleCronJob } from './cron';
import { TEMPLATES, ECH_PROXIES, MANIFEST } from './config/templates';
import { FRONTEND_HTML, FRONTEND_CSS, FRONTEND_JS } from './frontend-bundle';
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
                return new Response('KV Not Bound (Error 1001)', { status: 500 });
            }

            const url = new URL(request.url);

            // [公开] PWA manifest，无需认证
            if (url.pathname === '/manifest.json') {
                return new Response(JSON.stringify(MANIFEST), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } });
            }

            // [公开] 登录接口 — 验证 ACCESS_CODE，成功则写入 Cookie（存 SHA-256 token，不暴露明文密码）
            if (url.pathname === '/api/login' && request.method === 'POST') {
                const body: any = await request.json();
                const correctCode = env.ACCESS_CODE;
                if (body.code === correctCode) {
                    const token = await generateAuthToken(correctCode!);
                    return new Response(JSON.stringify({ success: true }), {
                        headers: {
                            'Content-Type': 'application/json',
                            'Set-Cookie': `auth=${token}; Path=/; HttpOnly; Secure; Max-Age=86400; SameSite=Lax`
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
            if (handler) return handler(request, env);

            // [回退] 无匹配路由 → 返回管理面板 HTML
            return new Response(mainHtml(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store, must-revalidate' } });

        } catch (err: any) {
            return jsonError(err.message);
        }
    }
};

// ==========================================
// 前端页面（构建时由 frontend/ 拼接）
// ==========================================
function mainHtml() {
    const TEMPLATES_JSON = JSON.stringify(
        Object.fromEntries(
            Object.entries(TEMPLATES).map(([k, v]) => [k, { defaultVars: v.defaultVars, uuidField: v.uuidField, name: v.name }])
        )
    );
    const ECH_PROXIES_JSON = JSON.stringify(ECH_PROXIES);

    return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="manifest" href="/manifest.json">
    <title>Worker 智能中控 (V10.14.0)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <style>
      ${FRONTEND_CSS}
    </style>
  </head>
  <body class="bg-slate-100 p-2 md:p-4 min-h-screen text-slate-700">
    <canvas id="starfield"></canvas>
    ${FRONTEND_HTML}
    <script>
      const TEMPLATES = ${TEMPLATES_JSON};
      const ECH_PROXIES = ${ECH_PROXIES_JSON};
      ${FRONTEND_JS}
    </script>
  </body></html>`;
}
