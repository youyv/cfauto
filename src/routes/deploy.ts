/**
 * 路由: 部署逻辑 — 手动部署、批量部署、核心部署逻辑
 */

import { KV_KEYS, TEMPLATES } from '../config/templates';
import { cf, getAuthHeaders, getUploadHeaders } from '../lib/cloudflare-api';
import { fetchGithubCode, applyTemplateTransform } from '../lib/github';

/**
 * 核心部署逻辑 — 更新已有 Worker 的脚本和变量
 * 
 * 流程：
 *   1. 从 GitHub 拉取最新代码（或使用前端提供的 customCode）
 *   2. 应用模板转换（joey 前缀、ech proxy/token 替换）
 *   3. 遍历目标账号，读取已有绑定 → 合并变量 → 上传 Worker
 *   4. 成功后更新 DEPLOY_CONFIG KV 记录
 */
export async function coreDeployLogic(
    env: any, type: string, variables: Array<{ key: string; value: string }>,
    deletedVariables: string[], accountsKey: string,
    targetSha: string | null, customCode: string | null = null,
    echTokenEnabled = false, echDisableWorkersDev = false,
    targetAccountIds: string[] | null = null
) {
    try {
        const isLatestMode = !targetSha || targetSha === 'latest';
        const shaForFetch = isLatestMode ? null : targetSha;

        let accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
        if (targetAccountIds && targetAccountIds.length > 0) {
            accounts = accounts.filter((a: any) => targetAccountIds.includes(a.accountId));
        }
        if (accounts.length === 0) return [{ name: "提示", success: false, msg: "无账号配置" }];

        let githubScriptContent = "";
        let deployedSha: string | null = shaForFetch;

        // [步骤1] 获取代码 — 前端提供混淆代码 或 从 GitHub 拉取
        if (customCode) {
            githubScriptContent = customCode;
            if (!deployedSha) {
                try {
                    const { sha } = await fetchGithubCode(type, 'latest', env);
                    if (sha) deployedSha = sha;
                } catch (e) { /* SHA 非必需 */ }
            }
        } else {
            try {
                const { code, sha } = await fetchGithubCode(type, shaForFetch, env);
                githubScriptContent = code;
                if (!deployedSha && sha) deployedSha = sha;
            } catch (e: any) { return [{ name: "网络错误", success: false, msg: e.message }]; }
        }

        // [步骤2] 模板特有转换（joey 前缀 / ech proxy 替换 / ech token 注入）
        githubScriptContent = applyTemplateTransform(type, githubScriptContent, variables, { echTokenEnabled });

        // [步骤3] 遍历账号 → 读取绑定 → 合并变量 → 上传
        const logs: Array<{ name: string; success: boolean; msg: string }> = [];
        for (const acc of accounts) {
            const targetWorkers = acc[`workers_${type}`] || [];
            for (const wName of targetWorkers) {
                const logItem = { name: `${acc.alias} -> [${wName}]`, success: false, msg: "" };
                try {
                    const baseUrl = cf.workerScript(acc.accountId, wName);
                    const jsonHeaders = getAuthHeaders(acc.email, acc.globalKey);

                    const bindingsRes = await fetch(`${baseUrl}/bindings`, { headers: jsonHeaders });
                    let currentBindings = bindingsRes.ok ? (await bindingsRes.json()).result : [];
                    if (deletedVariables && deletedVariables.length > 0) {
                        currentBindings = currentBindings.filter((b: any) => !deletedVariables.includes(b.name));
                    }

                    if (variables) {
                        variables.forEach(v => {
                            if (v.value && v.value.trim() !== "") {
                                const bindingType = (v as any).secret ? "secret_text" : "plain_text";
                                const idx = currentBindings.findIndex((b: any) => b.name === v.key);
                                if (idx !== -1) currentBindings[idx] = { name: v.key, type: bindingType, text: v.value };
                                else currentBindings.push({ name: v.key, type: bindingType, text: v.value });
                            }
                        });
                    }

                    const metadata = { main_module: "index.js", bindings: currentBindings, compatibility_date: new Date().toISOString().split('T')[0] };
                    const formData = new FormData();
                    formData.append("metadata", JSON.stringify(metadata));
                    formData.append("script", new Blob([githubScriptContent], { type: "application/javascript+module" }), "index.js");

                    const uploadHeaders = getUploadHeaders(acc.email, acc.globalKey);
                    const updateRes = await fetch(baseUrl, { method: "PUT", headers: uploadHeaders, body: formData });

                    if (updateRes.ok) {
                        logItem.success = true;
                        const msgs = [`✅ Ver: ${deployedSha ? deployedSha.substring(0, 7) : 'Unknown'}`];
                        if (type === 'ech') {
                            try {
                                await fetch(cf.workerSubdomain(acc.accountId, wName), {
                                    method: 'POST', headers: jsonHeaders,
                                    body: JSON.stringify({ enabled: !echDisableWorkersDev })
                                });
                                msgs.push(echDisableWorkersDev ? '🚫 默认域名已禁用' : '🌐 默认域名已启用');
                            } catch (e) { msgs.push('⚠️ 域名状态设置失败'); }
                        }
                        logItem.msg = msgs.join(' | ');
                    } else {
                        try { const e = await updateRes.json(); logItem.msg = `❌ ${e.errors?.[0]?.message || "API error"}`; } catch(_) { logItem.msg = `❌ HTTP ${updateRes.status}`; }
                    }
                } catch (err: any) { logItem.msg = `❌ ${err.message}`; }
                logs.push(logItem);
            }
        }

        const hasSuccess = logs.some(l => l.success);
        if (hasSuccess) {
            // 写入部署操作日志
            try {
                
                const existing = JSON.parse(await env.CONFIG_KV.get(KV_KEYS.DEPLOY_JOURNAL) || '[]');
                existing.unshift({ time: new Date().toISOString(), type, sha: deployedSha, accounts: logs.filter(l => l.success).length, total: logs.length, summary: logs.map(l => l.name + ': ' + (l.success ? 'OK' : l.msg)).join('; ').substring(0, 500) });
                await env.CONFIG_KV.put(KV_KEYS.DEPLOY_JOURNAL, JSON.stringify(existing.slice(0, 100)));
            } catch (e) { console.warn("[Deploy] journal write failed:", (e as Error).message); }
            const DEPLOY_CONFIG_KEY = KV_KEYS.deployConfig(type);
            const mode = isLatestMode ? 'latest' : 'fixed';
            await env.CONFIG_KV.put(DEPLOY_CONFIG_KEY, JSON.stringify({ mode, currentSha: deployedSha || 'unknown', deployTime: new Date().toISOString() }));
        }
        return logs;
    } catch (e: any) { return [{ name: "系统错误", success: false, msg: e.message }]; }
}

export async function handleManualDeploy(
    env: any, type: string, variables: Array<{ key: string; value: string }>,
    deletedVariables: string[], accountsKey: string,
    targetSha: string | null, customCode: string | null,
    echTokenEnabled: boolean, echDisableWorkersDev: boolean,
    targetAccountIds: string[] | null
) {
    const result = await coreDeployLogic(env, type, variables, deletedVariables, accountsKey, targetSha, customCode, echTokenEnabled, echDisableWorkersDev, targetAccountIds);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}

/**
 * 批量部署 — 创建全新的 Worker（含 KV 命名空间创建/绑定）
 * 
 * 与 coreDeployLogic 的区别：
 *   - coreDeployLogic：更新已有 Worker，保留现有绑定
 *   - handleBatchDeploy：创建新 Worker，从零构建绑定（含 KV 命名空间）
 */
export async function handleBatchDeploy(env: any, reqData: any, accountsKey: string) {
    const { template, workerName, kvName, config, targetAccounts, disableWorkersDev, customDomainPrefix, enableKV, savedVars } = reqData;
    const allAccounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");

    const accountsToDeploy = allAccounts.filter((a: any) => targetAccounts.includes(a.alias));
    if (accountsToDeploy.length === 0) return new Response(JSON.stringify([{ name: "错误", success: false, msg: "未选择有效账号" }]), { headers: { "Content-Type": "application/json" } });

    let scriptContent = "";
    try {
        const { code } = await fetchGithubCode(template, 'latest', env);
        scriptContent = applyTemplateTransform(template, code, null);
    } catch (e: any) {
        return new Response(JSON.stringify([{ name: "网络错误", success: false, msg: e.message }]), { headers: { "Content-Type": "application/json" } });
    }

    const logs: Array<{ name: string; success: boolean; msg: string }> = [];
    let updatedAccounts = false;

    for (const acc of accountsToDeploy) {
        const log = { name: `${acc.alias} -> [${workerName}]`, success: false, msg: "" };
        try {
            const jsonHeaders = getAuthHeaders(acc.email, acc.globalKey);

            let nsId = "";
            if (enableKV) {
                const nsListRes = await fetch(cf.kvNamespaces(acc.accountId) + '?per_page=100', { headers: jsonHeaders });
                if (!nsListRes.ok) throw new Error("无法读取KV列表");
                const nsList = (await nsListRes.json()).result;
                const existNs = nsList.find((n: any) => n.title === kvName);
                if (existNs) { nsId = existNs.id; } else {
                    const createNsRes = await fetch(cf.kvNamespaces(acc.accountId), {
                        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: kvName })
                    });
                    if (!createNsRes.ok) { let kvMsg; try { const e = await createNsRes.json(); kvMsg = e.errors?.[0]?.message; } catch(_) { /* JSON parse failed — fallback to statusText */ } throw new Error("创建KV失败: " + (kvMsg || createNsRes.statusText)); }
                    nsId = (await createNsRes.json()).result.id;
                }
            }

            const bindings: Array<Record<string, unknown>> = [];
            if (enableKV && nsId) {
                const bindingName = TEMPLATES[template].kvBindingName;
                if (bindingName) bindings.push({ name: bindingName, type: "kv_namespace", namespace_id: nsId });
            }

            if (savedVars && Array.isArray(savedVars) && savedVars.length > 0) {
                savedVars.forEach((v: any) => {
                    if (v.key && !bindings.find(b => b.name === v.key)) {
                        bindings.push({ name: v.key, type: "plain_text", text: v.value || "" });
                    }
                });
            } else {
                if (config.admin) bindings.push({ name: "ADMIN", type: "plain_text", text: config.admin });
                if (template === 'joey' && config.uuid) bindings.push({ name: "u", type: "plain_text", text: config.uuid });

                const t = TEMPLATES[template];
                const defaultVars = t.defaultVars;
                defaultVars.forEach(key => {
                    if (key !== t.kvBindingName && key !== 'ADMIN' && key !== t.uuidField) {
                        if (key === 'UUID') {
                            bindings.push({ name: "UUID", type: "plain_text", text: config.uuid || crypto.randomUUID() });
                        } else {
                            bindings.push({ name: key, type: "plain_text", text: "" });
                        }
                    }
                });
            }

            const metadata = { main_module: "index.js", bindings, compatibility_date: new Date().toISOString().split('T')[0] };
            const formData = new FormData();
            formData.append("metadata", JSON.stringify(metadata));
            formData.append("script", new Blob([scriptContent], { type: "application/javascript+module" }), "index.js");

            const uploadHeaders = getUploadHeaders(acc.email, acc.globalKey);
            const deployRes = await fetch(cf.workerScript(acc.accountId, workerName), {
                method: "PUT", headers: uploadHeaders, body: formData
            });

            if (deployRes.ok) {
                log.success = true;
                let msgs: string[] = [];
                if (customDomainPrefix && acc.defaultZoneId && acc.defaultZoneName) {
                    const hostname = `${customDomainPrefix}.${acc.defaultZoneName}`;
                    const domainRes = await fetch(cf.workerDomains(acc.accountId), {
                        method: "PUT", headers: jsonHeaders,
                        body: JSON.stringify({ hostname, service: workerName, zone_id: acc.defaultZoneId })
                    });
                    if (domainRes.ok) msgs.push(`✅ 绑定: https://${hostname}`);
                    else msgs.push(`⚠️ 域名绑定失败`);
                }
                if (disableWorkersDev) {
                    await fetch(cf.workerSubdomain(acc.accountId, workerName), {
                        method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: false })
                    });
                    msgs.push(`🚫 默认域名已禁用`);
                } else {
                    await fetch(cf.workerSubdomain(acc.accountId, workerName), {
                        method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: true })
                    });
                    const subRes = await fetch(cf.acctSubdomain(acc.accountId), { headers: jsonHeaders });
                    const prefix = (await subRes.json()).result?.subdomain || "unknown";
                    msgs.push(`✅ 默认: https://${workerName}.${prefix}.workers.dev`);
                }
                log.msg = msgs.join(" | ");
                if (!acc[`workers_${template}`]) acc[`workers_${template}`] = [];
                if (!acc[`workers_${template}`].includes(workerName)) {
                    acc[`workers_${template}`].push(workerName);
                    updatedAccounts = true;
                }
            } else {
                try { const e = await deployRes.json(); log.msg = `❌ ${e.errors?.[0]?.message || "API error"}`; } catch(_) { log.msg = `❌ HTTP ${deployRes.status}`; }
            }
        } catch (e: any) { log.msg = `❌ ${e.message}`; }
        logs.push(log);
    }

    if (updatedAccounts) {
        const finalAccounts = allAccounts.map((a: any) => {
            const updated = accountsToDeploy.find((u: any) => u.alias === a.alias);
            return updated ? updated : a;
        });
        await env.CONFIG_KV.put(accountsKey, JSON.stringify(finalAccounts));
    }
    return new Response(JSON.stringify(logs), { headers: { "Content-Type": "application/json" } });
}
