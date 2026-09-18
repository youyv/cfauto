import type { AccountCredentials } from "../config/env";
import { cf, getAuthHeaders, fetchWithTimeout, readApiResult } from "./cloudflare-api";
import { BINDING, TEMPLATES } from "../config/templates";
import { logger } from "./logger";
import type { VariableEntry } from "./types";

/**
 * 上传被管理 Worker 时使用的兼容性日期。
 *
 * 必须是固定且验证过的日期，不能用 `new Date()`：动态的「今天」会把未经测试的运行时行为
 * 变更引入用户的代理 Worker，且当日期超出目标账号 workerd 支持范围时上传会被直接拒绝。
 * 升级此常量前请先在一个账号上验证代理模板仍能正常工作。
 */
export const MANAGED_WORKER_COMPATIBILITY_DATE = '2026-07-16';

/**
 * 取某个模板使用的兼容性日期。
 *
 * 历史上三个模板共用一个常量，但各上游框架的运行时行为是在**各自的**兼容日期下验证的；
 * 共用一个日期会把未经验证的 workerd 行为变更带进用户的代理 Worker（源项目 Issue #10）。
 * `TEMPLATES` 中未声明日期的模板回落到 `MANAGED_WORKER_COMPATIBILITY_DATE`。
 */
export function getCompatibilityDate(type?: string): string {
    return (type && TEMPLATES[type]?.compatibilityDate) || MANAGED_WORKER_COMPATIBILITY_DATE;
}

/**
 * 上传结果。
 *
 * `ok` 只有在「HTTP 2xx **且**响应体 success !== false」时才为 true —— 见
 * `readUploadVerdict` 的注释，只看 HTTP 状态码是本项目出现过的静默假成功来源。
 */
export interface UploadResult {
    ok: boolean;
    res: Response;
    /** 失败原因（已从上游响应体解析出 errors[0].message）；ok 为 true 时缺省 */
    error?: string;
}

/**
 * 判定 CF 上传响应的真实结果。
 *
 * Cloudflare API v4 把裁决放在 JSON body 的 `success` / `errors` 里，HTTP 200 不等于成功。
 * 此前这里只有 `ok: res.ok`，一次「200 + success:false」会被记成部署成功、写进部署日志、
 * 并把版本账本推进到新 SHA，于是面板显示「已是最新」而 Worker 实际停在旧代码上，且因为
 * 账本已认为最新，cron 永远不会重试 —— 必须按失败处理才会进入重试队列。
 */
async function readUploadVerdict(res: Response): Promise<{ ok: boolean; error?: string }> {
    let body: any = null;
    let raw = '';
    try { raw = await res.text(); } catch (e) { logger.warn('uploadWorker: 响应体读取失败', { status: res.status, error: (e as Error).message }); }
    if (raw) { try { body = JSON.parse(raw); } catch { body = null; } }

    if (!res.ok) {
        const upstream = body?.errors?.[0]?.message || body?.message;
        return { ok: false, error: upstream ? upstream + ' (HTTP ' + res.status + ')' : 'HTTP ' + res.status };
    }
    if (body && body.success === false) {
        const upstream = body.errors?.[0]?.message || '上游未给出原因';
        return { ok: false, error: upstream + ' (HTTP ' + res.status + '，响应体 success:false)' };
    }
    return { ok: true };
}

/** 上传 Worker 脚本到 Cloudflare */
export async function uploadWorker(
    cred: AccountCredentials,
    workerName: string, scriptContent: string,
    bindings: Array<Record<string, unknown>>,
    /** 模板类型：用于取该模板专属的兼容日期，缺省回落到默认常量 */
    templateType?: string
): Promise<UploadResult> {
    const metadata = {
        main_module: "index.js",
        bindings,
        compatibility_date: getCompatibilityDate(templateType)
    };
    const formData = new FormData();
    formData.append("metadata", JSON.stringify(metadata));
    formData.append("script", new Blob([scriptContent], { type: "application/javascript+module" }), "index.js");
    const headers = getAuthHeaders(cred, undefined, true);
    // 上传脚本可能较大（数百 KB），超时放宽到 60s
    const res = await fetchWithTimeout(cf.workerScript(cred.accountId, workerName), {
        method: "PUT", headers, body: formData
    }, 60000);
    const verdict = await readUploadVerdict(res);
    return { ok: verdict.ok, res, error: verdict.error };
}

/** 归一化脚本文本：忽略 BOM、行尾与尾部空白差异，避免把格式差异误判成内容不一致 */
function normalizeScript(s: string): string {
    return s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/** 回读校验结论：verified = 内容确认一致；mismatch = 内容不一致（未真正生效）；unverified = 无法判定 */
export type VerifyVerdict = 'verified' | 'mismatch' | 'unverified';

/**
 * 上传后回读脚本内容，确认这次写入真的落在 Cloudflare 上。
 *
 * 为什么不能只信上传响应：熔断/自动更新都出现过「响应成功但脚本没变」的情形，此时账本
 * 一旦前进就再也不会重试。这里独立发一次 GET 下载脚本，与本次上传的内容比对。
 *
 * 判定不可用（GET 失败、响应为空）时返回 `unverified` 而不是 mismatch —— 网络抖动不该
 * 把一次成功的部署判成失败；只有**确实读到内容且对不上**才是 mismatch。
 */
export async function verifyWorkerScript(
    accountId: string, workerName: string,
    headers: Record<string, string>, expectedContent: string
): Promise<VerifyVerdict> {
    try {
        const res = await fetchWithTimeout(cf.workerScript(accountId, workerName), { headers });
        if (!res.ok) {
            logger.warn('verifyWorkerScript: 回读失败', { module: 'deploy-utils', accountId, workerName, status: res.status });
            return 'unverified';
        }
        const readback = await res.text();
        if (!readback) return 'unverified';
        const expected = normalizeScript(expectedContent);
        const actual = normalizeScript(readback);
        if (actual === expected) return 'verified';
        // 部分形态下 CF 会以 multipart 回包（含元数据段），脚本文本仍完整包含在其中
        if (actual.includes(expected)) return 'verified';
        return 'mismatch';
    } catch (e) {
        logger.warn('verifyWorkerScript: 回读异常', { module: 'deploy-utils', accountId, workerName, error: (e as Error).message });
        return 'unverified';
    }
}

/** 解析 Cloudflare API 错误消息 */
export async function parseApiError(res: Response): Promise<string> {
    try {
        const body: any = await res.json();
        return "❌ " + (body.errors?.[0]?.message || "API error");
    } catch (_) {
        logger.warn('parseApiError response.json() failed', { status: res.status, error: String(_) });
        return "❌ HTTP " + res.status;
    }
}

/**
 * 读取 Worker 的现有绑定列表。
 *
 * 抽自 zones.ts 与 fix1101.ts 中重复的「读 bindings」片段。调用方必须对
 * 失败保持警惕：拿到空数组就当「无绑定」继续操作，会永久删除该 Worker 的
 * KV / secret 绑定。因此这里同时返回 ok 标记，让调用方能明确区分
 * 「确实没有绑定」与「读取失败」。
 */
export async function readWorkerBindings(
    accountId: string, workerName: string, headers: Record<string, string>
): Promise<{ ok: boolean; bindings: Array<Record<string, any>> }> {
    const res = await fetchWithTimeout(cf.workerBindings(accountId, workerName), { headers });
    if (!res.ok) {
        logger.warn('readWorkerBindings failed', { module: 'deploy-utils', accountId, workerName, status: res.status });
        return { ok: false, bindings: [] };
    }
    const bindings = await readApiResult<Array<Record<string, any>>>(res, '读取绑定') || [];
    return { ok: true, bindings };
}

/**
 * 删除 KV 命名空间，带 409 退避重试。
 *
 * CF 解绑命名空间是异步的，删除常返回 409（仍被引用）。抽自 zones.ts
 * 中已验证的重试策略，供 fix1101 等其它删除路径复用。
 *
 * @returns 未能删除的命名空间 ID 列表（空数组表示全部成功）
 */
export async function deleteKvNamespaces(
    accountId: string, namespaceIds: string[], headers: Record<string, string>,
    maxAttempts = 5, baseDelayMs = 2000
): Promise<string[]> {
    const failed: string[] = [];
    for (const nsId of namespaceIds) {
        let deleted = false;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const delRes = await fetchWithTimeout(cf.kvNamespace(accountId, nsId), {
                method: "DELETE", headers
            });
            if (delRes.ok) { deleted = true; break; }
            // 409 = 命名空间仍被引用（CF 解绑异步），退避后重试；其他错误立即放弃
            if (delRes.status !== 409) break;
            await new Promise(r => setTimeout(r, baseDelayMs));
        }
        if (!deleted) {
            failed.push(nsId);
            logger.warn('KV namespace deletion failed', { module: 'deploy-utils', accountId, nsId });
        }
    }
    return failed;
}

/** 将变量列表合并到现有 bindings — 覆盖同名、新增、排除已删除项。
 *  消除 coreDeployLogic 和 handleBatchDeploy 的重复逻辑。
 *
 *  注意：空值（含纯空白）会被**跳过而非清空**，这样上游模板的默认值仍生效。
 *  要真正移除某个变量，必须通过 deletedVariables 显式声明（前端对应「×」删除按钮）。 */
export function mergeVariableBindings(
    currentBindings: Array<Record<string, unknown>>,
    variables: VariableEntry[],
    deletedVariables: string[] = []
): Array<Record<string, unknown>> {
    const deletedSet = new Set(deletedVariables);
    // 使用 Map 替代 findIndex 将 O(n*m) 降为 O(n+m)
    const bindingMap = new Map<string, Record<string, unknown>>();
    for (const b of currentBindings || []) {
        const name = b?.name as string;
        if (name && !deletedSet.has(name)) {
            bindingMap.set(name, b);
        }
    }

    for (const v of variables || []) {
        // 空 key 跳过（前端空行）；空值跳过（不写入绑定）：这样上游模板的默认值仍生效。
        // 若需要真正移除某个变量，请通过 deletedVariables 显式声明。
        if (!v || !v.key) continue;
        if (deletedSet.has(v.key)) continue;
        if (!v.value || v.value.trim() === "") continue;
        const bindingType = v.secret ? BINDING.SECRET_TEXT : BINDING.PLAIN_TEXT;
        bindingMap.set(v.key, { name: v.key, type: bindingType, text: v.value });
    }
    return Array.from(bindingMap.values());
}
