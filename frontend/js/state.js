// ===== 全局状态 & 初始化 =====

let accounts = [];
let editingIndex = -1;
let deletedVars = { cmliu: [], joey: [], ech: [] };
let deployConfigs = {};
let currentHistoryType = null;

async function init() {
    renderProxySelector();
    await loadAccounts();
    await Promise.all(Object.keys(TEMPLATES).map(t => loadVars(t)));
    await loadGlobalConfig();
    loadStats();
    Object.keys(TEMPLATES).filter(t => TEMPLATES[t].uuidField).forEach(t => { checkDeployConfig(t); checkUpdate(t); });
}
