import type { AccountCredentials } from "../config/env";
import { cf, getAuthHeaders } from "./cloudflare-api";
import { logger } from "./logger";

/** 今天的兼容性日期 (YYYY-MM-DD) */
export function getCompatibilityDate(): string {
    return new Date().toISOString().split("T")[0];
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
    const res = await fetch(cf.workerScript(cred.accountId, workerName), {
        method: "PUT", headers, body: formData
    });
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
 *  消除 coreDeployLogic 和 handleBatchDeploy 的重复逻辑。 */
export function mergeVariableBindings(
    currentBindings: Array<Record<string, unknown>>,
    variables: Array<{ key: string; value: string; secret?: boolean }>,
    deletedVariables: string[] = []
): Array<Record<string, unknown>> {
    const deletedSet = new Set(deletedVariables);
    // 使用 Map 替代 findIndex 将 O(n*m) 降为 O(n+m)
    const bindingMap = new Map<string, Record<string, unknown>>();
    for (const b of currentBindings) {
        const name = b.name as string;
        if (!deletedSet.has(name)) {
            bindingMap.set(name, b);
        }
    }

    for (const v of variables) {
        if (!v.value || v.value.trim() === "") continue;
        const bindingType = v.secret ? "secret_text" : "plain_text";
        bindingMap.set(v.key, { name: v.key, type: bindingType, text: v.value });
    }
    return Array.from(bindingMap.values());
}
