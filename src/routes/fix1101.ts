/**
 * 路由: 一键修复 1101
 *
 * 流程（每个 Worker）：记录绑定 + 域名 → 删除 → 重建（退避重试）→ 恢复域名。
 * 账号级：至少一个 Worker 重建成功后轮换一次子域名。
 */

import { KV_KEYS } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { cf, getAuthHeaders, json, fetchWithTimeout, readApiResult } from '../lib/cloudflare-api';
import { fetchGithubCode, applyTemplateTransform } from '../lib/github';
import { uploadWorker, parseApiError, readWorkerBindings } from '../lib/deploy-utils';
import { getJSON, putJSON } from "../lib/kv-utils";
import { readAccounts, getWorkerNames } from "../lib/account-store";
import { deployTargetKey } from '../lib/auto-update';
import { logger } from '../lib/logger';
import type { AppEnv } from "../config/env";
import type { DeployLogEntry, VariableEntry } from '../lib/types';

/** 重建重试配置：先试一次，失败才退避（2s → 4s → 8s） */
const REBUILD_MAX_ATTEMPTS = 4;
const REBUILD_BASE_DELAY_MS = 2000;

/** CF 删除 Worker 是异步的，重建前的最小等待 */
const POST_DELETE_DELAY_MS = 1500;

/** 生成加密安全的随机子域名（Math.random 可预测，会削弱熔断规避机制） */
export function randomSubdomain(): string {
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const randBuf = crypto.getRandomValues(new Uint8Array(6));
    const randSubStr = Array.from(randBuf).map(b => ALPHABET[b % ALPHABET.length]).join('');
    const randNum = crypto.getRandomValues(new Uint32Array(1))[0] % 99;
    return 'w' + randSubStr + randNum;
}

/**
 * 重建绑定列表：KV 变量优先，其次沿用 CF 返回的原值。
 * secret_text 的值 CF API 不返回，若 KV 也没有则**跳过该绑定**（写空值会覆盖掉真实 secret）。
 * 纯函数，导出供测试覆盖。
 */
export function rebuildBindings(
    savedBindings: Array<Record<string, any>>,
    kvVars: VariableEntry[]
): { bindings: Array<Record<string, any>>; secretSkipped: string[] } {
    const kvVarMap = new Map(kvVars.filter(v => v && v.key).map(v => [v.key, v.value]));
    const secretSkipped: string[] = [];
    const bindings: Array<Record<string, any>> = [];

    for (const b of savedBindings) {
        if (!b || !b.name) continue;
        if (b.type === 'plain_text' || b.type === 'secret_text') {
            const kvVal = kvVarMap.get(b.name);
            if (b.type === 'secret_text' && (kvVal === undefined || kvVal === '') && !b.text) {
                secretSkipped.push(b.name);
                continue;
            }
            const val = (kvVal !== undefined && kvVal !== '') ? kvVal : (b.text || '');
            bindings.push({ name: b.name, type: b.type, text: val });
            continue;
        }
        if (b.type === 'kv_namespace') {
            bindings.push({ name: b.name, type: 'kv_namespace', namespace_id: b.namespace_id });
            continue;
        }
        bindings.push(b);
    }

    // KV 中有、但 Worker 上还没有的变量一并补上
    for (const [key, value] of kvVarMap) {
        if (!bindings.some((b) => b.name === key)) {
            bindings.push({ name: key, type: 'plain_text', text: value || '' });
        }
    }
    return { bindings, secretSkipped };
}

export async function handleFix1101(env: AppEnv, type: TemplateType) {
    const accounts = await readAccounts(env);
    if (accounts.length === 0) return json([{ name: "提示", success: false, msg: "无账号" }]);

    const logs: DeployLogEntry[] = [];

    let freshCode: string, latestSha: string | null = null;
    try {
        const result = await fetchGithubCode(type, 'latest', env);
        freshCode = result.code;
        latestSha = result.sha;
    } catch (e: any) {
        return json([{ name: "系统", success: false, msg: `代码下载失败: ${e.message}` }]);
    }

    const kvVars = await getJSON<VariableEntry[]>(env.CONFIG_KV, KV_KEYS.vars(type), []);
    const deployCode = applyTemplateTransform(type, freshCode, kvVars, { echTokenEnabled: true });

    for (const acc of accounts) {
        let accAnySuccess = false;
        const targetWorkers = getWorkerNames(acc, type);
        if (targetWorkers.length === 0) {
            logs.push({ name: acc.alias, success: false, msg: "⏭️ 无此类 Worker，跳过" });
            continue;
        }
        if (!acc.globalKey) {
            logs.push({ name: acc.alias, success: false, msg: "❌ 密钥缺失或解密失败，请重新填写 Global API Key" });
            continue;
        }

        const headers = getAuthHeaders(acc.email, acc.globalKey);

        for (const wName of targetWorkers) {
            const logItem: DeployLogEntry = {
                name: `${acc.alias} → [${wName}]`,
                success: false,
                msg: "",
                targetKey: deployTargetKey(acc.accountId, wName)
            };
            const steps: string[] = [];
            try {
                const baseUrl = cf.workerScript(acc.accountId, wName);

                // Step 1: 记录当前变量绑定
                let savedBindings: Array<Record<string, any>> = [];
                let bindingsReadOk = false;
                try {
                    const r = await readWorkerBindings(acc.accountId, wName, headers);
                    savedBindings = r.bindings;
                    bindingsReadOk = r.ok;
                    if (!r.ok) steps.push('⚠️ 记录绑定失败');
                } catch (e) { steps.push('⚠️ 记录绑定失败: ' + (e as Error).message); }

                // 安全闸门：绑定读不到就不能删。删了再重建等于永久丢失该 Worker 的 KV/secret 绑定。
                // 例外：KV 里存有变量时仍可重建出可用配置，但 KV 命名空间绑定无法恢复，故仍中止。
                if (!bindingsReadOk) {
                    throw new Error('无法读取现有绑定，已中止修复以避免删除后丢失 KV/secret 绑定');
                }
                const varCount = savedBindings.filter((b) => b.type === 'plain_text').length;
                steps.push(`📋 记录 ${savedBindings.length} 个绑定 (${varCount} 变量)`);

                // Step 1.5: 记录自定义域名
                let savedDomains: Array<Record<string, any>> = [];
                try {
                    const domainsRes = await fetchWithTimeout(cf.workerDomains(acc.accountId), { headers });
                    if (domainsRes.ok) {
                        const allDomains = await readApiResult<Array<Record<string, any>>>(domainsRes, '读取域名') || [];
                        savedDomains = allDomains.filter((d) => d.service === wName);
                    } else {
                        steps.push('⚠️ 记录域名失败 (HTTP ' + domainsRes.status + ')');
                    }
                } catch (e) { steps.push('⚠️ 记录域名失败: ' + (e as Error).message); }
                if (savedDomains.length > 0) steps.push(`🔗 记录 ${savedDomains.length} 个自定义域名`);

                // Step 2: 删除 Worker（不删 KV）
                const delRes = await fetchWithTimeout(baseUrl, { method: "DELETE", headers });
                if (!delRes.ok) {
                    let msg = 'HTTP ' + delRes.status;
                    try { const err: any = await delRes.json(); msg = err.errors?.[0]?.message || msg; } catch { /* 非 JSON 错误页 */ }
                    throw new Error(`删除失败: ${msg}`);
                }
                steps.push("🗑️ 已删除");

                // Step 3: 重建绑定并上传（CF 删除是异步的，先等一小段再试）
                const { bindings: restoredBindings, secretSkipped } = rebuildBindings(savedBindings, kvVars);
                const restoredVarCount = restoredBindings.filter((b) => b.type === 'plain_text').length;

                await new Promise(r => setTimeout(r, POST_DELETE_DELAY_MS));
                // 先试一次，失败才退避重试（此前把 sleep 放在上传之前，即使首次即可成功也白等 2s）
                let ok = false;
                let uploadRes = new Response('', { status: 500 });
                for (let attempt = 0; attempt < REBUILD_MAX_ATTEMPTS; attempt++) {
                    if (attempt > 0) {
                        await new Promise(r => setTimeout(r, REBUILD_BASE_DELAY_MS * Math.pow(2, attempt - 1)));
                    }
                    const result = await uploadWorker(acc, wName, deployCode, restoredBindings);
                    uploadRes = result.res;
                    if (result.ok) { ok = true; break; }
                }

                if (ok) {
                    logItem.success = true;
                    accAnySuccess = true;
                    steps.push(`✅ 重建成功 (${restoredVarCount} 变量已恢复)`);
                    if (secretSkipped.length > 0) steps.push(`⚠️ secret 绑定无法从 API 恢复，需手动重配: ${secretSkipped.join(', ')}`);

                    if (savedDomains.length > 0) {
                        let domainOk = 0;
                        for (const d of savedDomains) {
                            try {
                                const dRes = await fetchWithTimeout(cf.workerDomains(acc.accountId), {
                                    method: 'PUT', headers,
                                    body: JSON.stringify({ hostname: d.hostname, service: wName, zone_id: d.zone_id, environment: d.environment || 'production' })
                                });
                                if (dRes.ok) domainOk++;
                                else logger.warn('fix1101 domain restore failed', { hostname: d.hostname, status: dRes.status });
                            } catch (e) { logger.warn('fix1101 domain restore best-effort failed', { error: (e as Error).message }); }
                        }
                        steps.push(`🔗 域名恢复 ${domainOk}/${savedDomains.length}`);
                        if (domainOk < savedDomains.length) {
                            steps.push('⚠️ 部分自定义域名未恢复，请到 Dashboard 手动绑定');
                        }
                    }
                } else {
                    steps.push(await parseApiError(uploadRes));
                    steps.push('⚠️ Worker 已删除但重建失败，请重试或手动恢复');
                }
            } catch (err: any) {
                steps.push(`❌ ${err.message}`);
            }
            logItem.msg = steps.join(' → ');
            logs.push(logItem);
        }

        // Step 4(账号级): 至少一个 Worker 重建成功后，每账号只执行一次子域名轮换
        if (accAnySuccess) {
            try {
                const delSubRes = await fetchWithTimeout(cf.acctSubdomain(acc.accountId), { method: 'DELETE', headers });
                if (!delSubRes.ok) {
                    logs.push({ name: acc.alias, success: true, msg: '🌐 子域名: 跳过（删除旧子域名失败 HTTP ' + delSubRes.status + '）' });
                } else {
                    const randomSub = randomSubdomain();
                    const subRes = await fetchWithTimeout(cf.acctSubdomain(acc.accountId), {
                        method: 'PUT', headers,
                        body: JSON.stringify({ subdomain: randomSub })
                    });
                    if (subRes.ok) {
                        logger.audit('fix1101 subdomain rotated', { accountId: acc.accountId, to: randomSub });
                        logs.push({ name: acc.alias, success: true, msg: `🌐 子域名 → ${randomSub}` });
                    } else {
                        logs.push({ name: acc.alias, success: true, msg: '⚠️ 子域名已删除但新值设置失败 (HTTP ' + subRes.status + ')，请到 Dashboard 手动设置' });
                    }
                }
            } catch (e) { logs.push({ name: acc.alias, success: true, msg: '🌐 子域名: 跳过 (' + (e as Error).message + ')' }); }
        }
    }

    // 只有真正重建成功过才更新部署配置（子域名轮换那条 success:true 不算重建成功）
    const rebuiltOk = logs.some(l => l.success && l.msg.includes('重建成功'));
    if (rebuiltOk) {
        await putJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), {
            mode: 'latest',
            currentSha: latestSha || 'unknown',
            deployTime: new Date().toISOString(),
            lastAttempt: new Date().toISOString(),
            pendingTargets: [],
            pendingSha: null
        });
    }

    return json(logs);
}
