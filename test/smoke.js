/**
 * 冒烟测试 — 部署后运行，验证关键端点可用（不需要登录凭据）
 * 用法: node test/smoke.js <BASE_URL>
 * 示例: node test/smoke.js https://your-worker.workers.dev
 */
const BASE = (process.argv[2] || '').replace(/\/+$/, '');
if (!BASE) {
    console.log('用法: node test/smoke.js <BASE_URL>');
    console.log('示例: node test/smoke.js https://your-worker.workers.dev');
    process.exit(1);
}

let passed = 0, failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log('  ✅ ' + name);
        passed++;
    } catch (e) {
        console.log('  ❌ ' + name + ': ' + e.message);
        failed++;
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

(async () => {
    console.log('\n🚀 Smoke test: ' + BASE + '\n');

    // ===== 1. 公开端点（无需认证）=====
    console.log('── 公开端点 ──');

    let panelHtml = '';
    await test('GET / → 返回管理面板 HTML（外链 app.js / app.css）', async () => {
        const r = await fetch(BASE);
        assert(r.ok, 'HTTP ' + r.status);
        panelHtml = await r.text();
        assert(panelHtml.includes('Worker 部署中控') || panelHtml.includes('Worker 智能中控'), '页面标题缺失');
        // 前端已拆为外部资源；主 HTML 里不应再内联整个 JS
        assert(/src="\/app\.js\?v=/.test(panelHtml), '未引用外部 /app.js');
        assert(/href="\/app\.css\?v=/.test(panelHtml), '未引用外部 /app.css');
    });

    await test('主 HTML 体积显著小于旧版全内联（< 80KB）', async () => {
        const kb = Buffer.byteLength(panelHtml, 'utf8') / 1024;
        assert(kb < 80, '主 HTML 仍有 ' + kb.toFixed(1) + ' KB，资源拆分可能未生效');
    });

    await test('面板 CSP 不含 script-src \'unsafe-inline\'', async () => {
        const r = await fetch(BASE);
        const csp = r.headers.get('content-security-policy') || '';
        assert(csp, '缺少 Content-Security-Policy 头');
        const scriptSrc = (csp.split(';').find(p => p.trim().startsWith('script-src')) || '');
        assert(!scriptSrc.includes("'unsafe-inline'"), 'script-src 仍允许 unsafe-inline');
    });

    await test('HTML 响应带完整安全头', async () => {
        const r = await fetch(BASE);
        assert(r.headers.get('x-content-type-options') === 'nosniff', '缺 X-Content-Type-Options');
        assert(r.headers.get('x-frame-options') === 'DENY', '缺 X-Frame-Options');
        assert((r.headers.get('cache-control') || '').includes('no-store'), '主 HTML 应 no-store');
    });

    await test('GET /app.js → JS 且长缓存', async () => {
        const r = await fetch(BASE + '/app.js');
        assert(r.ok, 'HTTP ' + r.status);
        assert((r.headers.get('content-type') || '').includes('javascript'), 'Content-Type 不是 JS');
        assert((r.headers.get('cache-control') || '').includes('immutable'), '静态资源应长缓存 immutable');
        const js = await r.text();
        assert(js.includes('window.TEMPLATES'), '模板数据未注入');
        assert(js.includes('registerActions'), '事件委托注册器缺失');
    });

    await test('GET /app.css → CSS 且长缓存', async () => {
        const r = await fetch(BASE + '/app.css');
        assert(r.ok, 'HTTP ' + r.status);
        assert((r.headers.get('content-type') || '').includes('css'), 'Content-Type 不是 CSS');
        assert((r.headers.get('cache-control') || '').includes('immutable'), '静态资源应长缓存');
    });

    await test('GET /manifest.json → 返回 PWA manifest', async () => {
        const r = await fetch(BASE + '/manifest.json');
        assert(r.ok, 'HTTP ' + r.status);
        const d = await r.json();
        assert(d.name && d.short_name, 'manifest 字段缺失');
    });

    await test('POST /api/login (错误密码) → 401 JSON', async () => {
        const r = await fetch(BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'wrong_password_12345' })
        });
        assert(r.status === 401, '期望 401，实际 ' + r.status);
        const d = await r.json();
        assert(d.success === false, 'success 应为 false');
    });

    await test('POST /api/login (非法 JSON) → 400', async () => {
        const r = await fetch(BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not json'
        });
        assert(r.status === 400, '期望 400，实际 ' + r.status);
    });

    await test('POST /api/logout 无会话时幂等成功', async () => {
        const r = await fetch(BASE + '/api/logout', { method: 'POST' });
        assert(r.ok, 'HTTP ' + r.status);
        assert((await r.json()).success === true, '应返回 success');
    });

    // ===== 2. 认证拦截 =====
    console.log('── 认证拦截 ──');

    await test('GET /api/accounts (无 Cookie) → 401 JSON（而非 HTML）', async () => {
        const r = await fetch(BASE + '/api/accounts');
        assert(!r.ok, '应被认证中间件拦截');
        assert(r.status === 401, '期望 401，实际 ' + r.status);
        assert((r.headers.get('content-type') || '').includes('json'), 'API 未认证应返回 JSON 而非登录页 HTML');
    });

    await test('GET /api/init_data (无 Cookie) → 401', async () => {
        const r = await fetch(BASE + '/api/init_data');
        assert(r.status === 401, '期望 401，实际 ' + r.status);
    });

    await test('POST /api/deploy (无 Cookie) → 被拦截', async () => {
        const r = await fetch(BASE + '/api/deploy?type=cmliu', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ variables: [] })
        });
        assert(!r.ok, '应被拦截');
    });

    await test('未匹配的 /api/* → 404 JSON（不返回面板 HTML）', async () => {
        const r = await fetch(BASE + '/api/definitely_not_a_route');
        assert(r.status === 404 || r.status === 401, '期望 404/401，实际 ' + r.status);
        assert((r.headers.get('content-type') || '').includes('json'), '/api/* 未匹配必须返回 JSON');
    });

    // ===== 3. CSRF 防护 =====
    console.log('── CSRF 防护 ──');

    await test('跨站 Sec-Fetch-Site 的写请求 → 403', async () => {
        const r = await fetch(BASE + '/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
            body: '[]'
        });
        assert(r.status === 403, '期望 403，实际 ' + r.status);
    });

    await test('跨站 Origin 的写请求 → 403', async () => {
        const r = await fetch(BASE + '/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
            body: '[]'
        });
        assert(r.status === 403, '期望 403，实际 ' + r.status);
    });

    await test('无 CSRF token 的写请求 → 403', async () => {
        const r = await fetch(BASE + '/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '[]'
        });
        assert(r.status === 403, '期望 403（CSRF token 缺失），实际 ' + r.status);
    });

    // ===== 4. 速率限制 =====
    console.log('── 速率限制 ──');

    await test('连续 6 次错误登录 → 429', async () => {
        let rateLimited = false;
        for (let i = 0; i < 6; i++) {
            const r = await fetch(BASE + '/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: 'wrong_' + i })
            });
            if (r.status === 429) { rateLimited = true; break; }
        }
        assert(rateLimited, '6 次错误登录后未被限流（注意 KV 最终一致性可能有传播延迟）');
    });

    // ===== 结果 =====
    console.log('\n' + '='.repeat(40));
    console.log('  ✅ ' + passed + ' 通过  ❌ ' + failed + ' 失败');
    console.log('='.repeat(40) + '\n');
    process.exit(failed > 0 ? 1 : 0);
})();
