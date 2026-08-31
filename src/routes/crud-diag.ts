/**
 * CRUD 路由 — 诊断端点 / 部署预览 / 操作日志
 *
 * 从 crud.ts 拆分而来：这些端点只读（或只读 + 聚合），不产生业务副作用，
 * 与写操作混在一起时难以一眼判断某个路由是否会改数据。
 */

import { KV_KEYS } from '../config/templates';
import { json, cf, getAuthHeaders, fetchWithTimeout } from '../lib/cloudflare-api';
import { readAccounts, getWorkerNames } from "../lib/account-store";
import { secretFingerprint } from "../lib/crypto-utils";
import { pooledMap } from "../lib/concurrency";
import { requireTemplateType } from '../lib/validate';
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";
import type { RouteRegistrar } from "./register";

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

export function registerDiagRoutes(ROUTES: { set: RouteRegistrar }) {

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
    const type = new URL(req.url).searchParams.get('type') || '';
    const err = requireTemplateType(type, true);
    if (err) return err;
    const accounts = await readAccounts(env);
    const targetWorkers = accounts.flatMap((a) => getWorkerNames(a, type).map((w) => a.alias + ' -> [' + w + ']'));
    const missingKey = accounts.filter(a => getWorkerNames(a, type).length > 0 && !a.globalKey).map(a => a.alias);
    return json({
        success: true,
        accounts: accounts.filter((a) => getWorkerNames(a, type).length > 0).length,
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
        } catch (e: any) { results[k] = '(error)'; logger.error('diag KV read failed', e instanceof Error ? e : new Error(String(e)), { module: 'crud-diag', key: k }); }
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

}
