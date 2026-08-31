/**
 * CRUD 路由 — KV 直接读写 + 初始化数据聚合
 *
 * 本文件只保留「逐键读写」类路由与 init_data 聚合端点。
 * 备份恢复/导入导出在 crud-backup.ts，诊断类只读端点在 crud-diag.ts。
 * 三者由 registerCrudRoutes 统一注册，对外仍是一个入口。
 */

import { KV_KEYS, TEMPLATES } from '../config/templates';
import { json, jsonError, safeJson } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import { readAccountsMasked, writeAccounts } from "../lib/account-store";
import {
    requireTemplateType, normalizeVariables, normalizeAutoConfig,
    validateAccountsPayload
} from '../lib/validate';
import { logger } from '../lib/logger';
import type { RouteRegistrar } from "./register";
import type { AccountEntry, FavoriteItem } from '../lib/types';
import { registerBackupRoutes } from './crud-backup';
import { registerDiagRoutes } from './crud-diag';

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

export function registerCrudRoutes(ROUTES: { set: RouteRegistrar }) {

// --- 账号 ---
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

// --- 模板全局变量 ---
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

// --- 部署配置 ---
ROUTES.set('GET /api/deploy_config', async (req, env) => {
    const t = readType(req); if ('error' in t) return t.error;
    const defaultCfg = { mode: 'latest', currentSha: null, deployTime: null };
    return rawJson(await env.CONFIG_KV.get(KV_KEYS.deployConfig(t.type), { cacheTtl: 60 }) || JSON.stringify(defaultCfg));
});

// --- 版本收藏 ---
interface FavoriteAction { action: 'add' | 'remove'; item: FavoriteItem; }

/** 收藏上限 — 防止无限增长撑爆 KV 值 */
const MAX_FAVORITES = 200;

ROUTES.set('GET /api/favorites', async (req, env) => {
    const t = readType(req); if ('error' in t) return t.error;
    return rawJson(await env.CONFIG_KV.get(KV_KEYS.favorites(t.type), { cacheTtl: 60 }) || '[]');
});

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

// --- 自动更新全局配置 ---
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

// --- 委托给拆分的子模块 ---
registerBackupRoutes(ROUTES);
registerDiagRoutes(ROUTES);

}
