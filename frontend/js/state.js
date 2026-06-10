// ===== 全局状态 & 初始化 =====

let accounts = [];
let editingIndex = -1;
let deletedVars = { cmliu: [], joey: [], ech: [] };
let deployConfigs = {};
let currentHistoryType = null;

async function init() {
    renderProxySelector();
    await loadAccounts();
    await Promise.all(['cmliu','joey','ech'].map(t => loadVars(t)));
    await loadGlobalConfig();
    loadStats();
    ['cmliu','joey'].forEach(t => { checkDeployConfig(t); checkUpdate(t); });
}
