// ===== 全局状态 & 初始化 =====

let accounts = [];
let editingIndex = -1;
let deletedVars = { cmliu: [], joey: [], ech: [] };
let deployConfigs = {};
let currentHistoryType = null;

async function init() {
    // 🚀 单次 /api/init_data 替代多轮 fetch：accounts + vars + autoConfig + deployConfigs
    try {
        const r = await fetch('/api/init_data');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();

        // 恢复 accounts
        accounts = d.accounts || [];
        accounts.forEach(a => a.stats = a.stats || { total: 0, max: a.dailyLimit || 100000 });

        // 恢复 deployConfigs
        deployConfigs = d.deployConfigs || {};

        // 恢复 autoConfig 到 UI
        const ac = d.autoConfig || {};
        $('auto_update_toggle').checked = !!ac.enabled;
        updateAutoToggleLabel();
        $('auto_update_interval').value = ac.interval || 30;
        $('fuse_threshold').value = ac.fuseThreshold || 0;
        $('fuse_webhook').value = ac.fuseWebhook || '';
        $('auto_cmliu_toggle').checked = ac.enabled && ac.autoCmliu !== false;
        $('auto_joey_toggle').checked = ac.enabled && ac.autoJoey !== false;
        $('auto_ech_toggle').checked = ac.enabled && ac.autoEch !== false;

        // 恢复 vars + 重置已删除追踪
        Object.keys(TEMPLATES).forEach(t => {
            deletedVars[t] = [];
            if (d.vars && d.vars[t]) {
                const container = document.getElementById('vars_' + t);
                if (container) {
                    container.innerHTML = '';
                    d.vars[t].forEach(v => addVarRow(t, v.key, v.value, v.secret));
                }
            }
        });

        renderTable();
        renderProxySelector();
    } catch (e) {
        console.error('[init] /api/init_data failed, fallback to individual requests:', e);
        // 降级：回退到逐个请求
        renderProxySelector();
        await loadAccounts();
        await Promise.all(Object.keys(TEMPLATES).map(t => loadVars(t)));
        await loadGlobalConfig();
    }

    // 以下为 lazy 加载（不阻塞首屏）
    loadStats();
    Object.keys(TEMPLATES).filter(t => TEMPLATES[t].uuidField).forEach(t => { checkDeployConfig(t); checkUpdate(t); });
}
