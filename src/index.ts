/**
 * Worker 智能中控 — 前后端分离版 入口
 * V10.10.0
 */

import { MANIFEST, loginHtml, authenticate } from './middleware/auth';
import { jsonError } from './lib/cloudflare-api';
import { createRoutes } from './routes/index';
import { handleCronJob } from './cron';
import { TEMPLATES, ECH_PROXIES, KV_KEYS } from './config/templates';
import { FRONTEND_HTML, FRONTEND_CSS, FRONTEND_JS } from './frontend-bundle';

export default {
    // === 定时任务：自动更新 & 熔断轮换 ===
    async scheduled(_event: ScheduledEvent, env: any, ctx: ExecutionContext) {
        if (env.CONFIG_KV) {
            ctx.waitUntil(handleCronJob(env));
        }
    },

    // === HTTP 请求入口 ===
    // 请求流程：公开路由 → 登录 → 认证 → CSRF → 路由分发 → 回退主页
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
        try {
            // KV 未绑定时拒绝所有请求
            if (!env.CONFIG_KV) {
                return new Response('KV Not Bound (Error 1001)', { status: 500 });
            }

            const url = new URL(request.url);

            // [公开] PWA manifest，无需认证
            if (url.pathname === '/manifest.json') {
                return new Response(JSON.stringify(MANIFEST), { headers: { 'Content-Type': 'application/json' } });
            }

            // [公开] 登录接口 — 验证 ACCESS_CODE，成功则写入 Cookie
            if (url.pathname === '/api/login' && request.method === 'POST') {
                const body: any = await request.json();
                const correctCode = env.ACCESS_CODE;
                if (body.code === correctCode) {
                    return new Response(JSON.stringify({ success: true }), {
                        headers: {
                            'Content-Type': 'application/json',
                            'Set-Cookie': `auth=${correctCode}; Path=/; HttpOnly; Secure; Max-Age=86400; SameSite=Lax`
                        }
                    });
                }
                return jsonError('密码错误', 401);
            }

            // [认证] Cookie 校验 — 未登录用户看到登录页
            const correctCode = env.ACCESS_CODE;
            const cookieHeader = request.headers.get('Cookie') || '';
            if (correctCode && !cookieHeader.includes(`auth=${correctCode}`)) {
                return new Response(loginHtml(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store, must-revalidate' } });
            }

            // [安全] CSRF 防护 — POST 请求校验 Origin 与 Host 一致
            if (request.method === 'POST') {
                const origin = request.headers.get('Origin');
                if (origin && new URL(origin).host !== url.host) {
                    return jsonError('CSRF rejected', 403);
                }
            }

            // [核心] 路由分发 — 按 METHOD + PATH 查找处理器
            // ROUTES Map 在 createRoutes(env) 中构建，env 通过闭包注入
            const routes = createRoutes(env);
            const handler = routes.get(`${request.method} ${url.pathname}`);
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
    <title>V10.10.2-DEPLOYED</title>
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
