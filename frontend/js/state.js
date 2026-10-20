// ===== 全局状态 & 初始化 =====

/**
 * 全局可变状态。
 *
 * 此前这些是模块顶层的 let 变量 + `window.accounts = accounts` 形式的导出：那种导出只是
 * 初始化时的**值快照**，后续 `accounts = d.accounts` 重新绑定局部变量不会更新 window.accounts，
 * 任何按 window.accounts 写的代码都拿到永远为空的初始数组。改为单一 state 对象后，
 * 所有读写都经过同一份引用，导出即真实状态。
 *
 * 曾经还有一层 `Object.defineProperties(window, {...})` 兼容别名（window.accounts /
 * editingIndex / deletedVars / deployConfigs / currentHistoryType）。全部模块拼接后共享
 * 同一个脚本作用域，直接写 `state.xxx` 即可，那些别名没有任何读取方；其中 deletedVars 与
 * deployConfigs 只有 getter，`window.deletedVars = x` 在非严格模式下会**静默失败** ——
 * 留着只是给未来埋坑，已删除。
 */
const state = {
    accounts: [],
    editingIndex: -1,
    deletedVars: {},
    deployConfigs: {},
    currentHistoryType: null,
    savedAutoConfig: null,
    favData: []
};

/** 初始化每个模板的 deletedVars 槽位（模板列表由服务端注入的 TEMPLATES 决定） */
function resetDeletedVars() {
    Object.keys(TEMPLATES).forEach(t => { state.deletedVars[t] = []; });
}

async function init() {
    resetDeletedVars();
    // 🚀 单次 /api/init_data 替代多轮 fetch：accounts + vars + autoConfig + deployConfigs
    try {
        const d = await apiFetch('/api/init_data');
        if (d.reliability && d.reliability.protocol === 1) Object.keys(d.reliability.revisions).forEach(domain => acceptConfigView(domain, d));
        applyTemplateSettings(d.templateSettings || {});

        // 恢复 accounts（防御：后端异常时可能非数组）
        state.accounts = Array.isArray(d.accounts) ? d.accounts : [];
        state.accounts.forEach(a => a.stats = a.stats || { total: 0, max: a.dailyLimit || 100000 });

        // 恢复 deployConfigs
        state.deployConfigs = d.deployConfigs || {};

        applyAutoConfigToUi({ ...(d.autoConfig || {}), ...((d.runtime && d.runtime.value) || {}) });

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
        applyProjectTabs();
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
        // 降级路径同样要初始化标签页与元数据提示，否则这里会留白、tab 也没有高亮
        applyProjectTabs();
    }

    ['cmliu', 'joey'].forEach(t => loadUpstream(t));
    // 以下为 lazy 加载（不阻塞首屏）
    loadStats();
    // 所有模板都做版本检查 —— ech 同样需要跟随上游更新（此前被 uuidField 条件排除）
    Object.keys(TEMPLATES).forEach(t => { checkDeployConfig(t); checkUpdate(t); });
}

function switchProjectTab(tab) {
    const panels = Array.from(document.querySelectorAll('[data-tab-panel]'));
    const buttons = Array.from(document.querySelectorAll('[data-tab-btn]'));
    // Invalid actions must not hide every project or discard the active selection.
    if (!panels.some(p => p.dataset.tabPanel === tab) || !buttons.some(b => b.dataset.tabBtn === tab)) return;
    panels.forEach(p => {
        const selected = p.dataset.tabPanel === tab;
        p.classList.toggle('hidden', !selected);
        p.hidden = !selected;
    });
    buttons.forEach(b => {
        const selected = b.dataset.tabBtn === tab;
        b.classList.toggle('tab-active', selected);
        b.setAttribute('aria-selected', String(selected));
        b.tabIndex = selected ? 0 : -1;
    });
}
// These panels are already in the DOM: automatic activation needs no network read.
document.addEventListener('keydown', e => {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const button = e.target.closest && e.target.closest('[role="tab"][data-tab-btn]');
    const list = button && button.closest('[role="tablist"]');
    if (!list || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const buttons = Array.from(list.querySelectorAll('[data-tab-btn]')).filter(b => !b.disabled);
    const index = buttons.indexOf(button);
    if (index < 0) return;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
        : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    e.preventDefault();
    switchProjectTab(buttons[next].dataset.tabBtn);
    buttons[next].focus();
});

/** 渲染每个模板卡片的仓库直链 / 访问路径 / 兼容日期（元数据来自服务端注入的 TEMPLATES） */
function renderTemplateHints() {
    document.querySelectorAll('[data-hints]').forEach(function (el) {
        const t = el.getAttribute('data-hints');
        const conf = TEMPLATES[t];
        if (!conf) return;
        const parts = [];
        if (conf.repoUrl) parts.push('<a href="' + safeHtml(conf.repoUrl) + '" target="_blank" rel="noreferrer" class="text-blue-500 hover:underline"> <span data-ui-icon="external-link">🔗</span> 开源仓库</a>');
        if (conf.adminPath) parts.push('<span>后台路径 <b class="font-mono">' + safeHtml(conf.adminPath) + '</b></span>');
        if (conf.subPath) parts.push('<span>订阅路径 <b class="font-mono">' + safeHtml(conf.subPath) + '</b></span>');
        if (conf.compatibilityDate) parts.push('<span>兼容日期 <b class="font-mono">' + safeHtml(conf.compatibilityDate) + '</b></span>');
        el.innerHTML = parts.join('<span class="mx-1 opacity-40">·</span>');
    });
}

/** 初始化标签页（默认选中第一个模板）并渲染元数据提示 */
function applyProjectTabs() {
    renderTemplateHints();
    const first = Object.keys(TEMPLATES)[0];
    if (first) switchProjectTab(first);
}

/** 兼容日期是可按模板编辑的权威配置（template:<type>），默认值来自服务端注入的 TEMPLATES。 */
function syncCompatibilityInputs() {
    Object.keys(TEMPLATES).forEach(t => {
        const input = $('compat_' + t);
        if (input) input.value = TEMPLATES[t].compatibilityDate || '';
    });
}
function applyTemplateSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    Object.keys(TEMPLATES).forEach(t => {
        const entry = settings[t];
        const date = entry && typeof entry === 'object' ? entry.compatibilityDate : undefined;
        if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) TEMPLATES[t].compatibilityDate = date;
    });
    syncCompatibilityInputs();
    renderTemplateHints();
}
async function saveCompatibilityDate(t) {
    const input = $('compat_' + t), status = $('compat_' + t + '_status');
    if (!input || !Object.hasOwn(TEMPLATES, t)) return;
    const value = String(input.value || '').trim();
    const today = new Date().toISOString().slice(0, 10);
    const fail = message => {
        if (status) status.textContent = message;
        if (typeof Swal !== 'undefined') Swal.fire('保存失败', message, 'error');
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('请选择合法日期（YYYY-MM-DD）');
    if (value < '2021-11-01' || value > today) return fail('兼容日期必须在 2021-11-01 与今天之间');
    if (!configProtocol || !configProtocol.isEnabled()) return fail('当前部署模式不支持在线修改兼容日期（仅 authority 模式）');
    const baseline = configProtocol.baseline('template:' + t);
    if (!baseline) return fail('缺少该仓库的权威修订；请刷新页面后重试');
    if (status) status.textContent = '保存中…';
    try {
        const data = await apiFetch('/api/reliability/config', {
            method: 'POST',
            body: JSON.stringify({
                key: crypto.randomUUID(), generation: baseline.generation, epoch: baseline.epoch, revision: baseline.revision,
                selector: { kind: 'template', template: t }, value: { compatibilityDate: value }
            })
        });
        if (!data || data.domain !== 'template:' + t || typeof data.revision !== 'number') throw new Error('保存回执不完整；请重新读取后再试');
        TEMPLATES[t].compatibilityDate = value;
        renderTemplateHints();
        if (status) status.textContent = '已保存 ' + value;
        if (typeof wbLog === 'function') wbLog('🕒 ' + t + ' 兼容日期已保存为 ' + value + '（部署/更新/1101 修复按计划冻结）', 'text-green-400');
        if (typeof Swal !== 'undefined') Swal.fire({ icon: 'success', title: '兼容日期已保存', text: t + ' → ' + value, timer: 1400, showConfirmButton: false });
    } catch (e) {
        if (status) status.textContent = '保存失败';
        if (typeof Swal !== 'undefined') Swal.fire('保存失败', e.message, 'error');
    }
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
    state.savedAutoConfig = { ...ac };
    renderAutomationSummary(state.savedAutoConfig);
    configDrafts.accept('auto');
}

registerActions({
    saveCompatibilityDate: saveCompatibilityDate
});
