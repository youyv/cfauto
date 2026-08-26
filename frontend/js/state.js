// ===== 全局状态 & 初始化 =====

/**
 * 全局可变状态。
 *
 * 此前这些是模块顶层的 let 变量 + `window.accounts = accounts` 形式的导出：那种导出只是
 * 初始化时的**值快照**，后续 `accounts = d.accounts` 重新绑定局部变量不会更新 window.accounts，
 * 任何按 window.accounts 写的代码都拿到永远为空的初始数组。改为单一 state 对象后，
 * 所有读写都经过同一份引用，导出即真实状态。
 */
const state = {
    accounts: [],
    editingIndex: -1,
    deletedVars: {},
    deployConfigs: {},
    currentHistoryType: null,
    favData: []
};

/** 兼容旧写法的取值别名（读写都落到 state 上） */
Object.defineProperties(window, {
    accounts: {
        get: () => state.accounts,
        set: (v) => { state.accounts = Array.isArray(v) ? v : []; },
        configurable: true
    },
    editingIndex: {
        get: () => state.editingIndex,
        set: (v) => { state.editingIndex = v; },
        configurable: true
    },
    deletedVars: { get: () => state.deletedVars, configurable: true },
    deployConfigs: { get: () => state.deployConfigs, configurable: true },
    currentHistoryType: {
        get: () => state.currentHistoryType,
        set: (v) => { state.currentHistoryType = v; },
        configurable: true
    }
});

/** 初始化每个模板的 deletedVars 槽位（模板列表由服务端注入的 TEMPLATES 决定） */
function resetDeletedVars() {
    Object.keys(TEMPLATES).forEach(t => { state.deletedVars[t] = []; });
}

async function init() {
    resetDeletedVars();
    // 🚀 单次 /api/init_data 替代多轮 fetch：accounts + vars + autoConfig + deployConfigs
    try {
        const d = await apiFetch('/api/init_data');

        // 恢复 accounts（防御：后端异常时可能非数组）
        state.accounts = Array.isArray(d.accounts) ? d.accounts : [];
        state.accounts.forEach(a => a.stats = a.stats || { total: 0, max: a.dailyLimit || 100000 });

        // 恢复 deployConfigs
        state.deployConfigs = d.deployConfigs || {};

        applyAutoConfigToUi(d.autoConfig || {});

        // 恢复 vars + defaultVars 补充缺失变量 + 重置已删除追踪
        Object.keys(TEMPLATES).forEach(t => {
            state.deletedVars[t] = [];
            const container = $('vars_' + t);
            if (!container) return;
            const savedVars = (d.vars && Array.isArray(d.vars[t])) ? d.vars[t] : [];
            const map = new Map();
            savedVars.forEach(v => { if (v && v.key) map.set(v.key, v); });
            TEMPLATES[t].defaultVars.forEach(k => {
                if (!map.has(k)) map.set(k, { key: k, value: k === TEMPLATES[t].uuidField ? crypto.randomUUID() : '' });
            });
            container.innerHTML = '';
            map.forEach(v => addVarRow(t, v.key, v.value, v.secret));
        });

        renderTable();
        renderProxySelector();
    } catch (e) {
        console.error('[init] /api/init_data failed, fallback to individual requests:', e);
        if (typeof Swal !== 'undefined') {
            Swal.fire('初始化数据加载失败', (e && e.message) || '将回退到逐个请求', 'warning');
        }
        // 降级：回退到逐个请求
        renderProxySelector();
        await loadAccounts();
        await Promise.all(Object.keys(TEMPLATES).map(t => loadVars(t)));
        await loadGlobalConfig();
    }

    // 以下为 lazy 加载（不阻塞首屏）
    loadStats();
    // 所有模板都做版本检查 —— ech 同样需要跟随上游更新（此前被 uuidField 条件排除）
    Object.keys(TEMPLATES).forEach(t => { checkDeployConfig(t); checkUpdate(t); });
}

/** 把自动更新配置回填到 Header 控件（init 与 loadGlobalConfig 共用） */
function applyAutoConfigToUi(ac) {
    const master = $('auto_update_toggle');
    if (master) master.checked = !!ac.enabled;
    updateAutoToggleLabel();
    if ($('auto_update_interval')) $('auto_update_interval').value = ac.interval || 30;
    if ($('fuse_threshold')) $('fuse_threshold').value = ac.fuseThreshold || 0;
    if ($('fuse_webhook')) $('fuse_webhook').value = ac.fuseWebhook || '';
    // 每模板开关：主开关关闭时全部显示为关
    Object.keys(TEMPLATES).forEach(t => {
        const el = $('auto_' + t + '_toggle');
        if (!el) return;
        const flag = 'auto' + t.charAt(0).toUpperCase() + t.slice(1);
        el.checked = !!ac.enabled && ac[flag] !== false;
    });
}

// @exports
window.state = state;
window.init = init;
window.applyAutoConfigToUi = applyAutoConfigToUi;
window.resetDeletedVars = resetDeletedVars;
