/** 环境变量类型定义 */
export interface AppEnv {
    CONFIG_KV: KVNamespace;
    ACCESS_CODE?: string;
    GITHUB_TOKEN?: string;
}

/** Cloudflare KV Namespace 最小接口 */
export interface KVNamespace {
    get(key: string, options?: any): Promise<string | null>;
    put(key: string, value: string): Promise<void>;
    list(options?: any): Promise<{ keys: Array<{ name: string }> }>;
}
/** 账号凭证 */
export interface AccountCredentials {
    accountId: string;
    email: string;
    globalKey: string;
}
