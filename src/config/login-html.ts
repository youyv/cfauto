/** Login page HTML template — cached after first call */
let _loginCache: string | null = null;
export function loginHtml() {
    if (_loginCache) return _loginCache;
    _loginCache = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Login</title></head>
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
    return _loginCache;
}



