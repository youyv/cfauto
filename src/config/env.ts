/** 环境变量类型定义 */
export interface AppEnv {
    CONFIG_KV: KVNamespace;
    ACCESS_CODE?: string;
    GITHUB_TOKEN?: string;
    /** 可选：独立数据加密密钥，设置后改 ACCESS_CODE 不影响已加密数据 */
    ENCRYPTION_SECRET?: string;
}

/** KV 读取选项（本项目只用到 cacheTtl） */
export interface KVGetOptions {
    /** 从 Cloudflare 边缘缓存读取的秒数（最小 60），用于削掉热键的读延迟 */
    cacheTtl?: number;
}

/** KV 写入选项 */
export interface KVPutOptions {
    /** 相对过期秒数（最小 60）；SESSION_* / RATE_LIMIT_* / 探测缓存用它 */
    expirationTtl?: number;
    /** 绝对过期时间（Unix 秒），与 expirationTtl 二选一 */
    expiration?: number;
    /** 自定义元数据 */
    metadata?: unknown;
}

/** KV 列举选项 */
export interface KVListOptions {
    prefix?: string;
    cursor?: string;
    limit?: number;
}

/** Cloudflare KV Namespace 最小接口 */
export interface KVNamespace {
    get(key: string, options?: KVGetOptions): Promise<string | null>;
    put(key: string, value: string, options?: KVPutOptions): Promise<void>;
    delete(key: string): Promise<void>;
    /**
     * 列举键。真实 KV 单次最多返回 1000 个键，未列完时 `list_complete` 为 false
     * 且给出 `cursor` —— 只读第一页会漏掉后面的键，回收逻辑必须翻页（见 listAllKeys）。
     */
    list(options?: KVListOptions): Promise<{ keys: Array<{ name: string }>; list_complete?: boolean; cursor?: string }>;
}
/** 账号凭证 */
export interface AccountCredentials {
    accountId: string;
    email: string;
    globalKey: string;
    /** 可选：API Token（与 globalKey 二选一，优先使用） */
    apiToken?: string;
}
