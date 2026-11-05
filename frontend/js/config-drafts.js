// ===== 服务端快照与表单草稿（仅驻留内存，不持久化 Webhook 等配置） =====
const configDrafts = (() => {
    const groups = {
        auto: { fields: ['auto_update_toggle', 'auto_update_interval', 'fuse_threshold', 'fuse_webhook', ...Object.keys(TEMPLATES).map(t => 'auto_' + t + '_toggle')], selector: '.automation-drawer', badge: 'auto_config_status' },
        ...Object.fromEntries(['cmliu', 'joey'].map(t => ['upstream_' + t, {
            fields: ['upstream_path_' + t, 'upstream_branch_' + t],
            selector: '[data-tab-panel="' + t + '"] .upstream-card', badge: 'upstream_dirty_' + t
        }]))
    };
    const snapshot = key => JSON.stringify(groups[key].fields.map(id => {
        const el = $(id);
        return el ? (el.type === 'checkbox' ? el.checked : el.value) : null;
    }));
    const isDirty = key => groups[key].saved !== undefined && groups[key].saved !== snapshot(key);
    const anyDirty = () => Object.keys(groups).some(isDirty);
    function render(key) {
        const group = groups[key], dirty = isDirty(key), badge = $(group.badge);
        if (badge) {
            const text = dirty ? '未保存' : group.saved === undefined ? (group.error ? '读取失败' : '读取中…') : '已保存';
            // Do not retrigger a polite live region for each keystroke in the same state.
            if (badge.textContent !== text) badge.textContent = text;
            badge.dataset.dirty = String(dirty);
            badge.title = dirty ? '当前表单尚未生效，部署与定时任务仍使用已保存的配置' : '以最近一次成功读取或保存的配置为准';
        }
        document.querySelectorAll(group.selector + ' input, ' + group.selector + ' button').forEach(el => {
            // 读取失败后仍可重试，但不能提交尚未读取的默认表单。
            el.disabled = !!group.busy || (group.saved === undefined && el.dataset?.act !== 'loadUpstream');
        });
    }
    async function confirmDiscard(key) {
        if (!(key ? isDirty(key) : anyDirty())) return true;
        const result = await Swal.fire({ title: '放弃未保存的配置？', text: '未保存的表单编辑将丢失，服务端已保存配置不受影响。', icon: 'warning', showCancelButton: true, confirmButtonText: '放弃编辑并继续', cancelButtonText: '继续编辑' });
        return result.isConfirmed;
    }
    const api = {
        isDirty, anyDirty, confirmDiscard,
        isBusy: key => !!groups[key].busy,
        isLoaded: key => groups[key].saved !== undefined,
        accept(key) { groups[key].saved = snapshot(key); groups[key].error = false; render(key); },
        setBusy(key, busy) { groups[key].busy = busy; render(key); },
        loadFailed(key) { groups[key].error = true; render(key); },
        allowUnload: false
    };
    ['input', 'change'].forEach(event => document.addEventListener(event, e => {
        const key = Object.keys(groups).find(k => groups[k].fields.includes(e.target.id));
        if (key) render(key);
    }));
    window.addEventListener('beforeunload', e => {
        if (!api.allowUnload && anyDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    return api;
})();
