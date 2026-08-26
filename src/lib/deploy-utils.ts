import type { AccountCredentials } from "../config/env";
import { cf, getAuthHeaders, fetchWithTimeout } from "./cloudflare-api";
import { BINDING } from "../config/templates";
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

/** 上传被管理 Worker 使用的兼容性日期（固定值，见常量注释） */
export function getCompatibilityDate(): string {
    return MANAGED_WORKER_COMPATIBILITY_DATE;
}

/** 上传 Worker 脚本到 Cloudflare */
export async function uploadWorker(
    cred: AccountCredentials,
    workerName: string, scriptContent: string,
    bindings: Array<Record<string, unknown>>
): Promise<{ ok: boolean; res: Response }> {
    const metadata = {
        main_module: "index.js",
        bindings,
        compatibility_date: getCompatibilityDate()
    };
    const formData = new FormData();
    formData.append("metadata", JSON.stringify(metadata));
    formData.append("script", new Blob([scriptContent], { type: "application/javascript+module" }), "index.js");
    const headers = getAuthHeaders(cred.email, cred.globalKey, true);
    // 上传脚本可能较大（数百 KB），超时放宽到 60s
    const res = await fetchWithTimeout(cf.workerScript(cred.accountId, workerName), {
        method: "PUT", headers, body: formData
    }, 60000);
    return { ok: res.ok, res };
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
