/**
 * 路由: 部署逻辑 — 手动部署、批量部署
 */

import { KV_KEYS, TEMPLATES } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { cf, getAuthHeaders, json } from '../lib/cloudflare-api';
import { fetchGithubCode, applyTemplateTransform } from '../lib/github';
import { uploadWorker, parseApiError, mergeVariableBindings } from '../lib/deploy-utils';
import { getJSON, putJSON } from "../lib/kv-utils";
import { readAccounts, writeAccounts, getWorkerNames } from "../lib/account-store";
import { logger } from '../lib/logger';
import { validateRequired } from "../lib/validate";
import type { AppEnv } from "../config/env";
import { coreDeployLogic, DeployOptions } from '../lib/auto-update';
import type { BatchDeployRequest, DeployLogEntry, AccountEntry, VariableBinding } from '../lib/types';

/** 手动部署 — HTTP handler，调用核心部署逻辑 */
export async function handleManualDeploy(env: AppEnv, opts: DeployOptions) {
    const result = await coreDeployLogic(env, opts);
    return json(result);
}

/** [提取] 查找或创建 KV 命名空间 */
async function ensureKVNamespace(
    acc: AccountEntry, kvName: string, jsonHeaders: Record<string, string>
): Promise<string> {
    const nsListRes = await fetch(cf.kvNamespaces(acc.accountId) + '?per_page=100', { headers: jsonHeaders });
    if (!nsListRes.ok) throw new Error("无法读取KV列表");
    const nsList = (await nsListRes.json()).result;
    const existNs = nsList.find((n: { title: string; id: string }) => n.title === kvName);
    if (existNs) return existNs.id;

    const createNsRes = await fetch(cf.kvNamespaces(acc.accountId), {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: kvName })
    });
    if (!createNsRes.ok) {
        let kvMsg; try { const e = await createNsRes.json(); kvMsg = e.errors?.[0]?.message; } catch (_) { logger.warn('KV creation error parse failed', { module: 'deploy' }); }
        throw new Error("创建KV失败: " + (kvMsg || createNsRes.statusText));
    }
    return (await createNsRes.json()).result.id;
}

/** [提取] 构建批量部署的 Worker Bindings */
function buildBatchBindings(
    template: TemplateType, nsId: string, enableKV: boolean,
    savedVars: VariableBinding[] | undefined, config: Record<string, string>
): Array<Record<string, unknown>> {
    let bindings: Array<Record<string, unknown>> = [];
    const t = TEMPLATES[template];

    if (enableKV && nsId && t.kvBindingName) {
        bindings.push({ name: t.kvBindingName, type: "kv_namespace", namespace_id: nsId });
    }

    if (savedVars && Array.isArray(savedVars) && savedVars.length > 0) {
        bindings = mergeVariableBindings(bindings, savedVars);
    } else {
        if (config.ADMIN) bindings.push({ name: "ADMIN", type: "plain_text", text: config.ADMIN });
        if (t.uuidField && config[t.uuidField]) {
            bindings.push({ name: t.uuidField, type: "plain_text", text: config[t.uuidField] });
        }
        t.defaultVars.forEach(key => {
            if (key !== t.kvBindingName && key !== 'ADMIN' && key !== t.uuidField) {
                bindings.push({ name: key, type: "plain_text", text: "" });
            }
        });
    }
    return bindings;
}

/** [提取] 配置 Worker 域名和子域名 */
async function configureDomains(
    acc: AccountEntry, workerName: string,
    jsonHeaders: Record<string, string>,
    customDomainPrefix?: string, disableWorkersDev?: boolean
): Promise<string[]> {
    const msgs: string[] = [];
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
    return msgs;
}

/** [提取] 对单个账号执行批量部署 */
async function deployToSingleAccount(
    acc: AccountEntry, template: TemplateType, workerName: string,
    scriptContent: string, enableKV: boolean, kvName: string,
    savedVars: VariableBinding[] | undefined, config: Record<string, string>,
    customDomainPrefix?: string, disableWorkersDev?: boolean
): Promise<{ log: DeployLogEntry; updated: boolean }> {
    const log: DeployLogEntry = { name: acc.alias + ' -> [' + workerName + ']', success: false, msg: "" };
    let updated = false;
    try {
        const jsonHeaders = getAuthHeaders(acc.email, acc.globalKey);

        let nsId = "";
        if (enableKV) {
            nsId = await ensureKVNamespace(acc, kvName, jsonHeaders);
        }

        const bindings = buildBatchBindings(template, nsId, enableKV, savedVars, config);
        const { ok, res: deployRes } = await uploadWorker(acc, workerName, scriptContent, bindings);

        if (ok) {
            log.success = true;
            const msgs = await configureDomains(acc, workerName, jsonHeaders, customDomainPrefix, disableWorkersDev);
            log.msg = msgs.join(" | ");
            if (!getWorkerNames(acc, template).includes(workerName)) {
                acc['workers_' + template] = acc['workers_' + template] || [];
                acc['workers_' + template].push(workerName);
                updated = true;
            }
        } else {
            log.msg = await parseApiError(deployRes);
        }
    } catch (e: any) { log.msg = '\u274C ' + e.message; }
    return { log, updated };
}

/**
 * 批量部署 — 创建全新的 Worker（含 KV 命名空间创建/绑定）
 * 并行化：所有账号同时部署，利用 Worker 并发能力
 */
export async function handleBatchDeploy(env: AppEnv, reqData: BatchDeployRequest) {
    const validationError = validateRequired(reqData, ["template", "workerName", "targetAccounts"]);
    if (validationError) return validationError;

    const { template, workerName, kvName = '', config, targetAccounts, disableWorkersDev, customDomainPrefix, enableKV, savedVars } = reqData;
    const allAccounts = await readAccounts(env);

    const accountsToDeploy = allAccounts.filter((a) => targetAccounts.includes(a.alias));
    if (accountsToDeploy.length === 0) return json([{ name: "错误", success: false, msg: "未选择有效账号" }]);

    let scriptContent = "";
    try {
        const { code } = await fetchGithubCode(template, 'latest', env);
        scriptContent = applyTemplateTransform(template, code, null);
    } catch (e: any) {
        return json([{ name: "网络错误", success: false, msg: e.message }]);
    }

    // 并行部署到所有账号
    const results = await Promise.allSettled(
        accountsToDeploy.map(acc =>
            deployToSingleAccount(acc, template, workerName, scriptContent,
                !!enableKV, kvName, savedVars, config,
                customDomainPrefix, disableWorkersDev)
        )
    );

    const logs: DeployLogEntry[] = [];
    let updatedAccounts = false;

    for (const r of results) {
        if (r.status === 'fulfilled') {
            logs.push(r.value.log);
            if (r.value.updated) updatedAccounts = true;
        } else {
            logs.push({ name: "并行部署异常", success: false, msg: r.reason?.message || String(r.reason) });
        }
    }

    if (updatedAccounts) {
        const finalAccounts = allAccounts.map((a) => {
            const updated = accountsToDeploy.find((u) => u.alias === a.alias);
            return updated ? updated : a;
        });
        await writeAccounts(env, finalAccounts);
    }
    return json(logs);
}
