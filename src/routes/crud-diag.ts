/**
 * CRUD 路由 — 诊断端点 / 部署预览 / 操作日志
 *
 * 从 crud.ts 拆分而来：这些端点只读（或只读 + 聚合），不产生业务副作用，
 * 与写操作混在一起时难以一眼判断某个路由是否会改数据。
 */

import { KV_KEYS, TEMPLATES, isAccountVarsKey } from '../config/templates';
import { json, cf, getAuthHeaders, fetchWithTimeout, readApiResult } from '../lib/cloudflare-api';
import { readAccounts, getWorkerNames, hasAccountCredentials } from "../lib/account-store";
import { secretFingerprint } from "../lib/crypto-utils";
import { getJSON, listAllKeys } from "../lib/kv-utils";
import { collectOrphanKeys, readLiveAccountIds, JOURNAL_RETENTION_DAYS } from "../lib/kv-gc";
import { pooledMap } from "../lib/concurrency";
import { requireTemplateType } from '../lib/validate';
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";
import type { AutoUpdateConfig, DeployConfig } from '../lib/types';
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
        if (!hasAccountCredentials(acc)) {
            return { alias: acc.alias, ok: false, error: '未配置凭据或解密失败，请重新填写 API Key / API Token' };
        }
        if (!acc.accountId) {
            return { alias: acc.alias, ok: false, error: '缺少 Account ID' };
        }
        try {
            const headers = getAuthHeaders(acc);
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
    const missingKey = accounts.filter(a => getWorkerNames(a, type).length > 0 && !hasAccountCredentials(a)).map(a => a.alias);
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
    // KV 占用概览 + 孤儿键数量 —— 让「KV 会不会撑爆」可以被看见而不是靠猜
    results['__kv_usage'] = await kvUsageReport(env).catch((e: unknown) => ({ error: String(e) }));
    // 部署实况漂移 —— 让「面板说已更新、实际没更新」这类账本失真可以被看见
    results['__deploy_drift'] = await deployDriftReport(env).catch((e: unknown) => ({ error: String(e) }));
    results['success'] = true;
    return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } });
});

/**
 * 漂移判定容差：CF 的时间戳精度与"上传 → 元数据可见"之间存在秒级延迟，
 * 留 2 分钟余量，避免刚部署完就被自己的诊断判成漂移。
 */
const DRIFT_TOLERANCE_MS = 120_000;

/**
 * 部署实况漂移检测 —— 把版本账本和 Cloudflare 上脚本的真实修改时间对照。
 *
 * 账本的 `deployTime` 记的是「我们以为部署成功」的时刻，`modified_on` 是脚本实际最后被改
 * 动的时刻。若后者比前者还早（超出容差），说明那次写入根本没落地 —— 正是线上出现过的
 * 「面板显示已更新、Worker 实际停在旧代码且永不重试」。
 *
 * 只读：不改任何 KV，也不碰 Worker。每个涉及的账号只发一次列表请求。
 */
async function deployDriftReport(env: AppEnv) {
    const accounts = await readAccounts(env);

    // 账本里的部署时间（按模板）
    const deployTimeByType = new Map<string, number>();
    for (const t of Object.keys(TEMPLATES)) {
        const cfg = await getJSON<DeployConfig>(env.CONFIG_KV, KV_KEYS.deployConfig(t), { mode: 'latest' });
        const at = cfg.deployTime ? Date.parse(cfg.deployTime) : NaN;
        if (Number.isFinite(at)) deployTimeByType.set(t, at);
    }

    // 按账号归并受管 Worker，避免每个模板各查一次列表
    const perAccount = new Map<string, Array<{ type: string; names: string[] }>>();
    for (const t of Object.keys(TEMPLATES)) {
        for (const a of accounts) {
            if (!deployTimeByType.has(t)) continue;
            const names = getWorkerNames(a, t);
            if (names.length === 0) continue;
            const list = perAccount.get(a.accountId) || [];
            list.push({ type: t, names });
            perAccount.set(a.accountId, list);
        }
    }
    if (perAccount.size === 0) {
        return { checked: 0, drifted: [], missing: [], unreadable: [], note: '暂无可比对的部署记录（先部署一次再看）' };
    }

    const accountById = new Map(accounts.map(a => [a.accountId, a]));
    const reports = await pooledMap(Array.from(perAccount.entries()), async ([accountId, items]) => {
        const acc = accountById.get(accountId);
        const drifted: string[] = [];
        const missing: string[] = [];
        if (!acc || !hasAccountCredentials(acc)) {
            return { drifted, missing, unreadable: acc ? acc.alias + '（未配置凭据或解密失败）' : accountId };
        }
        try {
            const headers = getAuthHeaders(acc);
            const res = await fetchWithTimeout(cf.workerScripts(accountId), { headers });
            const list = await readApiResult<Array<{ id: string; modified_on?: string }>>(res, '读取 Worker 列表') || [];
            const modifiedById = new Map(list.map(w => [w.id, w.modified_on ? Date.parse(w.modified_on) : NaN]));
            for (const item of items) {
                const at = deployTimeByType.get(item.type);
                if (at === undefined) continue;
                for (const name of item.names) {
                    const label = item.type + ' ' + acc.alias + ' -> [' + name + ']';
                    if (!modifiedById.has(name)) { missing.push(label); continue; }
                    const modified = modifiedById.get(name)!;
                    if (Number.isFinite(modified) && modified < at - DRIFT_TOLERANCE_MS) drifted.push(label);
                }
            }
            return { drifted, missing, unreadable: '' };
        } catch (e) {
            logger.warn('deployDriftReport: 账号脚本列表读取失败', { module: 'crud-diag', accountId, error: (e as Error).message });
            return { drifted, missing, unreadable: acc.alias + '（列表读取失败）' };
        }
    });

    const drifted = reports.flatMap(r => r.drifted);
    const missing = reports.flatMap(r => r.missing);
    const unreadable = reports.map(r => r.unreadable).filter(Boolean);
    const checked = Array.from(perAccount.values()).reduce((n, items) => n + items.reduce((m, i) => m + i.names.length, 0), 0);
    const cap = (arr: string[]) => (arr.length > 20 ? [...arr.slice(0, 20), '+' + (arr.length - 20) + ' more'] : arr);

    return {
        checked,
        drifted: cap(drifted),
        missing: cap(missing),
        unreadable,
        note: 'drifted = 账本说已部署，但脚本修改时间早于那次部署（写入未生效）；missing = 账本里有但 Cloudflare 上找不到'
    };
}

/**
 * KV 占用概览：键数量、按类别分布、最大的几个值、孤儿键数量、上次回收时间。
 *
 * 只统计不修改。`journalBytes` 单独列出，因为部署日志是唯一会随使用时长单调增长的值。
 */
async function kvUsageReport(env: AppEnv) {
    const { names, complete } = await listAllKeys(env.CONFIG_KV, '');
    const accountIds = await readLiveAccountIds(env.CONFIG_KV);
    const accountVarsKeys = names.filter(isAccountVarsKey);
    const orphans = accountIds === null ? null : collectOrphanKeys(names.filter(n => n.startsWith('VARS_')), accountIds);

    const journalRaw = await env.CONFIG_KV.get(KV_KEYS.DEPLOY_JOURNAL);
    let journalEntries = 0;
    try { const j = JSON.parse(journalRaw || '[]'); if (Array.isArray(j)) journalEntries = j.length; } catch { /* 损坏值不影响概览 */ }

    const cfg = await getJSON<AutoUpdateConfig>(env.CONFIG_KV, KV_KEYS.GLOBAL_CONFIG, {});
    return {
        totalKeys: names.length,
        listComplete: complete,
        sessions: names.filter(n => n.startsWith('SESSION_')).length,
        rateLimits: names.filter(n => n.startsWith('RATE_LIMIT_')).length,
        accountVars: accountVarsKeys.length,
        orphanAccountVars: orphans === null ? '(账号表不可信，无法判定)' : orphans.length,
        journalEntries,
        journalBytes: journalRaw ? journalRaw.length : 0,
        journalRetentionDays: JOURNAL_RETENTION_DAYS,
        lastGc: cfg.lastGc ? new Date(cfg.lastGc).toISOString() : '(never)',
        note: 'SESSION_/RATE_LIMIT_ 带 TTL 自动过期；孤儿 accountVars 由 cron 每 24h 回收'
    };
}

// --- 部署操作日志 ---
ROUTES.set('GET /api/deploy_journal', async (_req, env) =>
    rawJson(await env.CONFIG_KV.get(KV_KEYS.DEPLOY_JOURNAL, { cacheTtl: 60 }) || '[]'));

}
