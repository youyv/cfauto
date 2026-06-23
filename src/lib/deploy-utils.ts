import type { AccountCredentials } from "../config/env";
import { cf, getAuthHeaders } from "./cloudflare-api";

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
        return "❌ HTTP " + res.status;
    }
}