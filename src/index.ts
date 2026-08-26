/**
 * Worker 智能中控 — 前后端分离版 入口
 * ${FRONTEND_VERSION}
 */

import { requireAccessCode, requireCookie, checkCsrf, sessionKey } from './middleware/auth';
import { jsonError } from './lib/cloudflare-api';
import { getRoute } from './routes/register';
import { handleCronJob } from './cron';
import { TEMPLATES, ECH_PROXIES, MANIFEST } from './config/templates';
import { FRONTEND_HTML, FRONTEND_CSS, FRONTEND_JS, FRONTEND_VERSION, FRONTEND_SWEETALERT2 } from './frontend-bundle';
import { logger } from './lib/logger';
import type { AppEnv } from "./config/env";

/**
 * 前端静态资源的缓存策略。
 *
 * 资源路径带 ?v=<version>，内容随版本变化，因此可以长缓存 + immutable；
 * 主 HTML 保持 no-store，保证发布新版本后立刻拿到新的 ?v=。
 */
const ASSET_CACHE = 'public, max-age=31536000, immutable';
const HTML_CACHE = 'no-store, must-revalidate';

/**
 * 面板 CSP。
 *
 * 前端 JS/CSS 已拆成外部资源（/app.js、/app.css），HTML 里也不再有内联 onclick
 * （改为 data-act + 事件委托），因此 script-src 去掉了 'unsafe-inline'。
 * style-src 仍保留 'unsafe-inline'：Tailwind CDN 运行时会注入 <style>，
 * 且代码里有若干 element.style 直接赋值。
 * SweetAlert2 构建时内联失败才需要放行 jsdelivr，按实际情况动态拼接。
 */
function panelCsp(): string {
    const scriptSrc = ["'self'", 'https://cdn.tailwindcss.com'];
    if (!FRONTEND_SWEETALERT2) scriptSrc.push('https://cdn.jsdelivr.net');
    return [
        "default-src 'self'",
        'script-src ' + scriptSrc.join(' '),
        "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
        "img-src 'self' data: https://www.cloudflare.com",
        "connect-src 'self'",
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'"
    ].join('; ');
}

/** 所有 HTML 响应共用的安全响应头 */
const SECURITY_HEADERS: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
};

export default {
    // === 定时任务：自动更新 & 熔断轮换 ===
    async scheduled(_event: ScheduledEvent, env: AppEnv, ctx: ExecutionContext) {
        if (env.CONFIG_KV) {
            // cron 内部已兜底 lastCheck；此处再兜一层，避免 KV 读取等异常变成 unhandled rejection
            ctx.waitUntil(handleCronJob(env).catch(e => {
                logger.error('scheduled: handleCronJob rejected', e instanceof Error ? e : new Error(String(e)), { module: 'scheduled' });
            }));
        }
    },

    // === HTTP 请求入口 ===
    // 请求流程：公开路由 → 登录 → 认证 → CSRF → 路由分发 → 回退主页
    async fetch(request: Request, env: AppEnv, _ctx: ExecutionContext): Promise<Response> {
        try {
            // KV 未绑定时拒绝所有请求
            if (!env.CONFIG_KV) {
                return jsonError('KV Not Bound (Error 1001)', 500, 'KV_NOT_BOUND');
            }

            const url = new URL(request.url);

            // [公开] PWA manifest，无需认证
            if (url.pathname === '/manifest.json') {
                return new Response(JSON.stringify(MANIFEST), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
                });
            }

            // [公开] 登录接口 — 在认证中间件之前检查
            if (url.pathname === '/api/login' && request.method === 'POST') {
                const loginHandler = getRoute('POST', '/api/login');
                if (loginHandler) return await loginHandler(request, env);
            }

            // [公开] 登出接口 — 删除 KV 会话 + 清 cookie（无需认证，无会话时幂等）
            if (url.pathname === '/api/logout' && request.method === 'POST') {
                const cookieHeader = request.headers.get('Cookie') || '';
                const m = cookieHeader.match(/(?:^|;\s*)__Host-auth=([^;]*)/);
                if (m) {
                    await env.CONFIG_KV.delete(sessionKey(m[1])).catch((e: unknown) => logger.warn('logout: session delete failed', { error: e instanceof Error ? e.message : String(e) }));
                }
                return new Response(JSON.stringify({ success: true }), {
                    headers: [
                        ['Content-Type', 'application/json'],
                        ['Set-Cookie', '__Host-auth=; Path=/; HttpOnly; Secure; Max-Age=0; SameSite=Lax'],
                        ['Set-Cookie', '__Host-csrf=; Path=/; Secure; Max-Age=0; SameSite=Lax']
                    ]
                });
            }

            // [认证] 中间件链 — 任一检查不通过即返回对应错误（checkCsrf 需读 KV，为异步）
            const accessCodeCheck = requireAccessCode(env);
            if (accessCodeCheck) return accessCodeCheck;
            const csrfCheck = await checkCsrf(request, url, env);
            if (csrfCheck) return csrfCheck;
            const cookieCheck = await requireCookie(request, env);
            if (cookieCheck) return cookieCheck;

            // [静态资源] 前端 JS / CSS 拆分为独立可缓存资源。
            // 此前整个面板（HTML+CSS+JS+内联 SweetAlert2，约 290KB）每次刷新都全量重传，
            // 且必须开 script-src 'unsafe-inline'。拆开后主 HTML 只剩几 KB。
            if (request.method === 'GET' || request.method === 'HEAD') {
                const asset = serveAsset(url.pathname);
                if (asset) return asset;
            }

            // [核心] 路由分发 — 按 METHOD + PATH 查找处理器（模块级缓存，仅构建一次）
            const handler = getRoute(request.method, url.pathname);
            if (handler) return await handler(request, env);

            // [404] 未匹配的 API 路径必须返回 JSON，避免前端 r.json() 解析 HTML 崩溃
            if (url.pathname.startsWith('/api/')) {
                return jsonError('Not Found: ' + request.method + ' ' + url.pathname, 404);
            }

            // [回退] 非 API 路径 → 返回管理面板 HTML
            return new Response(mainHtml(), {
                headers: {
                    'Content-Type': 'text/html;charset=UTF-8',
                    'Cache-Control': HTML_CACHE,
                    'Content-Security-Policy': panelCsp(),
                    ...SECURITY_HEADERS
                }
            });

        } catch (err: any) {
            // 保留 Response 对象（如 safeJson 的 400、resolveCredentials 的 404）
            if (err instanceof Response) return err;
            logger.error('Unhandled error', err instanceof Error ? err : new Error(String(err)), { module: 'index' });
            return jsonError('Internal server error', 500);
        }
    }
};

// ==========================================
// 前端静态资源（构建时由 frontend/ 内联）
// ==========================================

/** 注入到 /app.js 头部的服务端常量（模板定义、ECH 代理列表） */
let _bootstrapCache: string | null = null;
function bootstrapScript(): string {
    if (_bootstrapCache !== null) return _bootstrapCache;
    const templates = JSON.stringify(
        Object.fromEntries(
            Object.entries(TEMPLATES).map(([k, v]) => [k, {
                defaultVars: v.defaultVars,
                uuidField: v.uuidField,
                name: v.name,
                kvBindingName: v.kvBindingName,
                autoUpdate: v.autoUpdate
            }])
        )
    );
    _bootstrapCache =
        'window.TEMPLATES=' + templates + ';' +
        'window.ECH_PROXIES=' + JSON.stringify(ECH_PROXIES) + ';' +
        'var TEMPLATES=window.TEMPLATES,ECH_PROXIES=window.ECH_PROXIES;\n';
    return _bootstrapCache;
}

/** 静态资源响应，命中返回 Response，否则 null */
function serveAsset(pathname: string): Response | null {
    if (pathname === '/app.js') {
        return new Response(bootstrapScript() + FRONTEND_JS, {
            headers: {
                'Content-Type': 'application/javascript;charset=UTF-8',
                'Cache-Control': ASSET_CACHE,
                'X-Content-Type-Options': 'nosniff'
            }
        });
    }
    if (pathname === '/app.css') {
        return new Response(FRONTEND_CSS, {
            headers: {
                'Content-Type': 'text/css;charset=UTF-8',
                'Cache-Control': ASSET_CACHE,
                'X-Content-Type-Options': 'nosniff'
            }
        });
    }
    if (pathname === '/vendor/sweetalert2.js' && FRONTEND_SWEETALERT2) {
        return new Response(FRONTEND_SWEETALERT2, {
            headers: {
                'Content-Type': 'application/javascript;charset=UTF-8',
                'Cache-Control': ASSET_CACHE,
                'X-Content-Type-Options': 'nosniff'
            }
        });
    }
    return null;
}

let _htmlCache: string | null = null;
function mainHtml() {
    if (_htmlCache !== null) return _htmlCache;
    const v = encodeURIComponent(FRONTEND_VERSION);
    // SweetAlert2 构建时未内联成功则回退 CDN（CSP 里已放行 jsdelivr 作为该情形的兜底）
    const swScript = FRONTEND_SWEETALERT2
        ? '<script src="/vendor/sweetalert2.js?v=' + v + '" defer></script>'
        : '<script src="https://cdn.jsdelivr.net/npm/sweetalert2@11" defer></script>';

    _htmlCache = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="manifest" href="/manifest.json">
  <title>Worker 智能中控 (${FRONTEND_VERSION})</title>
  <link rel="stylesheet" href="/app.css?v=${v}">
  <script src="https://cdn.tailwindcss.com"></script>
  ${swScript}
  <script src="/app.js?v=${v}" defer></script>
</head>
<body class="p-2 md:p-4 min-h-screen text-slate-700">
${FRONTEND_HTML}
</body></html>`;
    return _htmlCache;
}
