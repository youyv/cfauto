/**
 * CRUD 路由 — KV 直接读写 + 诊断 + 导入导出备份恢复
 */
import { KV_KEYS, TEMPLATES } from '../config/templates';
import { json, jsonError, cf, getAuthHeaders, safeJson } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import { readAccounts, readAccountsMasked, writeAccounts, getWorkerNames } from "../lib/account-store";
import { decryptKey } from "../lib/crypto-utils";
import { requireTemplateType } from '../lib/validate';
import type { AppEnv } from "../config/env";
import type { RouteHandler } from "./index";
import type { FavoriteItem } from '../lib/types';

export function registerCrudRoutes(ROUTES: Map<string, RouteHandler>) {
// --- KV CRUD 路由（直接内联） ---
ROUTES.set('GET /api/accounts', async (_req, env) => {
    const accounts = await readAccountsMasked(env);
    return new Response(JSON.stringify(accounts), { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('POST /api/accounts', async (req, env) => {
    const accounts = await safeJson(req);
    await writeAccounts(env, accounts);
    return json({ success: true });
});
ROUTES.set('GET /api/settings', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    return new Response(await env.CONFIG_KV.get(KV_KEYS.vars(type || ''), {cacheTtl: 60}) || '[]', { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('POST /api/settings', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    await putJSON(env.CONFIG_KV, KV_KEYS.vars(type || ''), await safeJson(req));
    return json({ success: true });
});
ROUTES.set('GET /api/deploy_config', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    const key = KV_KEYS.deployConfig(type || '');
    const defaultCfg = { mode: 'latest', currentSha: null, deployTime: null };
    return new Response(await env.CONFIG_KV.get(key, {cacheTtl: 60}) || JSON.stringify(defaultCfg), { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('GET /api/favorites', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    return new Response(await env.CONFIG_KV.get(KV_KEYS.favorites(type || ''), {cacheTtl: 60}) || '[]', { headers: { 'Content-Type': 'application/json' } });
});
interface FavoriteAction { action: 'add' | 'remove'; item: FavoriteItem; }

ROUTES.set('POST /api/favorites', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type');
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    const key = KV_KEYS.favorites(type || '');
    const { action, item } = await safeJson<FavoriteAction>(req);
    let favs = await getJSON(env.CONFIG_KV, key, []);
    if (action === 'add') { if (!favs.find((f: FavoriteItem) => f.sha === item.sha)) favs.unshift(item); }
    else if (action === 'remove') { favs = favs.filter((f: FavoriteItem) => f.sha !== item.sha); }
    await putJSON(env.CONFIG_KV, key, favs);
    return json({ success: true, favorites: favs });
});
ROUTES.set('GET /api/auto_config', async (_req, env) =>
    new Response(await env.CONFIG_KV.get(KV_KEYS.GLOBAL_CONFIG, {cacheTtl: 60}) || '{}', { headers: { 'Content-Type': 'application/json' } }));
ROUTES.set('POST /api/auto_config', async (req, env) => {
    await putJSON(env.CONFIG_KV, KV_KEYS.GLOBAL_CONFIG, await safeJson(req));
    return json({ success: true });
});

// --- 诊断端点 ---
ROUTES.set('GET /api/verify_credentials', async (req, env) => {
        const accounts = await readAccounts(env);
        const results = await Promise.all(accounts.map(async (acc) => {
            try {
                const headers = getAuthHeaders(acc.email, acc.globalKey);
                const res = await fetch(cf.userTokenVerify(), { method: 'GET', headers });
                return { alias: acc.alias, ok: res.ok, status: res.status };
            } catch(e: any) { return { alias: acc.alias, ok: false, error: e.message }; }
        }));
        return json(results);
    });

ROUTES.set('GET /api/deploy/preview', async (req, env) => {
        const type = new URL(req.url).searchParams.get('type') || '';
        const accounts = await readAccounts(env);
        const targetWorkers = accounts.flatMap((a) => getWorkerNames(a, type).map((w) => a.alias + ' -> [' + w + ']'));
        return json({ accounts: accounts.filter((a) => getWorkerNames(a, type).length > 0).length, workers: targetWorkers.length, details: targetWorkers });
    });

ROUTES.set('GET /api/diag', async (_req, env) => {
    // 仅返回关键配置项存在性，不暴露实际 KV 内容
    const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG];
    const results: Record<string, unknown> = {};
    for (const k of keys) {
        try {
            const v = await env.CONFIG_KV.get(k);
            results[k] = v === null ? '(not set)' : '(exists)';
        } catch (e: any) { results[k] = 'ERROR: ' + e.message; }
    }
    results['__kv_bound'] = !!env.CONFIG_KV;
    return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json' } });
});


// --- 部署操作日志 ---
ROUTES.set('GET /api/deploy_journal', async (_req, env) =>
    new Response(await env.CONFIG_KV.get(KV_KEYS.DEPLOY_JOURNAL, {cacheTtl: 60}) || '[]', { headers: { 'Content-Type': 'application/json' } }));

// --- 账号导入导出 ---
ROUTES.set('GET /api/accounts/export', async (_req, env) => {
    const data = await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS);
    return new Response(data || '[]', {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="accounts-export.json"' }
    });
});
ROUTES.set('POST /api/accounts/import', async (req, env) => {
    try {
        const imported = await safeJson(req);
        if (!Array.isArray(imported)) return jsonError('格式错误：需要 JSON 数组');
        const existing = await readAccounts(env);
        const merged = [...existing];
        let added = 0, skipped = 0;
        const importedIdx: number[] = [];
        for (const item of imported) {
            if (!item.alias || !item.accountId) { skipped++; continue; }
            const dupIdx = merged.findIndex((a) => a.alias === item.alias || a.accountId === item.accountId);
            if (dupIdx >= 0) { merged[dupIdx] = { ...merged[dupIdx], ...item }; importedIdx.push(dupIdx); skipped++; }
            else { merged.push(item); importedIdx.push(merged.length - 1); added++; }
        }
        // 仅解密来自 import 的条目（export 数据已加密），避免对已解密的存量条目重复解密
        // 仅解密带 v1: 前缀的已加密值，跳过已解密的存量明文（避免无效 atob + warn）
        await Promise.all(importedIdx.map(async (i) => { if (merged[i].globalKey && merged[i].globalKey.match(/^v\d+:/)) merged[i].globalKey = await decryptKey(env, merged[i].globalKey); }));
        await writeAccounts(env, merged);
        return json({ success: true, added, skipped, total: merged.length });
    } catch (e: any) { console.error('[accounts/import]', e); return jsonError('导入失败：数据格式异常'); }
});

// --- 数据备份恢复 ---
ROUTES.set('GET /api/backup', async (_req, env) => {
    const templateTypes = Object.keys(TEMPLATES);
    const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG,
        ...templateTypes.flatMap(t => [KV_KEYS.vars(t), KV_KEYS.deployConfig(t), KV_KEYS.favorites(t)])];
    const backup: Record<string, any> = { _time: new Date().toISOString() };
    for (const k of keys) {
        // 备份保留原始格式：JSON 解析失败时回退到原始字符串（不用 getJSON 是因为需要保留损坏数据）
        try { backup[k] = JSON.parse(await env.CONFIG_KV.get(k) || 'null'); } catch (e) { backup[k] = await env.CONFIG_KV.get(k); }
    }
    return new Response(JSON.stringify(backup, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="worker-backup.json"' }
    });
});
ROUTES.set('POST /api/restore', async (req, env) => {
    try {
        const backup = await safeJson(req);
        // 白名单：仅允许恢复已知的 KV 键（防止覆盖系统键或注入恶意键）
        const allowedPrefixes = [
            KV_KEYS.ACCOUNTS,
            KV_KEYS.GLOBAL_CONFIG,
            KV_KEYS.DEPLOY_JOURNAL,
            ...Object.keys(TEMPLATES).flatMap(t => [
                KV_KEYS.vars(t),
                KV_KEYS.deployConfig(t),
                KV_KEYS.favorites(t)
            ])
        ];
        let restored = 0, rejected = 0;
        for (const [k, v] of Object.entries(backup)) {
            if (k.startsWith('_')) continue;
            if (!allowedPrefixes.some(p => k === p || k.startsWith(p))) {
                rejected++;
                continue;
            }
            await env.CONFIG_KV.put(k, typeof v === 'string' ? v : JSON.stringify(v));
            restored++;
        }
        return json({ success: true, restored, rejected });
    } catch (e: any) { console.error('[restore]', e); return jsonError('恢复失败：备份数据异常'); }
});

// --- 初始化数据合并端点：单次请求替代多次 fetch ---
ROUTES.set('GET /api/init_data', async (req, env) => {
    try {
        const requestedTypes = new URL(req.url).searchParams.get('types');
        const templateTypes = requestedTypes
            ? requestedTypes.split(',').filter(t => TEMPLATES[t]).map(t => t.trim())
            : Object.keys(TEMPLATES);
        const [globalCfgRaw] = await Promise.all([
            env.CONFIG_KV.get(KV_KEYS.GLOBAL_CONFIG, {cacheTtl: 60})
        ]);
        const accounts = await readAccounts(env);
        const varsPromises = templateTypes.map(t => env.CONFIG_KV.get(KV_KEYS.vars(t)));
        const deployCfgPromises = templateTypes.map(t => env.CONFIG_KV.get(KV_KEYS.deployConfig(t)));
        const [varsResults, deployCfgResults] = await Promise.all([
            Promise.all(varsPromises),
            Promise.all(deployCfgPromises)
        ]);
        const vars: Record<string, any> = {};
        const deployConfigs: Record<string, any> = {};
        templateTypes.forEach((t: string, i: number) => {
            try { vars[t] = JSON.parse(varsResults[i] || 'null'); } catch (e) { vars[t] = null; }
            try { deployConfigs[t] = JSON.parse(deployCfgResults[i] || 'null'); } catch (e) { deployConfigs[t] = null; }
        });
        return json({
            accounts,
            autoConfig: JSON.parse(globalCfgRaw || '{}'),
            vars,
            deployConfigs
        });
    } catch (e: any) { console.error('[init_data]', e); return jsonError('数据加载失败'); }
});

}
