/**
 * 冒烟测试 — 部署后运行，验证关键端点可用
 * 用法: node test/smoke.js <BASE_URL>
 * 示例: node test/smoke.js https://your-worker.workers.dev
 */
const BASE = process.argv[2];
if (!BASE) {
    console.log('用法: node test/smoke.js <BASE_URL>');
    console.log('示例: node test/smoke.js https://your-worker.workers.dev');
    process.exit(1);
}

let passed = 0, failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ❌ ${name}: ${e.message}`);
        failed++;
    }
}

(async () => {
    console.log(`\n🚀 Smoke test: ${BASE}\n`);

    // ===== 1. 公开端点（无需认证）=====
    console.log('── 公开端点 ──');

    await test('GET / → 返回 HTML 管理面板', async () => {
        const r = await fetch(BASE);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const html = await r.text();
        if (!html.includes('Worker 部署中控')) throw new Error('页面标题缺失');
        if (!html.includes('TEMPLATES')) throw new Error('JS 模板数据缺失');
    });

    await test('GET /manifest.json → 返回 PWA manifest', async () => {
        const r = await fetch(BASE + '/manifest.json');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!d.name || !d.short_name) throw new Error('manifest 字段缺失');
    });

    await test('POST /api/login (错误密码) → 401', async () => {
        const r = await fetch(BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'wrong_password_12345' })
        });
        if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
        const d = await r.json();
        if (d.success !== false) throw new Error('success 应为 false');
    });

    await test('POST /api/login (空body) → 400', async () => {
        const r = await fetch(BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not json'
        });
        if (r.status !== 400) throw new Error(`期望 400，实际 ${r.status}`);
    });

    // ===== 2. 认证拦截 =====
    console.log('── 认证拦截 ──');

    await test('GET /api/accounts (无Cookie) → 被拦截', async () => {
        const r = await fetch(BASE + '/api/accounts');
        if (r.ok) throw new Error('应被认证中间件拦截');
    });

    await test('POST /api/deploy (无Cookie) → 被拦截', async () => {
        const r = await fetch(BASE + '/api/deploy?type=cmliu', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ variables: [] })
        });
        if (r.ok) throw new Error('应被认证中间件拦截');
    });

    // ===== 3. CSRF 防护 =====
    console.log('── CSRF 防护 ──');

    await test('POST 请求无 Origin → 不拦截 (同源)', async () => {
        // 没有 Origin 头的 POST 在某些场景下合法（如服务器间调用）
        // 这里只验证 API 可达
        const r = await fetch(BASE + '/api/accounts', { method: 'POST' });
        // 应该被认证拦截而不是 CSRF 拦截（401/HTML 而不是 403）
        if (r.status === 403) throw new Error('不应被 CSRF 拦截（无Origin）');
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
        if (!rateLimited) throw new Error('6 次错误登录后未被限流');
    });

    // ===== 结果 =====
    console.log(`\n${'='.repeat(40)}`);
    console.log(`  ✅ ${passed} 通过  ❌ ${failed} 失败`);
    console.log(`${'='.repeat(40)}\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
