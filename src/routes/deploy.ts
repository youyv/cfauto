/**
 * 路由: 部署逻辑 — 手动部署、批量部署
 */

import { buildBatchBindings, configToVariables } from '../lib/batch-bindings';
import { redactDiagnosticText } from '../lib/redaction';
import type { TemplateType } from '../config/templates';
import { cf, getAuthHeaders, json, fetchWithTimeout, readApiResult } from '../lib/cloudflare-api';
import { uploadWorker, verifyWorkerScript } from '../lib/deploy-utils';
import { readAccounts, writeAccounts, addWorkerName, hasAccountCredentials } from "../lib/account-store";
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
    return json(result.map(l => ({ ...l, msg: redactDiagnosticText(l.msg || '') })));
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

/** [提取] 配置 Worker 域名和子域名 */
async function configureDomains(
    acc: AccountEntry, workerName: string,
    jsonHeaders: Record<string, string>,
    customDomainPrefix?: string, disableWorkersDev?: boolean
): Promise<string[]> {
    const msgs: string[] = [];
    if (customDomainPrefix) {
        if (!acc.defaultZoneId || !acc.defaultZoneName) {
            msgs.push('⚠️ 已填自定义域名前缀，但该账号未配置默认 Zone，已跳过绑定');
        } else {
            const hostname = customDomainPrefix + '.' + acc.defaultZoneName;
            try {
                await readApiResult(await fetchWithTimeout(cf.workerDomains(acc.accountId), {
                    method: 'PUT', headers: jsonHeaders,
                    body: JSON.stringify({ hostname, service: workerName, zone_id: acc.defaultZoneId })
                }), '绑定自定义域名');
                msgs.push('✅ 绑定: https://' + hostname);
            } catch (error) { msgs.push('⚠️ 域名绑定未确认，请到 Dashboard 核对: ' + redactDiagnosticText((error as Error).message)); }
        }
    }
    try {
        await readApiResult(await fetchWithTimeout(cf.workerSubdomain(acc.accountId, workerName), {
            method: 'POST', headers: jsonHeaders, body: JSON.stringify({ enabled: !disableWorkersDev })
        }), disableWorkersDev ? '禁用默认域名' : '启用默认域名');
        if (disableWorkersDev) msgs.push('🚫 默认域名已禁用');
        else {
            try {
                const result = await readApiResult<{ subdomain?: string }>(await fetchWithTimeout(cf.acctSubdomain(acc.accountId), { headers: jsonHeaders }), '读取账号子域名');
                if (!result?.subdomain) throw new Error('账号子域名为空');
                msgs.push('✅ 默认: https://' + workerName + '.' + result.subdomain + '.workers.dev');
            } catch (error) { msgs.push('⚠️ 默认域名已启用，但访问地址未确认: ' + redactDiagnosticText((error as Error).message)); }
        }
    } catch (error) { msgs.push('⚠️ 默认域名' + (disableWorkersDev ? '禁用' : '启用') + '未确认，请到 Dashboard 核对: ' + redactDiagnosticText((error as Error).message)); }
    return msgs;
}

/** [提取] 对单个账号执行批量部署 */
async function deployToSingleAccount(
    env: AppEnv, acc: AccountEntry, template: TemplateType, workerName: string,
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
        const jsonHeaders = getAuthHeaders(acc);

        let nsId = "";
        if (enableKV) {
            nsId = await ensureKVNamespace(acc, kvName, jsonHeaders);
        }

        const bindings = buildBatchBindings(template, nsId, enableKV, savedVars, config);
        const { ok, error: uploadError } = await uploadWorker(acc, workerName, scriptContent, bindings, template, env);

        if (ok) {
            // 回读校验：上传响应成功不代表脚本真的变了（见 deploy-utils.verifyWorkerScript）
            const verdict = await verifyWorkerScript(acc.accountId, workerName, jsonHeaders, scriptContent);
            if (verdict === 'mismatch') {
                log.verify = 'mismatch';
                log.msg = '❌ 上传后回读校验不一致：Cloudflare 上的脚本内容与本次上传的不同（本次写入可能未生效）';
                return { log, updated };
            }
            log.verify = verdict === 'verified' ? 'verified' : 'unverified';
            log.success = true;
            const msgs = await configureDomains(acc, workerName, jsonHeaders, customDomainPrefix, disableWorkersDev);
            if (verdict === 'unverified') msgs.push('⚠️ 回读校验不可用');
            log.msg = msgs.join(" | ");
            updated = addWorkerName(acc, template, workerName);
        } else {
            log.msg = '❌ ' + (uploadError || '上传失败');
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
    const accountsToDeploy = allAccounts.filter((a) => targetAccounts.includes(a.alias) && hasAccountCredentials(a));
    if (accountsToDeploy.length === 0) {
        const missingKey = allAccounts.filter((a) => targetAccounts.includes(a.alias) && !hasAccountCredentials(a));
        return json([{
            name: "错误", success: false,
            msg: missingKey.length > 0
                ? '所选账号未配置凭据或解密失败：' + missingKey.map(a => a.alias).join(', ')
                : "未选择有效账号"
        }]);
    }

    // 复用 prepareDeployCode（统一代码获取 + SHA 追踪）
    // variables 必须传 config：ech 模板的 PROXYIP 是在**代码转换**阶段注入的（替换
    // CF_FALLBACK_IPS 常量），仅靠 bindings 绑定一个名为 PROXYIP 的变量对 ech 无效。
    // 此前传 null 导致批量创建的 ech Worker 全部回落到硬编码默认代理。
    const codeResult = await prepareDeployCode(env, template, null, null, configToVariables(config), false);
    if (Array.isArray(codeResult)) return json(codeResult.map(l => ({ ...l, msg: redactDiagnosticText(l.msg || '') })));
    const { scriptContent, deployedSha, isLatestMode, sourceIdentity } = codeResult;

    const settled = await pooledMapSettled(accountsToDeploy, (acc) =>
        deployToSingleAccount(env, acc, template, trimmedName, scriptContent,
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

    // 批量部署只覆盖「本次新建的那一个 Worker 名」，属于子集作用域 → 不推进版本账本，
    // 由 cron 的版本检查在下一轮按全量补齐其余 Worker。
    await finalizeDeploy(env, template, isLatestMode, deployedSha, logs, '', 'partial', sourceIdentity);

    return json(logs.map(l => ({ ...l, msg: redactDiagnosticText(l.msg || '') })));
}
