/**
 * Cloudflare API 工具 — URL 构建器 + 认证头
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

export const cf = {
    workerScript:   (aid: string, name: string)      => `${CF_API}/accounts/${aid}/workers/scripts/${name}`,
    workerBindings: (aid: string, name: string)      => `${CF_API}/accounts/${aid}/workers/scripts/${name}/bindings`,
    workerSubdomain:(aid: string, name: string)      => `${CF_API}/accounts/${aid}/workers/scripts/${name}/subdomain`,
    workerDomains:  (aid: string)                    => `${CF_API}/accounts/${aid}/workers/domains`,
    acctSubdomain:  (aid: string)                    => `${CF_API}/accounts/${aid}/workers/subdomain`,
    workerScripts:  (aid: string)                    => `${CF_API}/accounts/${aid}/workers/scripts`,
    kvNamespaces:   (aid: string)                    => `${CF_API}/accounts/${aid}/storage/kv/namespaces`,
    kvNamespace:    (aid: string, nsId: string)      => `${CF_API}/accounts/${aid}/storage/kv/namespaces/${nsId}`,
    kvValue:        (aid: string, nsId: string, key: string) => `${CF_API}/accounts/${aid}/storage/kv/namespaces/${nsId}/values/${key}`,
    zones:          (aid: string)                    => `${CF_API}/zones?account.id=${aid}&per_page=50`,
    userTokenVerify:()                               => `${CF_API}/user/tokens/verify`,
    graphql:        ()                               => `${CF_API}/graphql`,
};

/** 获取 CF API 认证头，upload=true 时不含 Content-Type（由 FormData 自动设置） */
export function getAuthHeaders(email: string, key: string, upload = false) {
    const base = { "X-Auth-Email": email, "X-Auth-Key": key };
    return upload ? base : { ...base, "Content-Type": "application/json" };
}

/** 统一 JSON 错误响应 */
export function jsonError(msg: string, status = 500) {
    return new Response(JSON.stringify({ success: false, msg }), {
        status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
}

/** 统一 JSON 成功响应 */
export function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
}
