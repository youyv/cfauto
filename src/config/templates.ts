/**
 * 模板配置 — 定义每个项目的 GitHub 拉取源、KV 绑定名、变量结构
 */
export const TEMPLATES: Record<string, {
    name: string;
    ghUser: string;
    ghRepo: string;
    ghBranch: string;
    ghPath: string;
    defaultVars: string[];
    uuidField: string;
    description: string;
    kvBindingName: string;
    yxipKey: string;
    yxipContentType: string;
    yxipBuildContent: (raw: string) => string;
    /** 是否参与 cron 自动版本更新。与 uuidField 无关 —— 无 UUID 的模板同样需要跟随上游更新 */
    autoUpdate: boolean;
}> = {
    // ===== CMliu (EdgeTunnel) =====
    // 上游: cmliu/edgetunnel  main 分支  _worker.js
    // KV 绑定名: "KV"  优选节点键: ADD.txt (纯文本)
    'cmliu': {
        name: "CMliu - EdgeTunnel",
        ghUser: "cmliu",
        ghRepo: "edgetunnel",
        ghBranch: "main",
        ghPath: "_worker.js",
        defaultVars: ["UUID", "PROXYIP", "DOH", "PATH", "URL", "KEY", "ADMIN", "TCP_CONCURRENT_DIAL", "PROXY_CONCURRENT_DIAL"],
        uuidField: "UUID",
        description: "CMliu (beta2.1) - 建议开启 KV",
        kvBindingName: 'KV',                          // Worker 绑定名称
        yxipKey: 'ADD.txt',                           // KV 中存储优选节点的键
        yxipContentType: 'text/plain',                // 写入 KV 时的 Content-Type
        yxipBuildContent: (raw) => raw,               // 直接透传原始内容
        autoUpdate: true,
    },
    // ===== Joey (cfnew) =====
    // 上游: byJoey/cfnew  main 分支  少年你相信光吗
    // KV 绑定名: "C"  优选节点键: c (JSON 配置)
    'joey': {
        name: "Joey - 少年你相信光吗",
        ghUser: "byJoey",
        ghRepo: "cfnew",
        ghBranch: "main",
        ghPath: "少年你相信光吗",
        defaultVars: ["u"],
        uuidField: "u",
        description: "Joey (自动修复) - KV 可选",
        kvBindingName: 'C',
        yxipKey: 'c',
        yxipContentType: 'application/json',
        yxipBuildContent: (raw) => JSON.stringify({
            "ev": "yes", "et": "no", "ex": "no", "epd": "no",
            "epi": "yes", "egi": "no", "d": "990200",
            "ipv4": "yes", "ipv6": "no",
            "ispMobile": "yes", "ispUnicom": "no", "ispTelecom": "no",
            "yx": raw, "dkby": "yes", "ech": "yes",
            "scu": "https://SUBAPI.cmliussss.net"
        }),
        autoUpdate: true,
    },
    // ===== ECH (WebSocket Proxy) =====
    // 上游: hc990275/ech-wk  main 分支  _worker.js
    // 无 KV 绑定  无优选节点功能
    'ech': {
        name: "ECH - WebSocket Proxy",
        ghUser: "hc990275",
        ghRepo: "ech-wk",
        ghBranch: "main",
        ghPath: "_worker.js",
        defaultVars: ["PROXYIP"],
        uuidField: "",
        description: "ECH (无需频繁更新)",
        kvBindingName: '',
        yxipKey: '',
        yxipContentType: 'text/plain',
        yxipBuildContent: (raw: string) => raw,
        // ech 无 UUID，无法参与熔断轮换，但版本更新必须跟随上游
        autoUpdate: true,
    }
};

/** 参与 cron 自动版本更新的模板类型 */
export function autoUpdateTypes(): string[] {
    return Object.entries(TEMPLATES).filter(([, t]) => t.autoUpdate).map(([k]) => k);
}

/** 可参与熔断 UUID 轮换的模板类型（必须有 uuidField 才能换 UUID） */
export function fuseRotatableTypes(): string[] {
    return Object.entries(TEMPLATES).filter(([, t]) => t.uuidField).map(([k]) => k);
}

/** 绑定类型常量 — 避免魔法字符串散落各处 */
export const BINDING = {
  PLAIN_TEXT: 'plain_text' as const,
  SECRET_TEXT: 'secret_text' as const,
  KV_NAMESPACE: 'kv_namespace' as const,
};

export const ECH_PROXIES = [
    { group: "Global", list: ["ProxyIP.CMLiussss.net", "ProxyIP.Aliyun.CMLiussss.net", "ProxyIP.Oracle.CMLiussss.net"] },
    { group: "HK (香港)", list: ["ProxyIP.HK.CMLiussss.net", "ProxyIP.Aliyun.HK.CMLiussss.net", "ProxyIP.Oracle.HK.CMLiussss.net"] },
    { group: "JP (日本)", list: ["ProxyIP.JP.CMLiussss.net", "ProxyIP.Aliyun.JP.CMLiussss.net", "ProxyIP.Oracle.JP.CMLiussss.net"] },
    { group: "SG (新加坡)", list: ["ProxyIP.SG.CMLiussss.net", "ProxyIP.Aliyun.SG.CMLiussss.net", "ProxyIP.Oracle.SG.CMLiussss.net"] },
    { group: "KR (韩国)", list: ["ProxyIP.KR.CMLiussss.net", "ProxyIP.Oracle.KR.CMLiussss.net"] },
    { group: "US (美国)", list: ["ProxyIP.US.CMLiussss.net", "ProxyIP.Aliyun.US.CMLiussss.net", "ProxyIP.Oracle.US.CMLiussss.net"] },
    { group: "Europe", list: ["ProxyIP.DE.CMLiussss.net (德国)", "ProxyIP.UK.CMLiussss.net (英国)", "ProxyIP.FR.CMLiussss.net (法国)", "ProxyIP.NL.CMLiussss.net (荷兰)", "ProxyIP.RU.CMLiussss.net (俄罗斯)"] },
    { group: "Others", list: ["ProxyIP.TW.CMLiussss.net (台湾)", "ProxyIP.AU.CMLiussss.net (澳洲)", "ProxyIP.IN.CMLiussss.net (印度)"] }
];
/** KV 键名常量 — 所有数据存储的键统一在此定义，避免魔法字符串 */
export const KV_KEYS = {
    ACCOUNTS: 'ACCOUNTS_UNIFIED_STORAGE',              // 账号列表
    GLOBAL_CONFIG: 'AUTO_UPDATE_CFG_GLOBAL',            // 自动更新全局配置
    vars: (type: string) => `VARS_${type}`,             // 各模板全局变量（如 VARS_cmliu）
    /** 账号级变量覆盖（如 VARS_cmliu_ACC_<accountId>）— 熔断轮换 UUID 时只影响单个账号 */
    accountVars: (type: string, accountId: string) => `VARS_${type}_ACC_${accountId}`,
    deployConfig: (type: string) => `DEPLOY_CONFIG_${type}`, // 部署配置（锁定版本等）
    favorites: (type: string) => `FAVORITES_${type}`,   // 版本收藏
    DEPLOY_JOURNAL: 'DEPLOY_JOURNAL',                // 部署操作日志
};

/** 账号级变量键的正则 — 供 restore 白名单精确校验，防止前缀注入 */
const ACCOUNT_VARS_KEY_RE = /^VARS_([A-Za-z0-9_-]+)_ACC_([A-Za-z0-9]{1,64})$/;

/**
 * 解析账号级变量键 `VARS_<type>_ACC_<accountId>`。
 *
 * 模板类型未知时返回 null —— 既用于 restore 白名单（防前缀注入），也用于 KV 回收
 * （模板被删除后其遗留键同样属于孤儿）。
 */
export function parseAccountVarsKey(key: string): { type: string; accountId: string } | null {
    const m = ACCOUNT_VARS_KEY_RE.exec(key);
    if (!m || !TEMPLATES[m[1]]) return null;
    return { type: m[1], accountId: m[2] };
}

/** 判断某个 KV 键是否为合法的账号级变量键（模板类型必须已知） */
export function isAccountVarsKey(key: string): boolean {
    return parseAccountVarsKey(key) !== null;
}

/** 模板类型 → AutoUpdateConfig 开关字段名（cmliu → autoCmliu），无需逐个硬编码 */
export function autoFlagKey(type: string): string {
    return 'auto' + type.charAt(0).toUpperCase() + type.slice(1);
}

/** PWA Manifest */
export const MANIFEST = {
    "name": "Worker Pro", "short_name": "WorkerPro", "start_url": "/", "display": "standalone",
    "background_color": "#f3f4f6", "theme_color": "#1e293b",
    "icons": [{ "src": "https://www.cloudflare.com/img/logo-cloudflare-dark.svg", "sizes": "192x192", "type": "image/svg+xml" }]
};

/** 模板类型 — 编译时约束，防止拼写错误 */
export type TemplateType = keyof typeof TEMPLATES;