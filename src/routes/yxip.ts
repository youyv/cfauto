/**
 * 路由: YXIP 优选节点 — 获取区域数据 + 保存节点
 */

import { TEMPLATES, KV_KEYS } from '../config/templates';
import { cf, getAuthHeaders, json, jsonError, fetchWithTimeout, readApiResult } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import { readAccounts, getWorkerNames } from "../lib/account-store";
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";
import type { VariableEntry } from '../lib/types';

/** 特殊 target：把优选节点写进 joey 的全局变量 `yx`（无 KV 模式） */
export const YXIP_TARGET_JOEY_VAR = 'joey_var';

/** 优选节点数据源 */
const REGIONS_SOURCE_URL = 'https://zip.cm.edu.kg/all.txt';
/** 上游节点列表的体积上限（防止异常巨大响应耗尽内存） */
const MAX_REGIONS_BYTES = 2 * 1024 * 1024;

export interface YxipSaveRequest {
    /** 模板类型，或 YXIP_TARGET_JOEY_VAR */
    type: string;
    accountId?: string;
    rawContent: string;
}

/** 解析 `ip:port#CODE` 形式的节点列表 → 按区域分组。纯函数，供测试覆盖 */
export function parseRegionPools(text: string): Record<string, Array<{ line: string; code: string; ipPort: string }>> {
    const pools: Record<string, Array<{ line: string; code: string; ipPort: string }>> = {};
    for (const rawLine of text.replace(/^\uFEFF/, '').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || !line.includes('#')) continue;
        const hashAt = line.indexOf('#');
        const ipPort = line.slice(0, hashAt).trim();
        const code = line.slice(hashAt + 1).trim().toUpperCase();
        if (!code || !ipPort) continue;
        if (!pools[code]) pools[code] = [];
        pools[code].push({ line, code, ipPort });
    }
    return pools;
}

/** 提取并返回全球区域节点的基础数据 */
export async function handleGetRegionsData() {
    try {
        const response = await fetchWithTimeout(REGIONS_SOURCE_URL, {}, 8000);
        // 此前不判 res.ok：上游 503 的 HTML 错误页会被当作节点列表解析，然后返回 success:true + 空数据
        if (!response.ok) {
            return jsonError('节点数据源返回 HTTP ' + response.status + '，请稍后重试', 502, 'CF_API_ERROR');
        }
        const text = await response.text();
        if (text.length > MAX_REGIONS_BYTES) {
            return jsonError('节点数据源响应过大（' + (text.length / 1024 / 1024).toFixed(1) + ' MB），已中止', 502, 'CF_API_ERROR');
        }
        const regionPools = parseRegionPools(text);
        if (Object.keys(regionPools).length === 0) {
            return jsonError('节点数据源格式异常（未解析出任何区域），可能上游已变更', 502, 'CF_API_ERROR');
        }
        return json({ success: true, data: regionPools });
    } catch (e: any) {
        logger.error('handleGetRegionsData failed', e instanceof Error ? e : new Error(String(e)), { module: 'yxip' });
        return jsonError('节点数据获取失败: ' + (e?.message || 'unknown'), 502, 'CF_API_ERROR');
    }
}

/** 保存优选节点逻辑 */
export async function handleSaveYxip(env: AppEnv, reqData: YxipSaveRequest) {
    const { type, accountId, rawContent } = reqData || ({} as YxipSaveRequest);

    if (typeof rawContent !== 'string' || rawContent.trim() === '') {
        return json([{ name: "参数错误", success: false, msg: "节点内容为空" }], 400);
    }

    // Joey 无 KV 模式：覆盖全局变量
    if (type === YXIP_TARGET_JOEY_VAR) {
        const VARS_KEY = KV_KEYS.vars('joey');
        try {
            const variables = await getJSON<VariableEntry[]>(env.CONFIG_KV, VARS_KEY, []);
            const list = Array.isArray(variables) ? variables : [];
            const idx = list.findIndex((v) => v && v.key === 'yx');
            const entry: VariableEntry = { key: 'yx', value: rawContent };
            if (idx !== -1) list[idx] = entry; else list.push(entry);
            await putJSON(env.CONFIG_KV, VARS_KEY, list);
            return json([{ name: "Joey 全局变量 (无 KV 模式)", success: true, msg: "✅ 变量 [yx] 已成功覆盖至全体记录供稍后部署使用", type: 'joey' }]);
        } catch (e: any) {
            logger.error('handleSaveYxip joey_var failed', e instanceof Error ? e : new Error(String(e)), { module: 'yxip' });
            return json([{ name: "写入错误", success: false, msg: e.message }], 500);
        }
    }

    // KV 模式：需要模板声明了 yxipKey 与 kvBindingName
    const t = TEMPLATES[type];
    if (!t) return json([{ name: "参数错误", success: false, msg: "未知的请求类型: " + type }], 400);
    if (!t.kvBindingName || !t.yxipKey) {
        return json([{ name: "不支持", success: false, msg: `${t.name} 未配置 KV 优选节点，无法写入` }], 400);
    }
    if (!accountId) return json([{ name: "配置错误", success: false, msg: "未提供账户 ID" }], 400);

    try {
        const accounts = await readAccounts(env);
        const targetAccount = accounts.find((a) => a.accountId === accountId);
        if (!targetAccount) return json([{ name: "查找错误", success: false, msg: "系统记录中找不到该账户" }], 404);
        if (!targetAccount.globalKey) {
            return json([{ name: "凭据错误", success: false, msg: "该账号密钥缺失或解密失败，请重新填写 Global API Key" }], 400);
        }

        const targetWorkers = getWorkerNames(targetAccount, type);
        if (targetWorkers.length === 0) {
            return json([{ name: "查找错误", success: false, msg: `该账号下未发现已部署的 ${t.name} 项目` }]);
        }

        const logs: Array<{ name: string; success: boolean; msg: string }> = [];
        // 使用服务端存储的凭证，而非请求体中的（防止凭证伪造）
        const jsonHeaders = getAuthHeaders(targetAccount.email, targetAccount.globalKey);
        const finalContent = t.yxipBuildContent ? t.yxipBuildContent(rawContent) : rawContent;
        const contentType = t.yxipContentType || 'text/plain';

        for (const wName of targetWorkers) {
            const logItem = { name: `[${t.name}] ${wName}`, success: false, msg: "" };
            try {
                const bindRes = await fetchWithTimeout(cf.workerBindings(targetAccount.accountId, wName), { headers: jsonHeaders });
                const binds = await readApiResult<Array<{ type: string; name: string; namespace_id?: string }>>(bindRes, '读取绑定') || [];
                const kvBind = binds.find((b) => b.type === 'kv_namespace' && b.name === t.kvBindingName);
                if (!kvBind || !kvBind.namespace_id) {
                    logItem.msg = `❌ 该项目未绑定名为 ${t.kvBindingName} 的核心配置空间`;
                } else {
                    const putRes = await fetchWithTimeout(cf.kvValue(targetAccount.accountId, kvBind.namespace_id, t.yxipKey), {
                        method: "PUT",
                        headers: { ...jsonHeaders, "Content-Type": contentType },
                        body: finalContent
                    });

                    if (putRes.ok) {
                        logItem.success = true;
                        logItem.msg = `✅ 已更新对应命名空间的 ${t.yxipKey}`;
                    } else {
                        let msg = `HTTP ${putRes.status}`;
                        try { const errBody: any = await putRes.json(); msg = errBody.errors?.[0]?.message || msg; } catch { /* 非 JSON */ }
                        logItem.msg = `❌ 写入失败: ${msg}`;
                    }
                }
            } catch (e: any) { logItem.msg = `❌ ${e.message}`; }
            logs.push(logItem);
        }
        if (logs.some(l => l.success)) {
            logger.audit('yxip saved', { type, accountId, workers: logs.filter(l => l.success).length });
        }
        return json(logs);
    } catch (e: any) {
        logger.error('handleSaveYxip failed', e instanceof Error ? e : new Error(String(e)), { module: 'yxip' });
        return json([{ name: "执行异常", success: false, msg: e.message }], 500);
    }
}
