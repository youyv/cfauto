/**
 * 路由: 部署逻辑 — 手动部署、批量部署
 */

import { KV_KEYS, TEMPLATES, BINDING } from '../config/templates';
import { cf, getAuthHeaders } from '../lib/cloudflare-api';
import { fetchGithubCode, applyTemplateTransform } from '../lib/github';
import { uploadWorker, parseApiError } from '../lib/deploy-utils';
import { getJSON, putJSON } from "../lib/kv-utils";
import { validateRequired } from "../lib/validate";
import type { AppEnv } from "../config/env";
import { coreDeployLogic, DeployOptions } from '../lib/auto-update';

/** 手动部署 — HTTP handler，调用核心部署逻辑 */
export async function handleManualDeploy(env: AppEnv, opts: DeployOptions) {
    const result = await coreDeployLogic(env, opts);
    return json(result);
}

/**
 * 批量部署 — 创建全新的 Worker（含 KV 命名空间创建/绑定）
 */
export async function handleBatchDeploy(env: AppEnv, reqData: any) {
    const validationError = validateRequired(reqData, ["template", "workerName", "targetAccounts"]);
    if (validationError) return validationError;

    const { template, workerName, kvName, config, targetAccounts, disableWorkersDev, customDomainPrefix, enableKV, savedVars } = reqData;
    const allAccounts = await getJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []);

    const accountsToDeploy = allAccounts.filter((a: any) => targetAccounts.includes(a.alias));
    if (accountsToDeploy.length === 0) return json([{ name: "错误", success: false, msg: "未选择有效账号" }]);

    let scriptContent = "";
    try {
        const { code } = await fetchGithubCode(template, 'latest', env);
        scriptContent = applyTemplateTransform(template, code, null);
    } catch (e: any) {
        return json([{ name: "网络错误", success: false, msg: e.message }]);
    }

    const logs: Array<{ name: string; success: boolean; msg: string }> = [];
    let updatedAccounts = false;

    for (const acc of accountsToDeploy) {
        const log = { name: acc.alias + ' -> [' + workerName + ']', success: false, msg: "" };
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
                    if (!createNsRes.ok) { let kvMsg; try { const e = await createNsRes.json(); kvMsg = e.errors?.[0]?.message; } catch(_) {} throw new Error("创建KV失败: " + (kvMsg || createNsRes.statusText)); }
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
                const t = TEMPLATES[template];
                if (config.admin) bindings.push({ name: "ADMIN", type: "plain_text", text: config.admin });
                if (t.uuidField && config[t.uuidField]) {
                    bindings.push({ name: t.uuidField, type: "plain_text", text: config[t.uuidField] });
                }

                t.defaultVars.forEach(key => {
                    if (key !== t.kvBindingName && key !== 'ADMIN' && key !== t.uuidField) {
                        bindings.push({ name: key, type: "plain_text", text: "" });
                    }
                });
            }

            const { ok, res: deployRes } = await uploadWorker(acc, workerName, scriptContent, bindings);

            if (ok) {
                log.success = true;
                let msgs: string[] = [];
                if (customDomainPrefix && acc.defaultZoneId && acc.defaultZoneName) {
                    const hostname = customDomainPrefix + '.' + acc.defaultZoneName;
                    const domainRes = await fetch(cf.workerDomains(acc.accountId), {
                        method: "PUT", headers: jsonHeaders,
                        body: JSON.stringify({ hostname, service: workerName, zone_id: acc.defaultZoneId })
                    });
                    if (domainRes.ok) msgs.push('\u2705 绑定: https://' + hostname);
                    else msgs.push('\u26A0\uFE0F 域名绑定失败');
                }
                if (disableWorkersDev) {
                    await fetch(cf.workerSubdomain(acc.accountId, workerName), {
                        method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: false })
                    });
                    msgs.push('\u{1F6AB} 默认域名已禁用');
                } else {
                    await fetch(cf.workerSubdomain(acc.accountId, workerName), {
                        method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: true })
                    });
                    const subRes = await fetch(cf.acctSubdomain(acc.accountId), { headers: jsonHeaders });
                    const prefix = (await subRes.json()).result?.subdomain || "unknown";
                    msgs.push('\u2705 默认: https://' + workerName + '.' + prefix + '.workers.dev');
                }
                log.msg = msgs.join(" | ");
                if (!acc['workers_' + template]) acc['workers_' + template] = [];
                if (!acc['workers_' + template].includes(workerName)) {
                    acc['workers_' + template].push(workerName);
                    updatedAccounts = true;
                }
            } else {
                log.msg = await parseApiError(deployRes);
            }
        } catch (e: any) { log.msg = '\u274C ' + e.message; }
        logs.push(log);
    }

    if (updatedAccounts) {
        const finalAccounts = allAccounts.map((a: any) => {
            const updated = accountsToDeploy.find((u: any) => u.alias === a.alias);
            return updated ? updated : a;
        });
        await putJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, finalAccounts);
    }
    return json(logs);
}
