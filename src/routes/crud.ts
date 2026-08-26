/**
 * CRUD 路由 — KV 直接读写 + 诊断 + 导入导出备份恢复
 */
import { KV_KEYS, TEMPLATES, isAccountVarsKey } from '../config/templates';
import { json, jsonError, cf, getAuthHeaders, safeJson, fetchWithTimeout } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import { readAccounts, readAccountsMasked, writeAccounts, getWorkerNames } from "../lib/account-store";
import { decryptKey, secretFingerprint } from "../lib/crypto-utils";
import { pooledMap } from "../lib/concurrency";
import {
    requireTemplateType, normalizeVariables, normalizeAutoConfig,
    validateAccountsPayload, MAX_ACCOUNTS
} from '../lib/validate';
import type { AppEnv } from "../config/env";
import type { RouteRegistrar } from "./register";
import type { AccountEntry, FavoriteItem } from '../lib/types';
import { logger } from '../lib/logger';

/** 直接透传 KV 原始 JSON 字符串的响应（避免 parse→stringify 往返） */
function rawJson(body: string): Response {
    return new Response(body, {
        headers: {
            'Content-Type': 'application/json',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY'
        }
    });
}

/** 从 query 读取并校验 type，失败返回错误响应 */
function readType(req: Request, required = false): { type: string } | { error: Response } {
    const type = new URL(req.url).searchParams.get('type') || '';
    const err = requireTemplateType(type, required);
    return err ? { error: err } : { type };
}

/** 备份/恢复覆盖的 KV 键（模板无关的固定键 + 每模板三键） */
export function backupKeys(): string[] {
    const templateTypes = Object.keys(TEMPLATES);
    return [
        KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG, KV_KEYS.DEPLOY_JOURNAL,
        ...templateTypes.flatMap(t => [KV_KEYS.vars(t), KV_KEYS.deployConfig(t), KV_KEYS.favorites(t)])
    ];
}

/**
 * 恢复白名单判定：精确匹配固定键 / 已知模板键 / 合法的账号级变量键。
 *
 * 必须精确匹配而非 startsWith —— 前缀匹配会放行 `VARS_cmliuX`、
 * `ACCOUNTS_UNIFIED_STORAGE_EVIL` 等注入键。导出供单元测试直接覆盖。
 */
export function isRestorableKey(k: string): boolean {
    if (!k || k.startsWith('_')) return false;
    if (backupKeys().includes(k)) return true;
    return isAccountVarsKey(k);
}

export function registerCrudRoutes(ROUTES: { set: RouteRegistrar }) {
// --- KV CRUD 路由（直接内联） ---
ROUTES.set('GET /api/accounts', async (_req, env) => {
    const accounts = await readAccountsMasked(env);
    return json(accounts);
});
ROUTES.set('POST /api/accounts', async (req, env) => {
    const parsed = validateAccountsPayload(await safeJson(req));
    if (!parsed.ok) return parsed.response;
    await writeAccounts(env, parsed.value as unknown as AccountEntry[]);
    logger.audit('accounts saved', { count: parsed.value.length });
    return json({ success: true });
});
ROUTES.set('GET /api/settings', async (req, env) => {
    const t = readType(req); if ('error' in t) return t.error;
    return rawJson(await env.CONFIG_KV.get(KV_KEYS.vars(t.type), { cacheTtl: 60 }) || '[]');
});
ROUTES.set('POST /api/settings', async (req, env) => {
    const t = readType(req); if ('error' in t) return t.error;
    const parsed = normalizeVariables(await safeJson(req));
    if (!parsed.ok) return parsed.response;
    await putJSON(env.CONFIG_KV, KV_KEYS.vars(t.type), parsed.value);
    return json({ success: true, count: parsed.value.length });
});
ROUTES.set('GET /api/deploy_config', async (req, env) => {
    const t = readType(req); if ('error' in t) return t.error;
    const defaultCfg = { mode: 'latest', currentSha: null, deployTime: null };
    return rawJson(await env.CONFIG_KV.get(KV_KEYS.deployConfig(t.type), { cacheTtl: 60 }) || JSON.stringify(defaultCfg));
});
ROUTES.set('GET /api/favorites', async (req, env) => {
    const t = readType(req); if ('error' in t) return t.error;
    return rawJson(await env.CONFIG_KV.get(KV_KEYS.favorites(t.type), { cacheTtl: 60 }) || '[]');
});
interface FavoriteAction { action: 'add' | 'remove'; item: FavoriteItem; }

/** 收藏上限 — 防止无限增长撑爆 KV 值 */
const MAX_FAVORITES = 200;

ROUTES.set('POST /api/favorites', async (req, env) => {
    const t = readType(req); if ('error' in t) return t.error;
    const key = KV_KEYS.favorites(t.type);
    const { action, item } = await safeJson<FavoriteAction>(req);
    if (action !== 'add' && action !== 'remove') return jsonError("Invalid action: 仅支持 'add' | 'remove'", 400, 'VALIDATION_ERROR');
    if (!item || typeof item.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(item.sha)) {
        return jsonError('Invalid item: sha 缺失或格式非法', 400, 'VALIDATION_ERROR');
    }
    let favs = await getJSON<FavoriteItem[]>(env.CONFIG_KV, key, []);
    if (!Array.isArray(favs)) favs = [];
    if (action === 'add') {
        if (favs.length >= MAX_FAVORITES) return jsonError('收藏数量超限（最多 ' + MAX_FAVORITES + ' 条）', 400, 'VALIDATION_ERROR');
        if (!favs.find((f: FavoriteItem) => f.sha === item.sha)) {
            // 只保留已知字段，避免前端把任意负载塞进 KV
            favs.unshift({ sha: item.sha, alias: item.alias, type: item.type, name: item.name, date: item.date, message: item.message });
        }
    } else {
        favs = favs.filter((f: FavoriteItem) => f.sha !== item.sha);
    }
    await putJSON(env.CONFIG_KV, key, favs);
    return json({ success: true, favorites: favs });
});
ROUTES.set('GET /api/auto_config', async (_req, env) =>
    rawJson(await env.CONFIG_KV.get(KV_KEYS.GLOBAL_CONFIG, { cacheTtl: 60 }) || '{}'));
ROUTES.set('POST /api/auto_config', async (req, env) => {
    const incoming = await safeJson<Record<string, unknown>>(req);
    // 前端不发 lastCheck，这里从 KV 取回，避免保存配置时把 cron 的节流状态清零
    const current = await getJSON<Record<string, unknown>>(env.CONFIG_KV, KV_KEYS.GLOBAL_CONFIG, {});
    if (incoming && typeof incoming === 'object' && incoming.lastCheck === undefined && typeof current.lastCheck === 'number') {
        incoming.lastCheck = current.lastCheck;
    }
    const parsed = normalizeAutoConfig(incoming);
    if (!parsed.ok) return parsed.response;
    await putJSON(env.CONFIG_KV, KV_KEYS.GLOBAL_CONFIG, parsed.value);
    logger.audit('auto config saved', { enabled: parsed.value.enabled, interval: parsed.value.interval, fuseThreshold: parsed.value.fuseThreshold });
    return json({ success: true });
});

// --- 诊断端点 ---
ROUTES.set('GET /api/verify_credentials', async (_req, env) => {
    const accounts = await readAccounts(env);
    // 有界并发：CF API 限流 1200 次/5 分钟，账号多时全量并发易被限流
    const results = await pooledMap(accounts, async (acc) => {
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
        } catch (e: any) { return { alias: acc.alias, ok: false, error: e.message }; }
    });
    return json(results);
});

ROUTES.set('GET /api/deploy/preview', async (req, env) => {
    const t = readType(req, true); if ('error' in t) return t.error;
    const accounts = await readAccounts(env);
    const targetWorkers = accounts.flatMap((a) => getWorkerNames(a, t.type).map((w) => a.alias + ' -> [' + w + ']'));
    const missingKey = accounts.filter(a => getWorkerNames(a, t.type).length > 0 && !a.globalKey).map(a => a.alias);
    return json({
        success: true,
        accounts: accounts.filter((a) => getWorkerNames(a, t.type).length > 0).length,
        workers: targetWorkers.length,
        details: targetWorkers,
        ...(missingKey.length > 0 ? { warning: '以下账号密钥缺失，部署会失败: ' + missingKey.join(', ') } : {})
    });
});

ROUTES.set('GET /api/diag', async (_req, env) => {
    // 仅返回关键配置项存在性，不暴露实际 KV 内容
    const keys = [KV_KEYS.ACCOUNTS, KV_KEYS.GLOBAL_CONFIG, KV_KEYS.DEPLOY_JOURNAL];
    const results: Record<string, unknown> = {};
    for (const k of keys) {
        try {
            const v = await env.CONFIG_KV.get(k);
            results[k] = v === null ? '(not set)' : '(exists)';
        } catch (e: any) { results[k] = '(error)'; logger.error('diag KV read failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud', key: k }); }
    }
    results['__kv_bound'] = !!env.CONFIG_KV;
    results['__access_code_set'] = !!env.ACCESS_CODE;
    results['__github_token_set'] = !!env.GITHUB_TOKEN;
    // 独立加密密钥是否启用 —— 未启用时改 ACCESS_CODE 会导致所有已存凭证解密失败
    results['__encryption_secret_set'] = !!env.ENCRYPTION_SECRET;
    results['__encryption_fingerprint'] = await secretFingerprint(env).catch(() => '(unavailable)');
    results['success'] = true;
    return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } });
});


// --- 部署操作日志 ---
ROUTES.set('GET /api/deploy_journal', async (_req, env) =>
    rawJson(await env.CONFIG_KV.get(KV_KEYS.DEPLOY_JOURNAL, { cacheTtl: 60 }) || '[]'));

// --- 账号导入导出 ---
/**
 * 导出账号：密文原样导出，并附带密钥指纹。
 * 指纹让「导入到另一个实例后解密全失败」在导入前就能被诊断出来，
 * 而不是等到每个账号 globalKey 被清空后才提示。
 */
ROUTES.set('GET /api/accounts/export', async (_req, env) => {
    const data = await env.CONFIG_KV.get(KV_KEYS.ACCOUNTS) || '[]';
    let accounts: unknown;
    try { accounts = JSON.parse(data); } catch { accounts = []; }
    const payload = {
        _format: 'worker-pro-accounts@2',
        _time: new Date().toISOString(),
        _encryptionFingerprint: await secretFingerprint(env).catch(() => null),
        accounts
    };
    return new Response(JSON.stringify(payload, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="accounts-export.json"' }
    });
});
ROUTES.set('POST /api/accounts/import', async (req, env) => {
    try {
        const body = await safeJson<unknown>(req);
        // 兼容两种格式：v2 包裹对象 {accounts: [...]} 与旧版裸数组
        let imported: Array<Record<string, any>>;
        let importedFingerprint: string | null = null;
        if (Array.isArray(body)) {
            imported = body;
        } else if (body && typeof body === 'object' && Array.isArray((body as any).accounts)) {
            imported = (body as any).accounts;
            importedFingerprint = (body as any)._encryptionFingerprint || null;
        } else {
            return jsonError('格式错误：需要 JSON 数组或含 accounts 字段的导出文件', 400, 'VALIDATION_ERROR');
        }
        if (imported.length > MAX_ACCOUNTS) return jsonError('导入账号数量超限（最多 ' + MAX_ACCOUNTS + ' 个）', 400, 'VALIDATION_ERROR');

        // 指纹不匹配时提前告知：所有密文都将无法解密
        const localFingerprint = await secretFingerprint(env).catch(() => null);
        const fingerprintMismatch = !!(importedFingerprint && localFingerprint && importedFingerprint !== localFingerprint);

        const existing = await readAccounts(env);
        const merged: AccountEntry[] = [...existing];
        let added = 0, skipped = 0;
        const importedIdx: number[] = [];
        for (const item of imported) {
            if (!item || !item.alias || !item.accountId) { skipped++; continue; }
            const dupIdx = merged.findIndex((a) => a.alias === item.alias || a.accountId === item.accountId);
            if (dupIdx >= 0) { merged[dupIdx] = { ...merged[dupIdx], ...item }; importedIdx.push(dupIdx); skipped++; }
            else { merged.push(item as AccountEntry); importedIdx.push(merged.length - 1); added++; }
        }
        // 仅解密来自 import 的条目（export 数据已加密），避免对已解密的存量条目重复解密
        // 仅解密带 v1: 前缀的已加密值，跳过已解密的存量明文（避免无效 atob + warn）
        const decryptFailed: string[] = [];
        await Promise.all(importedIdx.map(async (i) => {
            const raw = merged[i].globalKey;
            if (raw && /^v\d+:/.test(raw)) {
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
        // 复用统一校验（唯一性 / accountId 格式 / workers_* 结构）
        const validated = validateAccountsPayload(merged);
        if (!validated.ok) return validated.response;
        await writeAccounts(env, merged);
        logger.audit('accounts imported', { added, skipped, total: merged.length, decryptFailed: decryptFailed.length });
        const warnings: string[] = [];
        if (fingerprintMismatch) {
            warnings.push('导出文件来自不同的加密密钥（指纹 ' + importedFingerprint + ' ≠ 本实例 ' + localFingerprint + '），密文无法解密');
        }
        if (decryptFailed.length > 0) {
            warnings.push('以下账号密钥解密失败，已清空需重新输入: ' + decryptFailed.join(', '));
        }
        return json({
            success: true, added,
            skipped: skipped + decryptFailed.length,
            total: merged.length,
            ...(warnings.length > 0 ? { warning: warnings.join('；') } : {})
        });
    } catch (e: any) {
        if (e instanceof Response) return e;
        logger.error('accounts/import failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud' });
        return jsonError('导入失败：数据格式异常');
    }
});

// --- 数据备份恢复 ---
ROUTES.set('GET /api/backup', async (_req, env) => {
    const keys = backupKeys();
    const backup: Record<string, any> = {
        _time: new Date().toISOString(),
        _encryptionFingerprint: await secretFingerprint(env).catch(() => null)
    };
    for (const k of keys) {
        // 备份保留原始格式：JSON 解析失败时回退到原始字符串（不用 getJSON 是因为需要保留损坏数据）
        const raw = await env.CONFIG_KV.get(k);
        try { backup[k] = JSON.parse(raw || 'null'); }
        catch (e) {
            // 非 JSON 值（历史遗留明文）原样备份，并记录以便排查
            backup[k] = raw;
            logger.warn('backup: KV 值非 JSON，按原始字符串备份', { key: k, error: (e as Error).message });
        }
    }
    // 账号级变量覆盖（VARS_<type>_ACC_<id>）数量不定，用 list 枚举
    try {
        const listed = await env.CONFIG_KV.list({ prefix: 'VARS_' });
        for (const { name } of listed.keys) {
            if (!isAccountVarsKey(name)) continue;
            const raw = await env.CONFIG_KV.get(name);
            try { backup[name] = JSON.parse(raw || 'null'); } catch { backup[name] = raw; }
        }
    } catch (e) { logger.warn('backup: 账号级变量枚举失败', { error: (e as Error).message }); }

    return new Response(JSON.stringify(backup, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="worker-backup.json"' }
    });
});

/** 恢复白名单判定：精确匹配固定键 / 已知模板键 / 合法的账号级变量键 */
ROUTES.set('POST /api/restore', async (req, env) => {
    try {
        const backup = await safeJson<Record<string, unknown>>(req);
        if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
            return jsonError('恢复失败：备份文件必须是 JSON 对象', 400, 'VALIDATION_ERROR');
        }
        let restored = 0, rejected = 0;
        const rejectedKeys: string[] = [];
        for (const [k, v] of Object.entries(backup)) {
            if (k.startsWith('_')) continue;
            if (!isRestorableKey(k)) {
                rejected++;
                if (rejectedKeys.length < 10) rejectedKeys.push(k);
                continue;
            }
            if (v === null || v === undefined) continue;
            await env.CONFIG_KV.put(k, typeof v === 'string' ? v : JSON.stringify(v));
            restored++;
        }
        logger.audit('data restored', { restored, rejected });
        const fp = (backup as any)._encryptionFingerprint;
        const localFp = await secretFingerprint(env).catch(() => null);
        const warning = fp && localFp && fp !== localFp
            ? '备份来自不同的加密密钥，恢复后账号 API Key 需重新填写'
            : undefined;
        return json({ success: true, restored, rejected, ...(rejectedKeys.length ? { rejectedKeys } : {}), ...(warning ? { warning } : {}) });
    } catch (e: any) {
        if (e instanceof Response) return e;
        logger.error('restore failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud' });
        return jsonError('恢复失败：备份数据异常');
    }
});

// --- 初始化数据合并端点：单次请求替代多次 fetch ---
ROUTES.set('GET /api/init_data', async (req, env) => {
    try {
        const requestedTypes = new URL(req.url).searchParams.get('types');
        const templateTypes = requestedTypes
            ? requestedTypes.split(',').map((t: string) => t.trim()).filter((t: string) => TEMPLATES[t])
            : Object.keys(TEMPLATES);

        const [globalCfgRaw, accounts, varsResults, deployCfgResults] = await Promise.all([
            env.CONFIG_KV.get(KV_KEYS.GLOBAL_CONFIG, { cacheTtl: 60 }),
            readAccountsMasked(env),
            Promise.all(templateTypes.map((t: string) => env.CONFIG_KV.get(KV_KEYS.vars(t), { cacheTtl: 60 }))),
            Promise.all(templateTypes.map((t: string) => env.CONFIG_KV.get(KV_KEYS.deployConfig(t), { cacheTtl: 60 })))
        ]);

        const vars: Record<string, any> = {};
        const deployConfigs: Record<string, any> = {};
        templateTypes.forEach((t: string, i: number) => {
            try { vars[t] = JSON.parse(varsResults[i] || 'null'); }
            catch (e) { vars[t] = null; logger.warn('init_data: VARS 解析失败', { type: t, error: (e as Error).message }); }
            try { deployConfigs[t] = JSON.parse(deployCfgResults[i] || 'null'); }
            catch (e) { deployConfigs[t] = null; logger.warn('init_data: DEPLOY_CONFIG 解析失败', { type: t, error: (e as Error).message }); }
        });

        let autoConfig: unknown = {};
        try { autoConfig = JSON.parse(globalCfgRaw || '{}'); }
        catch (e) { logger.warn('init_data: AUTO_CONFIG 解析失败', { error: (e as Error).message }); }

        return json({ accounts, autoConfig, vars, deployConfigs });
    } catch (e: any) { logger.error('init_data failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud' }); return jsonError('数据加载失败'); }
});

}
