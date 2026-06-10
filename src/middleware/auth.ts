/**
 * 认证中间件 — 登录页 + Cookie 认证 + CSRF
 */

import { jsonError } from '../lib/cloudflare-api';

export function loginHtml() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Login</title></head>
<body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6;font-family:sans-serif">
<div style="background:white;padding:2rem;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);text-align:center">
<h2 style="margin:0 0 1rem;color:#1e293b">🔒 Worker 中控</h2>
<input type="password" id="login_code" placeholder="请输入密码" style="padding:10px;border:1px solid #cbd5e1;border-radius:4px;width:200px;margin-bottom:10px;display:block">
<button onclick="doLogin()" style="padding:10px 24px;background:#1e293b;color:white;border:none;border-radius:4px;cursor:pointer;width:100%">登录</button>
<div id="login_msg" style="color:red;font-size:12px;margin-top:8px"></div>
</div>
<script>
async function doLogin(){
    const code=document.getElementById('login_code').value;
    const msg=document.getElementById('login_msg');
    if(!code){msg.innerText='请输入密码';return;}
    try{
        const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
        const d=await r.json();
        if(d.success){location.reload();}else{msg.innerText=d.msg||'密码错误';}
    }catch(e){msg.innerText='网络错误';}
}
document.getElementById('login_code').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
</script>
</body></html>`;
}

export const MANIFEST = {
    "name": "Worker Pro", "short_name": "WorkerPro", "start_url": "/", "display": "standalone",
    "background_color": "#f3f4f6", "theme_color": "#1e293b",
    "icons": [{ "src": "https://www.cloudflare.com/img/logo-cloudflare-dark.svg", "sizes": "192x192", "type": "image/svg+xml" }]
};

/**
 * 认证检查
 * @returns null = 通过; 否则返回 Response（登录页或错误）
 */
export function authenticate(request: Request, env: any): Response | null {
    const url = new URL(request.url);
    const correctCode = env.ACCESS_CODE;
    const cookieHeader = request.headers.get("Cookie") || "";

    // 公开路由
    if (url.pathname === "/manifest.json") {
        return new Response(JSON.stringify(MANIFEST), { headers: { "Content-Type": "application/json" } });
    }

    // 登录接口
    if (url.pathname === "/api/login" && request.method === "POST") {
        // 注意：这里只做路由匹配，实际处理在 ROUTES 中
        return null; // 让路由处理
    }

    // 认证检查
    if (correctCode && !cookieHeader.includes(`auth=${correctCode}`)) {
        return new Response(loginHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // CSRF 防护
    if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && new URL(origin).host !== url.host) {
            return jsonError("CSRF rejected", 403);
        }
    }

    return null; // 通过
}
