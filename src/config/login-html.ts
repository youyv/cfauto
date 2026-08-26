/**
 * 登录页 HTML —— 首次调用后缓存。
 *
 * 登录页刻意不引入外部资源与内联脚本以外的任何东西：它在未认证状态下返回，
 * 保持最小攻击面。内联脚本用 nonce 授权，因此 CSP 不需要 'unsafe-inline'。
 */

/** 页面骨架（不含 <script>），nonce 由调用方注入 */
function loginBody(nonce: string): string {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Login</title>
<style nonce="${nonce}">
body{display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f3f4f6;font-family:system-ui,-apple-system,sans-serif}
.card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1);text-align:center}
h2{margin:0 0 1rem;color:#1e293b}
input{padding:10px;border:1px solid #cbd5e1;border-radius:4px;width:200px;margin-bottom:10px;display:block;font-size:14px}
button{padding:10px 24px;background:#1e293b;color:#fff;border:none;border-radius:4px;cursor:pointer;width:100%;font-size:14px}
button:disabled{opacity:.6;cursor:not-allowed}
#login_msg{color:#dc2626;font-size:12px;margin-top:8px;min-height:16px}
</style></head>
<body>
<div class="card">
<h2>🔒 Worker 中控</h2>
<input type="password" id="login_code" placeholder="请输入密码" autocomplete="current-password" autofocus>
<button id="login_btn" type="button">登录</button>
<div id="login_msg"></div>
</div>
<script nonce="${nonce}">
(function(){
  var input=document.getElementById('login_code');
  var btn=document.getElementById('login_btn');
  var msg=document.getElementById('login_msg');
  var busy=false;
  async function doLogin(){
    if(busy)return;
    var code=input.value;
    if(!code){msg.textContent='请输入密码';return;}
    busy=true;btn.disabled=true;msg.textContent='';
    try{
      var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})});
      var d=null;
      try{d=await r.json();}catch(e){}
      if(r.ok&&d&&d.success){location.reload();return;}
      msg.textContent=(d&&d.msg)||('登录失败 (HTTP '+r.status+')');
    }catch(e){msg.textContent='网络错误: '+e.message;}
    busy=false;btn.disabled=false;
  }
  btn.addEventListener('click',doLogin);
  input.addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
})();
</script>
</body></html>`;
}

/** 生成一次性 nonce（每个响应独立，随 CSP 头一起下发） */
function makeNonce(): string {
    const buf = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...buf)).replace(/[^A-Za-z0-9]/g, '');
}

/** 登录页响应（含 CSP 与安全头），nonce 每次请求新生成，故不缓存整体响应体 */
export function loginResponse(): Response {
    const nonce = makeNonce();
    const csp = [
        "default-src 'none'",
        "script-src 'nonce-" + nonce + "'",
        "style-src 'nonce-" + nonce + "'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'"
    ].join('; ');
    return new Response(loginBody(nonce), {
        headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'Cache-Control': 'no-store, must-revalidate',
            'Content-Security-Policy': csp,
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer'
        }
    });
}
