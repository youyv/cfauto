/**
 * 路由: 一键修复 1101
 */

import { KV_KEYS, TEMPLATES, BINDING } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { cf, getAuthHeaders, json } from '../lib/cloudflare-api';
import { fetchGithubCode, applyTemplateTransform } from '../lib/github';
import { uploadWorker, parseApiError } from '../lib/deploy-utils';
import { getJSON, putJSON } from "../lib/kv-utils";
import type { AppEnv } from "../config/env";

export async function handleFix1101(env: AppEnv, type: TemplateType) {
    const ACCOUNTS_KEY = KV_KEYS.ACCOUNTS;
    const accounts = await getJSON(env.CONFIG_KV, ACCOUNTS_KEY, []);
    if (accounts.length === 0) return json([{ name: "提示", success: false, msg: "无账号" }]);

    const logs: Array<{ name: string; success: boolean; msg: string }> = [];

    let freshCode: string, latestSha: string | null = null;
    try {
        const result = await fetchGithubCode(type, 'latest', env);
        freshCode = result.code;
        latestSha = result.sha;
    } catch (e: any) {
        return json([{ name: "系统", success: false, msg: `代码下载失败: ${e.message}` }]);
    }

    for (const acc of accounts) {
        const targetWorkers = acc[`workers_${type}`] || [];
        if (targetWorkers.length === 0) {
            logs.push({ name: acc.alias, success: false, msg: "⏭️ 无此类 Worker，跳过" });
            continue;
        }

        const headers = getAuthHeaders(acc.email, acc.globalKey);

        for (const wName of targetWorkers) {
            const logItem = { name: `${acc.alias} → [${wName}]`, success: false, msg: "" };
            const steps: string[] = [];
            try {
                const baseUrl = cf.workerScript(acc.accountId, wName);

                // Step 1: 记录当前变量绑定
                let savedBindings: any[] = [];
                try {
                    const bindRes = await fetch(`${baseUrl}/bindings`, { headers });
                    if (bindRes.ok) {
                        savedBindings = (await bindRes.json()).result || [];
                    }
                } catch (e) { steps.push('\u26a0\ufe0f \u8bb0\u5f55\u7ed1\u5b9a\u5931\u8d25: ' + (e as Error).message); }
                const varCount = savedBindings.filter((b: any) => b.type === 'plain_text').length;
                steps.push(`📋 记录 ${savedBindings.length} 个绑定 (${varCount} 变量)`);

                // Step 1.5: 记录自定义域名
                let savedDomains: any[] = [];
                try {
                    const domainsRes = await fetch(cf.workerDomains(acc.accountId), { headers });
                    if (domainsRes.ok) {
                        const allDomains = (await domainsRes.json()).result || [];
                        savedDomains = allDomains.filter((d: any) => d.service === wName);
                    }
                } catch (e) { steps.push('\u26a0\ufe0f \u8bb0\u5f55\u57df\u540d\u5931\u8d25: ' + (e as Error).message); }
                if (savedDomains.length > 0) steps.push(`🔗 记录 ${savedDomains.length} 个自定义域名`);

                // Step 2: 删除 Worker（不删 KV）
                const delRes = await fetch(baseUrl, { method: "DELETE", headers });
                if (!delRes.ok) {
                    const err = await delRes.json();
                    throw new Error(`删除失败: ${err.errors?.[0]?.message || delRes.status}`);
                }
                steps.push("🗑️ 已删除");

                // Step 3: 随机修改子域名
                try {
                    await fetch(cf.acctSubdomain(acc.accountId), { method: 'DELETE', headers });
                    const randomSub = 'w' + Math.random().toString(36).substring(2, 8) + Math.floor(Math.random() * 99);
                    const subRes = await fetch(cf.acctSubdomain(acc.accountId), {
                        method: 'PUT', headers,
                        body: JSON.stringify({ subdomain: randomSub })
                    });
                    if (subRes.ok) steps.push(`🌐 子域名 → ${randomSub}`);
                    else steps.push("🌐 子域名: 跳过(API限制)");
                } catch (e) { steps.push("🌐 子域名: 跳过"); }

                // Cloudflare API 删除是异步的 — 等待后重建

                // Step 4: 准备部署代码和绑定
                const kvVars = await getJSON(env.CONFIG_KV, KV_KEYS.vars(type), []);
                let deployCode = applyTemplateTransform(type, freshCode, kvVars, { echTokenEnabled: true });
                const kvVarMap = new Map(kvVars.map((v: any) => [v.key, v.value]));

                const restoredBindings = savedBindings.map((b: any) => {
                    if (b.type === 'plain_text' || b.type === 'secret_text') {
                        const kvVal = kvVarMap.get(b.name);
                        const val = (kvVal !== undefined && kvVal !== '') ? kvVal : (b.text || '');
                        return { name: b.name, type: 'plain_text', text: val };
                    }
                    if (b.type === 'kv_namespace') return { name: b.name, type: 'kv_namespace', namespace_id: b.namespace_id };
                    return b;
                });
                for (const [key, value] of kvVarMap) {
                    if (!restoredBindings.find((b: any) => b.name === key)) {
                        restoredBindings.push({ name: key, type: 'plain_text', text: value || '' });
                    }
                }
                const restoredVarCount = restoredBindings.filter((b: any) => b.type === 'plain_text').length;

                                // 指数退避重试重建: 2s, 4s, 8s
                let ok = false, uploadRes = new Response('', { status: 500 });
                for (let attempt = 0; attempt < 3; attempt++) {
                    await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
                    const result = await uploadWorker(acc, wName, deployCode, restoredBindings);
                    if (result.ok) { ok = true; uploadRes = result.res; break; }
                    uploadRes = result.res;
                }

                if (ok) {
                    logItem.success = true;
                    steps.push(`✅ 重建成功 (${restoredVarCount} 变量已恢复)`);

                    if (savedDomains.length > 0) {
                        let domainOk = 0;
                        for (const d of savedDomains) {
                            try {
                                const dRes = await fetch(cf.workerDomains(acc.accountId), {
                                    method: 'PUT', headers,
                                    body: JSON.stringify({ hostname: d.hostname, service: wName, zone_id: d.zone_id, environment: d.environment || 'production' })
                                });
                                if (dRes.ok) domainOk++;
                            } catch (e) { /* domain restore best-effort */ }
                        }
                        steps.push(`🔗 域名恢复 ${domainOk}/${savedDomains.length}`);
                    }
                } else {
                    steps.push(await parseApiError(uploadRes));
                }
            } catch (err: any) {
                steps.push(`❌ ${err.message}`);
            }
            logItem.msg = steps.join(' → ');
            logs.push(logItem);
        }
    }

    const hasSuccess = logs.some(l => l.success);
    if (hasSuccess) {
        const DEPLOY_CONFIG_KEY = KV_KEYS.deployConfig(type);
        await putJSON(env.CONFIG_KV, DEPLOY_CONFIG_KEY, { mode: 'latest', currentSha: latestSha || 'unknown', deployTime: new Date().toISOString() });
    }

    return json(logs);
}
