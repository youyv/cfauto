/**
 * 路由: 部署逻辑 — 手动部署、批量部署
 */

import { TEMPLATES, BINDING } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { cf, getAuthHeaders, json, fetchWithTimeout, readApiResult } from '../lib/cloudflare-api';
import { uploadWorker, parseApiError, mergeVariableBindings } from '../lib/deploy-utils';
import { readAccounts, writeAccounts, addWorkerName } from "../lib/account-store";
import { pooledMapSettled } from '../lib/concurrency';
import { validateRequired, requireTemplateType, isNonEmptyString, WORKER_NAME_RE } from "../lib/validate";
import type { AppEnv } from "../config/env";
import { coreDeployLogic, prepareDeployCode, finalizeDeploy, deployTargetKey, type DeployOptions } from '../lib/auto-update';
import type { BatchDeployRequest, DeployLogEntry, AccountEntry, VariableEntry } from '../lib/types';

/**
 * 手动部署 — HTTP handler，调用核心部署逻辑。
 *
 * `accountOverrides: 'clear'`：用户在面板上看到的就是全局变量，点部署的意图是
 * 「所有账号统一用这一套」，因此清除熔断留下的账号级覆盖，避免「界面显示 A、
 * 实际部署 B」的不一致。若用量仍然超限，下一轮 cron 会重新触发熔断。
 */
export async function handleManualDeploy(env: AppEnv, opts: DeployOptions) {
    const result = await coreDeployLogic(env, { ...opts, accountOverrides: 'clear' });
    return json(result);
}

/** [提取] 查找或创建 KV 命名空间 */
async function ensureKVNamespace(
    acc: AccountEntry, kvName: string, jsonHeaders: Record<string, string>
): Promise<string> {
    const nsListRes = await fetchWithTimeout(cf.kvNamespaces(acc.accountId) + '?per_page=100', { headers: jsonHeaders });
    const nsList = await readApiResult<Array<{ title: string; id: string }>>(nsListRes, '读取 KV 列表') || [];
    const existNs = nsList.find((n) => n.title === kvName);
    if (existNs) return existNs.id;

    const createNsRes = await fetchWithTimeout(cf.kvNamespaces(acc.accountId), {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: kvName })
    });
    const created = await readApiResult<{ id: string }>(createNsRes, '创建 KV 命名空间');
    if (!created?.id) throw new Error('创建 KV 失败: 上游未返回命名空间 ID');
    return created.id;
}

/** [提取] 构建批量部署的 Worker Bindings */
function buildBatchBindings(
    template: TemplateType, nsId: string, enableKV: boolean,
    savedVars: VariableEntry[] | undefined, config: Record<string, string>
): Array<Record<string, unknown>> {
    let bindings: Array<Record<string, unknown>> = [];
    const t = TEMPLATES[template];

    if (enableKV && nsId && t.kvBindingName) {
        bindings.push({ name: t.kvBindingName, type: BINDING.KV_NAMESPACE, namespace_id: nsId });
    }

    if (savedVars && Array.isArray(savedVars) && savedVars.length > 0) {
        bindings = mergeVariableBindings(bindings, savedVars);
    } else {
        if (config?.ADMIN) bindings.push({ name: "ADMIN", type: BINDING.PLAIN_TEXT, text: config.ADMIN });
        if (t.uuidField && config?.[t.uuidField]) {
            bindings.push({ name: t.uuidField, type: BINDING.PLAIN_TEXT, text: config[t.uuidField] });
        }
        t.defaultVars.forEach(key => {
            if (key !== t.kvBindingName && key !== 'ADMIN' && key !== t.uuidField) {
                bindings.push({ name: key, type: BINDING.PLAIN_TEXT, text: "" });
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
    if (customDomainPrefix) {
        if (!acc.defaultZoneId || !acc.defaultZoneName) {
            msgs.push('\u26A0\uFE0F 已填自定义域名前缀，但该账号未配置默认 Zone，已跳过绑定');
        } else {
            const hostname = customDomainPrefix + '.' + acc.defaultZoneName;
            const domainRes = await fetchWithTimeout(cf.workerDomains(acc.accountId), {
                method: "PUT", headers: jsonHeaders,
                body: JSON.stringify({ hostname, service: workerName, zone_id: acc.defaultZoneId })
            });
            if (domainRes.ok) msgs.push('\u2705 绑定: https://' + hostname);
            else msgs.push('\u26A0\uFE0F 域名绑定失败 (HTTP ' + domainRes.status + ')');
        }
    }
    if (disableWorkersDev) {
        const r = await fetchWithTimeout(cf.workerSubdomain(acc.accountId, workerName), {
            method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: false })
        });
        msgs.push(r.ok ? '\u{1F6AB} 默认域名已禁用' : '\u26A0\uFE0F 默认域名禁用失败 (HTTP ' + r.status + ')');
    } else {
        const enableRes = await fetchWithTimeout(cf.workerSubdomain(acc.accountId, workerName), {
            method: "POST", headers: jsonHeaders, body: JSON.stringify({ enabled: true })
        });
        if (!enableRes.ok) {
            msgs.push('\u26A0\uFE0F 默认域名启用失败 (HTTP ' + enableRes.status + ')');
        } else {
            try {
                const subRes = await fetchWithTimeout(cf.acctSubdomain(acc.accountId), { headers: jsonHeaders });
                const result = await readApiResult<{ subdomain?: string }>(subRes, '读取账号子域名');
                const prefix = result?.subdomain || 'unknown';
                msgs.push('\u2705 默认: https://' + workerName + '.' + prefix + '.workers.dev');
            } catch (e) {
                msgs.push('\u2705 默认域名已启用（子域名查询失败: ' + (e as Error).message + '）');
            }
        }
    }
    return msgs;
}

/** [提取] 对单个账号执行批量部署 */
async function deployToSingleAccount(
    acc: AccountEntry, template: TemplateType, workerName: string,
    scriptContent: string, enableKV: boolean, kvName: string,
    savedVars: VariableEntry[] | undefined, config: Record<string, string>,
    customDomainPrefix?: string, disableWorkersDev?: boolean
): Promise<{ log: DeployLogEntry; updated: boolean }> {
    const log: DeployLogEntry = {
        name: acc.alias + ' -> [' + workerName + ']',
        success: false,
        msg: "",
        targetKey: deployTargetKey(acc.accountId, workerName)
    };
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
            updated = addWorkerName(acc, template, workerName);
        } else {
            log.msg = await parseApiError(deployRes);
        }
    } catch (e: any) { log.msg = '\u274C ' + e.message; }
    return { log, updated };
}

/**
 * 批量部署 — 创建全新的 Worker（含 KV 命名空间创建/绑定）
 * 有界并发：避免全量 Promise.all 撞 CF 限流（1200 次/5 分钟）与 subrequest 上限
 */
export async function handleBatchDeploy(env: AppEnv, reqData: BatchDeployRequest) {
    const validationError = validateRequired(reqData as unknown as Record<string, unknown>, ["template", "workerName", "targetAccounts"]);
    if (validationError) return validationError;
    const templateErr = requireTemplateType(reqData.template as string);
    if (templateErr) return templateErr;

    const { template, workerName, kvName = '', config = {}, targetAccounts, disableWorkersDev, customDomainPrefix, enableKV, savedVars } = reqData;

    if (!isNonEmptyString(workerName) || !WORKER_NAME_RE.test(workerName.trim())) {
        return json([{ name: "参数错误", success: false, msg: "Worker 名称非法：仅允许小写字母、数字与连字符，长度 1-63" }], 400);
    }
    if (!Array.isArray(targetAccounts) || targetAccounts.length === 0) {
        return json([{ name: "参数错误", success: false, msg: "未选择目标账号" }], 400);
    }
    if (enableKV && !isNonEmptyString(kvName)) {
        return json([{ name: "参数错误", success: false, msg: "开启 KV 绑定时必须提供 KV 名称" }], 400);
    }

    const trimmedName = workerName.trim();
    const allAccounts = await readAccounts(env);
    const accountsToDeploy = allAccounts.filter((a) => targetAccounts.includes(a.alias) && a.globalKey);
    if (accountsToDeploy.length === 0) {
        const missingKey = allAccounts.filter((a) => targetAccounts.includes(a.alias) && !a.globalKey);
        return json([{
            name: "错误", success: false,
            msg: missingKey.length > 0
                ? '所选账号密钥缺失或解密失败：' + missingKey.map(a => a.alias).join(', ')
                : "未选择有效账号"
        }]);
    }

    // 复用 prepareDeployCode（统一代码获取 + SHA 追踪）
    const codeResult = await prepareDeployCode(env, template, null, null, null, false);
    if (Array.isArray(codeResult)) return json(codeResult);
    const { scriptContent, deployedSha, isLatestMode } = codeResult;

    const settled = await pooledMapSettled(accountsToDeploy, (acc) =>
        deployToSingleAccount(acc, template, trimmedName, scriptContent,
            !!enableKV, kvName, savedVars, config,
            customDomainPrefix, disableWorkersDev)
    );

    const logs: DeployLogEntry[] = [];
    let updatedAccounts = false;

    settled.forEach((r, i) => {
        if (r.ok) {
            logs.push(r.value.log);
            if (r.value.updated) updatedAccounts = true;
        } else {
            const acc = accountsToDeploy[i];
            logs.push({
                name: (acc ? acc.alias : '未知账号') + ' -> [' + trimmedName + ']',
                success: false,
                msg: '❌ ' + r.error.message,
                targetKey: acc ? deployTargetKey(acc.accountId, trimmedName) : undefined
            });
        }
    });

    // 先落盘账号记录再写部署配置：Worker 已创建但账号列表没记上，会导致后续更新完全遗漏它
    if (updatedAccounts) {
        const byAlias = new Map(accountsToDeploy.map(a => [a.alias, a]));
        const finalAccounts = allAccounts.map((a) => byAlias.get(a.alias) || a);
        await writeAccounts(env, finalAccounts);
    }

    await finalizeDeploy(env, template, isLatestMode, deployedSha, logs, '');

    return json(logs);
}
