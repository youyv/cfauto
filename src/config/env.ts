/** 环境变量类型定义 */
export interface AppEnv {
    CONFIG_KV: KVNamespace;
    ACCESS_CODE?: string;
    GITHUB_TOKEN?: string;
    /** 可选：独立数据加密密钥，设置后改 ACCESS_CODE 不影响已加密数据 */
    ENCRYPTION_SECRET?: string;
}

/** Cloudflare KV Namespace 最小接口 */
export interface KVNamespace {
    get(key: string, options?: any): Promise<string | null>;
    put(key: string, value: string, options?: any): Promise<void>;
    delete(key: string): Promise<void>;
    /**
     * 列举键。真实 KV 单次最多返回 1000 个键，未列完时 `list_complete` 为 false
     * 且给出 `cursor` —— 只读第一页会漏掉后面的键，回收逻辑必须翻页（见 listAllKeys）。
     */
    list(options?: any): Promise<{ keys: Array<{ name: string }>; list_complete?: boolean; cursor?: string }>;
}
/** 账号凭证 */
export interface AccountCredentials {
    accountId: string;
    email: string;
    globalKey: string;
}
