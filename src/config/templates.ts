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
        defaultVars: ["UUID", "PROXYIP", "DOH", "PATH", "URL", "KEY", "ADMIN"],
        uuidField: "UUID",
        description: "CMliu (beta2.1) - 建议开启 KV",
        kvBindingName: 'KV',                          // Worker 绑定名称
        yxipKey: 'ADD.txt',                           // KV 中存储优选节点的键
        yxipContentType: 'text/plain',                // 写入 KV 时的 Content-Type
        yxipBuildContent: (raw) => raw,               // 直接透传原始内容
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
    }
};

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
    vars: (type: string) => `VARS_${type}`,             // 各模板变量（如 VARS_cmliu）
    deployConfig: (type: string) => `DEPLOY_CONFIG_${type}`, // 部署配置（锁定版本等）
    favorites: (type: string) => `FAVORITES_${type}`,   // 版本收藏
    DEPLOY_JOURNAL: 'DEPLOY_JOURNAL',                // 部署操作日志
};

/** PWA Manifest */
export const MANIFEST = {
    "name": "Worker Pro", "short_name": "WorkerPro", "start_url": "/", "display": "standalone",
    "background_color": "#f3f4f6", "theme_color": "#1e293b",
    "icons": [{ "src": "https://www.cloudflare.com/img/logo-cloudflare-dark.svg", "sizes": "192x192", "type": "image/svg+xml" }]
};

/** 模板类型 — 编译时约束，防止拼写错误 */
export type TemplateType = keyof typeof TEMPLATES;