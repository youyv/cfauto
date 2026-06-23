/**
 * 路由: YXIP 优选节点 — 获取区域数据 + 保存节点
 */

import { TEMPLATES, KV_KEYS } from '../config/templates';
import { cf, getAuthHeaders, json } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import type { AppEnv } from "../config/env";

/** 提取并返回全球区域节点的基础数据 */
export async function handleGetRegionsData() {
    try {
        const response = await fetch("https://zip.cm.edu.kg/all.txt");
        let text = await response.text();
        text = text.replace(/^\uFEFF/, '');
        const lines = text.split('\n');

        const regionPools: Record<string, Array<{ line: string; code: string; ipPort: string }>> = {};
        for (const line of lines) {
            if (!line.includes('#')) continue;
            const parts = line.split('#');
            const code = parts[1] ? parts[1].trim().toUpperCase() : '';
            const ipPort = parts[0].trim();

            if (code) {
                if (!regionPools[code]) regionPools[code] = [];
                regionPools[code].push({ line, code, ipPort });
            }
        }
        return new Response(JSON.stringify({ success: true, data: regionPools }), {
            headers: { 'content-type': 'application/json; charset=UTF-8' }
        });
    } catch (e: any) {
        return new Response(JSON.stringify({ success: false, msg: "Error fetching data: " + e.message }), { status: 500 });
    }
}

/** 保存优选节点逻辑 */
export async function handleSaveYxip(env: AppEnv, reqData: any) {
    const { type, accountId, email, globalKey, rawContent } = reqData;

    // Joey 无 KV 模式：覆盖全局变量
    if (type === 'joey_var') {
        const VARS_KEY = KV_KEYS.vars('joey');
        try {
            let variables = await getJSON(env.CONFIG_KV, VARS_KEY, []);
            const idx = variables.findIndex((v: any) => v.key === 'yx');
            if (idx !== -1) {
                variables[idx] = { key: 'yx', type: "plain_text", value: rawContent };
            } else {
                variables.push({ key: 'yx', type: "plain_text", value: rawContent });
            }
            await putJSON(env.CONFIG_KV, VARS_KEY, variables);
            return json([{ name: "Joey 全局变量 (无 KV 模式)", success: true, msg: "✅ 变量 [yx] 已成功覆盖至全体记录供稍后部署使用", type: 'joey' }]);
        } catch (e: any) {
            return new Response(JSON.stringify([{ name: "写入错误", success: false, msg: e.message }]), { status: 500 });
        }
    }

    // KV 模式：cmliu 或 joey
    if (type === 'cmliu' || type === 'joey') {
        if (!accountId || !email || !globalKey) return new Response(JSON.stringify([{ name: "配置错误", success: false, msg: "未提供对应账户凭证" }]), { status: 400 });

        try {
            const accounts = await getJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []);
            const targetAccount = accounts.find((a: any) => a.accountId === accountId);
            if (!targetAccount) return new Response(JSON.stringify([{ name: "查找错误", success: false, msg: "系统记录中找不到该账户" }]), { status: 404 });

            const targetWorkers = type === 'cmliu' ? targetAccount.workers_cmliu : targetAccount.workers_joey;
            const workerTypeName = type === 'cmliu' ? 'CMLiu' : 'Joey';
            if (!targetWorkers || targetWorkers.length === 0) return new Response(JSON.stringify([{ name: "查找错误", success: false, msg: `该账号下未发现已部署的 ${workerTypeName} 项目` }]), { status: 200 });

            const logs: Array<{ name: string; success: boolean; msg: string }> = [];
            const jsonHeaders = getAuthHeaders(email, globalKey);

            for (const wName of targetWorkers) {
                const logItem = { name: `[${workerTypeName}] ${wName}`, success: false, msg: "" };
                try {
                    const bindRes = await fetch(cf.workerBindings(accountId, wName), { headers: jsonHeaders });
                    if (!bindRes.ok) throw new Error("无法读取绑定的变量");

                    const t = TEMPLATES[type];
                    const binds = (await bindRes.json()).result;
                    const kvBind = binds.find((b: any) => b.type === 'kv_namespace' && b.name === t.kvBindingName);
                    if (!kvBind) {
                        logItem.msg = `❌ 该项目未绑定名为 ${t.kvBindingName} 的核心配置空间`;
                    } else {
                        const nsId = kvBind.namespace_id;
                        const targetKey = t.yxipKey || 'ADD.txt';
                        const finalContent = t.yxipBuildContent ? t.yxipBuildContent(rawContent) : rawContent;
                        const contentType = t.yxipContentType || 'text/plain';

                        const putRes = await fetch(cf.kvValue(accountId, nsId, targetKey), {
                            method: "PUT",
                            headers: { ...jsonHeaders, "Content-Type": contentType },
                            body: finalContent
                        });

                        if (putRes.ok) {
                            logItem.success = true;
                            logItem.msg = `✅ 已更新对应命名空间的 ${targetKey}`;
                        } else {
                            try { const errBody = await putRes.json(); logItem.msg = `❌ 写入失败: ${errBody.errors?.[0]?.message || 'Unknown error'}`; } catch(e) { logItem.msg = `❌ HTTP ${putRes.status}: ${putRes.statusText}`; }
                        }
                    }
                } catch (e: any) { logItem.msg = `❌ ${e.message}`; }
                logs.push(logItem);
            }
            return json(logs);
        } catch (e: any) {
            return new Response(JSON.stringify([{ name: "执行异常", success: false, msg: e.message }]), { status: 500 });
        }
    }

    return new Response(JSON.stringify([{ name: "参数错误", success: false, msg: "未知的请求类型: " + type }]), { status: 400 });
}
