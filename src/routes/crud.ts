/**
 * CRUD 路由 — KV 直接读写 + 诊断 + 导入导出备份恢复
 */
import { KV_KEYS } from '../config/templates';
import { json, jsonError, cf, getAuthHeaders } from '../lib/cloudflare-api';

type Handler = (req: Request, env: any) => Promise<Response>;

export function registerCrudRoutes(ROUTES: Map<string, Handler>) {
// --- KV CRUD 路由（直接内联） ---
ROUTES.set('GET /api/accounts', async (_req, env) =>
    new Response(await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS) || '[]', { headers: { 'Content-Type': 'application/json' } }));
ROUTES.set('POST /api/accounts', async (req, env) => {
    await env.CONFIG_KV.put(KV_KEYS.ACCOUNTS, JSON.stringify(await req.json()));
    return json({ success: true });
});
ROUTES.set('GET /api/settings', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    return new Response(await env.CONFIG_KV.get(KV_KEYS.vars(type || '')) || 'null', { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('POST /api/settings', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    await env.CONFIG_KV.put(KV_KEYS.vars(type || ''), JSON.stringify(await req.json()));
    return json({ success: true });
});
ROUTES.set('GET /api/deploy_config', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    const key = KV_KEYS.deployConfig(type || '');
    const defaultCfg = { mode: 'latest', currentSha: null, deployTime: null };
    return new Response(await env.CONFIG_KV.get(key) || JSON.stringify(defaultCfg), { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('GET /api/favorites', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    return new Response(await env.CONFIG_KV.get(KV_KEYS.favorites(type || '')) || '[]', { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('POST /api/favorites', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    const key = KV_KEYS.favorites(type || '');
    const { action, item } = await req.json() as any;
    let favs = JSON.parse(await env.CONFIG_KV.get(key) || '[]');
    if (action === 'add') { if (!favs.find((f: any) => f.sha === item.sha)) favs.unshift(item); }
    else if (action === 'remove') { favs = favs.filter((f: any) => f.sha !== item.sha); }
    await env.CONFIG_KV.put(key, JSON.stringify(favs));
    return json({ success: true, favorites: favs });
});
ROUTES.set('GET /api/auto_config', async (_req, env) =>
    new Response(await env.CONFIG_KV.get(KV_KEYS.GLOBAL_CONFIG) || '{}', { headers: { 'Content-Type': 'application/json' } }));
ROUTES.set('POST /api/auto_config', async (req, env) => {
    await env.CONFIG_KV.put(KV_KEYS.GLOBAL_CONFIG, JSON.stringify(await req.json()));
    return json({ success: true });
});

// --- 诊断端点 ---
ROUTES.set('GET /api/verify_credentials', async (req, env) => {
        const accounts = JSON.parse(await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS) || '[]');
        const results = [];
        for (const acc of accounts) {
            try {
                const headers = getAuthHeaders(acc.email, acc.globalKey);
                const res = await fetch(cf.userTokenVerify(), { method: 'GET', headers });
                results.push({ alias: acc.alias, ok: res.ok, status: res.status });
            } catch(e: any) { results.push({ alias: acc.alias, ok: false, error: e.message }); }
        }
        return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
    });

ROUTES.set('GET /api/deploy/preview', async (req, env) => {
        const type = new URL(req.url).searchParams.get('type') || '';
        const accounts = JSON.parse(await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS) || '[]');
        const targetWorkers = accounts.flatMap((a: any) => (a['workers_' + type] || []).map((w: string) => a.alias + ' -> [' + w + ']'));
        return new Response(JSON.stringify({ accounts: accounts.filter((a: any) => (a['workers_' + type] || []).length > 0).length, workers: targetWorkers.length, details: targetWorkers }), { headers: { 'Content-Type': 'application/json' } });
    });

ROUTES.set('GET /api/diag', async (_req, env) => {
    const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG];
    const results: Record<string, unknown> = {};
    for (const k of keys) {
        try {
            const v = await env.CONFIG_KV.get(k);
            results[k] = v === null ? '(null)' : (v.length > 200 ? v.substring(0, 200) + '...' : v);
        } catch (e: any) { results[k] = 'ERROR: ' + e.message; }
    }
    results['__kv_bound'] = !!env.CONFIG_KV;
    results['__kv_keys'] = KV_KEYS;
    return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json' } });
});


// --- 账号导入导出 ---
ROUTES.set('GET /api/accounts/export', async (_req, env) => {
    const data = await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS);
    return new Response(data || '[]', {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="accounts-export.json"' }
    });
});
ROUTES.set('POST /api/accounts/import', async (req, env) => {
    try {
        const imported = await req.json();
        if (!Array.isArray(imported)) return jsonError('格式错误：需要 JSON 数组');
        const existing = JSON.parse(await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS) || '[]');
        const merged = [...existing];
        let added = 0, skipped = 0;
        for (const item of imported) {
            if (!item.alias || !item.accountId) { skipped++; continue; }
            const dupIdx = merged.findIndex((a: any) => a.alias === item.alias || a.accountId === item.accountId);
            if (dupIdx >= 0) { merged[dupIdx] = { ...merged[dupIdx], ...item }; skipped++; }
            else { merged.push(item); added++; }
        }
        await env.CONFIG_KV.put(KV_KEYS.ACCOUNTS, JSON.stringify(merged));
        return json({ success: true, added, skipped, total: merged.length });
    } catch (e: any) { return jsonError('导入失败: ' + e.message); }
});

// --- 数据备份恢复 ---
ROUTES.set('GET /api/backup', async (_req, env) => {
    const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG, KV_KEYS.vars('cmliu'), KV_KEYS.vars('joey'), KV_KEYS.vars('ech'),
        KV_KEYS.deployConfig('cmliu'), KV_KEYS.deployConfig('joey'), KV_KEYS.deployConfig('ech'),
        KV_KEYS.favorites('cmliu'), KV_KEYS.favorites('joey'), KV_KEYS.favorites('ech')];
    const backup: Record<string, any> = { _time: new Date().toISOString() };
    for (const k of keys) {
        try { backup[k] = JSON.parse(await env.CONFIG_KV.get(k) || 'null'); } catch (e) { backup[k] = await env.CONFIG_KV.get(k); }
    }
    return new Response(JSON.stringify(backup, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="worker-backup.json"' }
    });
});
ROUTES.set('POST /api/restore', async (req, env) => {
    try {
        const backup = await req.json();
        let restored = 0;
        for (const [k, v] of Object.entries(backup)) {
            if (k.startsWith('_')) continue;
            await env.CONFIG_KV.put(k, typeof v === 'string' ? v : JSON.stringify(v));
            restored++;
        }
        return json({ success: true, restored });
    } catch (e: any) { return jsonError('恢复失败: ' + e.message); }
});

}
