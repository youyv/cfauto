/**
 * CRUD 路由 — KV 直接读写 + 诊断 + 导入导出备份恢复
 */
import { KV_KEYS, TEMPLATES } from '../config/templates';
import { json, jsonError, cf, getAuthHeaders, safeJson, fetchWithTimeout } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import { readAccounts, readAccountsMasked, writeAccounts, getWorkerNames } from "../lib/account-store";
import { decryptKey } from "../lib/crypto-utils";
import { requireTemplateType } from '../lib/validate';
import type { AppEnv } from "../config/env";
import type { RouteHandler } from "./register";
import type { FavoriteItem } from '../lib/types';
import { logger } from '../lib/logger';

export function registerCrudRoutes(ROUTES: Map<string, RouteHandler>) {
// --- KV CRUD 路由（直接内联） ---
ROUTES.set('GET /api/accounts', async (_req, env) => {
    const accounts = await readAccountsMasked(env);
    return new Response(JSON.stringify(accounts), { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('POST /api/accounts', async (req, env) => {
    const accounts = await safeJson(req);
    // 结构校验：必须是数组、条目必填 alias/accountId、限制数量防止撑爆 KV
    if (!Array.isArray(accounts)) return jsonError('格式错误：需要 JSON 数组');
    if (accounts.length > 500) return jsonError('账号数量超限（最多 500 个）');
    for (const a of accounts) {
        if (!a || typeof a.alias !== 'string' || !a.alias.trim() || typeof a.accountId !== 'string' || !a.accountId.trim()) {
            return jsonError('格式错误：每条账号必须包含非空 alias 和 accountId');
        }
    }
    await writeAccounts(env, accounts);
    return json({ success: true });
});
ROUTES.set('GET /api/settings', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type') || '';
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    return new Response(await env.CONFIG_KV.get(KV_KEYS.vars(type || ''), {cacheTtl: 60}) || '[]', { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('POST /api/settings', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type') || '';
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    await putJSON(env.CONFIG_KV, KV_KEYS.vars(type || ''), await safeJson(req));
    return json({ success: true });
});
ROUTES.set('GET /api/deploy_config', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type') || '';
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    const key = KV_KEYS.deployConfig(type || '');
    const defaultCfg = { mode: 'latest', currentSha: null, deployTime: null };
    return new Response(await env.CONFIG_KV.get(key, {cacheTtl: 60}) || JSON.stringify(defaultCfg), { headers: { 'Content-Type': 'application/json' } });
});
ROUTES.set('GET /api/favorites', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type') || '';
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    return new Response(await env.CONFIG_KV.get(KV_KEYS.favorites(type || ''), {cacheTtl: 60}) || '[]', { headers: { 'Content-Type': 'application/json' } });
});
interface FavoriteAction { action: 'add' | 'remove'; item: FavoriteItem; }

ROUTES.set('POST /api/favorites', async (req, env) => {
    const type = new URL(req.url).searchParams.get('type') || '';
    const templateErr = requireTemplateType(type, false); if (templateErr) return templateErr;
    const key = KV_KEYS.favorites(type || '');
    const { action, item } = await safeJson<FavoriteAction>(req);
    let favs = await getJSON<FavoriteItem[]>(env.CONFIG_KV, key, []);
    if (action !== 'add' && action !== 'remove') return jsonError("Invalid action: 仅支持 'add' | 'remove'", 400, 'VALIDATION_ERROR');
    if (!item || typeof item.sha !== 'string' || !item.sha) return jsonError('Invalid item: 缺少 sha', 400, 'VALIDATION_ERROR');
    if (action === 'add') { if (!favs.find((f: FavoriteItem) => f.sha === item.sha)) favs.unshift(item); }
    else { favs = favs.filter((f: FavoriteItem) => f.sha !== item.sha); }
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
ROUTES.set('GET /api/verify_credentials', async (_req, env) => {
        const accounts = await readAccounts(env);
        // 分批节流：Cloudflare API 限流 1200 次/5 分钟，账号多时全量并发易被限流
        const BATCH_SIZE = 5;
        const results: Array<{ alias: string; ok: boolean; status?: number; error?: string }> = [];
        for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
            const batch = accounts.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async (acc) => {
                // readAccounts 解密失败（ENCRYPTION_SECRET/ACCESS_CODE 变更）时会清空 globalKey，
                // 此时发请求毫无意义，直接给出可操作的提示
                if (!acc.globalKey) {
                    return { alias: acc.alias, ok: false, error: '密钥缺失或解密失败，请重新填写 API Key' };
                }
                if (!acc.accountId) {
                    return { alias: acc.alias, ok: false, error: '缺少 Account ID' };
                }
                try {
                    const headers = getAuthHeaders(acc.email, acc.globalKey);
                    // 用 /accounts/{aid}：支持 Global API Key，且同时验证 accountId 归属
                    const res = await fetchWithTimeout(cf.account(acc.accountId), { method: 'GET', headers });
                    if (res.ok) return { alias: acc.alias, ok: true, status: res.status };
                    // 解析 CF 真实错误消息（9103 = 凭据无效，7003 = accountId 不存在/无权限）
                    let msg = 'HTTP ' + res.status;
                    try {
                        const body: any = await res.json();
                        const cfMsg = body?.errors?.[0]?.message;
                        if (cfMsg) msg = cfMsg;
                    } catch (pe) { logger.warn('verify_credentials: 错误响应非 JSON', { alias: acc.alias, status: res.status }); }
                    return { alias: acc.alias, ok: false, status: res.status, error: msg };
                } catch(e: any) { return { alias: acc.alias, ok: false, error: e.message }; }
            }));
            results.push(...batchResults);
            if (i + BATCH_SIZE < accounts.length) await new Promise(r => setTimeout(r, 200));
        }
        return json(results);
    });

ROUTES.set('GET /api/deploy/preview', async (req, env) => {
        const type = new URL(req.url).searchParams.get('type') || '';
        const accounts = await readAccounts(env);
        const targetWorkers = accounts.flatMap((a) => getWorkerNames(a, type).map((w) => a.alias + ' -> [' + w + ']'));
        return json({ success: true, accounts: accounts.filter((a) => getWorkerNames(a, type).length > 0).length, workers: targetWorkers.length, details: targetWorkers });
    });

ROUTES.set('GET /api/diag', async (_req, env) => {
    // 仅返回关键配置项存在性，不暴露实际 KV 内容
    const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG];
    const results: Record<string, unknown> = {};
    for (const k of keys) {
        try {
            const v = await env.CONFIG_KV.get(k);
            results[k] = v === null ? '(not set)' : '(exists)';
        } catch (e: any) { results[k] = '(error)'; logger.error('diag KV read failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud', key: k }); }
    }
    results['__kv_bound'] = !!env.CONFIG_KV;
    results['success'] = true;
    return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } });
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
        const decryptFailed: string[] = [];
        await Promise.all(importedIdx.map(async (i) => {
            const raw = merged[i].globalKey;
            if (raw && raw.match(/^v\d+:/)) {
                const dec = await decryptKey(env, raw);
                if (dec === raw) {
                    // 解密失败（密钥不匹配/数据损坏）→ 置空并提示，防止 writeAccounts 再次加密导致双重加密
                    merged[i].globalKey = '';
                    decryptFailed.push(merged[i].alias || merged[i].accountId);
                } else {
                    merged[i].globalKey = dec;
                }
            }
        }));
        await writeAccounts(env, merged);
        if (decryptFailed.length > 0) {
            return json({ success: true, added, skipped: skipped + decryptFailed.length, total: merged.length, warning: '以下账号密钥解密失败（可能密钥已变更），已清空需重新输入: ' + decryptFailed.join(', ') });
        }
        return json({ success: true, added, skipped, total: merged.length });
    } catch (e: any) { logger.error('accounts/import failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud' }); return jsonError('导入失败：数据格式异常'); }
});

// --- 数据备份恢复 ---
ROUTES.set('GET /api/backup', async (_req, env) => {
    const templateTypes = Object.keys(TEMPLATES);
    const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG,
        ...templateTypes.flatMap(t => [KV_KEYS.vars(t), KV_KEYS.deployConfig(t), KV_KEYS.favorites(t)])];
    const backup: Record<string, any> = { _time: new Date().toISOString() };
    for (const k of keys) {
        // 备份保留原始格式：JSON 解析失败时回退到原始字符串（不用 getJSON 是因为需要保留损坏数据）
        try { backup[k] = JSON.parse(await env.CONFIG_KV.get(k) || 'null'); }
        catch (e) {
            // 非 JSON 值（历史遗留明文）原样备份，并记录以便排查
            backup[k] = await env.CONFIG_KV.get(k);
            logger.warn('backup: KV 值非 JSON，按原始字符串备份', { key: k, error: (e as Error).message });
        }
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
            // 精确匹配或"前缀 + 已知模板类型"，避免 VARS_cmliuX / ACCOUNTS_..._X 之类前缀注入
            const isAllowed = allowedPrefixes.some(p => k === p)
                || Object.keys(TEMPLATES).some(t => k === 'VARS_' + t || k === 'DEPLOY_CONFIG_' + t || k === 'FAVORITES_' + t);
            if (!isAllowed) {
                rejected++;
                continue;
            }
            await env.CONFIG_KV.put(k, typeof v === 'string' ? v : JSON.stringify(v));
            restored++;
        }
        return json({ success: true, restored, rejected });
    } catch (e: any) { logger.error('restore failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud' }); return jsonError('恢复失败：备份数据异常'); }
});

// --- 初始化数据合并端点：单次请求替代多次 fetch ---
ROUTES.set('GET /api/init_data', async (req, env) => {
    try {
        const requestedTypes = new URL(req.url).searchParams.get('types');
        const templateTypes = requestedTypes
            ? requestedTypes.split(',').filter((t: string) => TEMPLATES[t]).map((t: string) => t.trim())
            : Object.keys(TEMPLATES);
        const [globalCfgRaw] = await Promise.all([
            env.CONFIG_KV.get(KV_KEYS.GLOBAL_CONFIG, {cacheTtl: 60})
        ]);
        const accounts = await readAccounts(env);
        const varsPromises = templateTypes.map((t: string) => env.CONFIG_KV.get(KV_KEYS.vars(t)));
        const deployCfgPromises = templateTypes.map((t: string) => env.CONFIG_KV.get(KV_KEYS.deployConfig(t)));
        const [varsResults, deployCfgResults] = await Promise.all([
            Promise.all(varsPromises),
            Promise.all(deployCfgPromises)
        ]);
        const vars: Record<string, any> = {};
        const deployConfigs: Record<string, any> = {};
        templateTypes.forEach((t: string, i: number) => {
            try { vars[t] = JSON.parse(varsResults[i] || 'null'); }
            catch (e) { vars[t] = null; logger.warn('init_data: VARS 解析失败', { type: t, error: (e as Error).message }); }
            try { deployConfigs[t] = JSON.parse(deployCfgResults[i] || 'null'); }
            catch (e) { deployConfigs[t] = null; logger.warn('init_data: DEPLOY_CONFIG 解析失败', { type: t, error: (e as Error).message }); }
        });
        return json({
            accounts,
            autoConfig: JSON.parse(globalCfgRaw || '{}'),
            vars,
            deployConfigs
        });
    } catch (e: any) { logger.error('init_data failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud' }); return jsonError('数据加载失败'); }
});

}
