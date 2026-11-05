// ===== 账号管理 =====

// HTML 转义辅助函数 — 防止 XSS
function safeHtml(s) { if (!s && s !== 0) return ""; const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }

function doSearch() {
    const input = $('account_search');
    const q = (input || {}).value || '';
    const rows = document.querySelectorAll('#account_body tr');
    let visible = 0, total = 0;
    rows.forEach(r => {
        // 只过滤数据行（有复选框的），工具栏和搜索行始终可见
        const isDataRow = !!r.querySelector('input[type=checkbox]');
        if (!isDataRow) return;
        total++;
        if (q === '') { r.style.display = ''; visible++; }
        else {
            const text = r.textContent.toLowerCase();
            const show = text.includes(q.toLowerCase());
            r.style.display = show ? '' : 'none';
            if (show) visible++;
        }
    });
    const countEl = $('search_count');
    if (countEl) countEl.textContent = q ? visible + '/' + total : '';
}
function clearSearch() {
    const input = $('account_search');
    if (input) { input.value = ''; input.focus(); doSearch(); }
}
document.addEventListener('keydown', function (e) {
    if (document.activeElement && document.activeElement.id === 'account_search') {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
        else if (e.key === 'Escape') { clearSearch(); }
    }
});

/** 表格工具栏 + 搜索行（data-act 事件委托，无内联 onclick） */
let _tableHeaderCache = '';
let accountToolsOpen = false;
// toggle does not bubble; capture preserves drawer state across table refreshes.
document.addEventListener('toggle', function (event) {
    if (event.target.matches && event.target.matches('.account-tools-drawer')) {
        if (event.target.isConnected) accountToolsOpen = event.target.open;
    }
}, true);
function _getTableHeader() {
    if (!_tableHeaderCache) {
        _tableHeaderCache =
            '<tr><td colspan="7" class="p-1"><details class="account-tools-drawer">' +
            '<summary class="account-tools-toggle"><span data-ui-icon="list">📝</span><span>账号工具</span><span class="account-tools-hint">批量 · 迁移 · 备份</span><span class="account-tools-chevron" data-ui-icon="chevron-down"><span data-ui-icon="chevron-down">▼</span></span></summary>' +
            '<div class="account-toolbar account-tools-content">' +
            '<section class="account-tool-group"><div class="account-tool-heading"><strong>批量操作</strong><span id="batch_count" class="account-tool-count"></span></div>' +
            '<p class="account-tool-description">管理账号选择，或验证全部账号凭据。</p>' +
            '<div class="account-tool-actions"><div class="account-selection-actions">' +
            '<button type="button" data-act="selectAllAccounts" class="account-tool-button">全选</button>' +
            '<button type="button" data-act="deselectAllAccounts" class="account-tool-button">取消选择</button></div>' +
            '<button type="button" data-act="verifyAllCredentials" class="account-tool-button" title="验证全部账号的 API Key 或 API Token"><span data-ui-icon="key-round">🔑</span> 验证凭据</button>' +
            '<button type="button" data-act="batchDeleteAccounts" id="btn_batch_del" class="account-tool-button account-tool-danger"><span data-ui-icon="trash-2">🗑️</span> 删除所选</button></div></section>' +
            '<div class="account-data-groups"><section class="account-tool-group"><div class="account-tool-heading"><strong>账号迁移</strong><span class="account-tool-tag">仅账号</span></div>' +
            '<p class="account-tool-description">导入时新增或合并账号，不恢复其他配置。</p>' +
            '<div class="account-tool-actions"><button type="button" data-act="exportAccounts" class="account-tool-button"><span data-ui-icon="upload">📤</span> 导出账号</button>' +
            '<button type="button" data-act="importAccounts" class="account-tool-button"><span data-ui-icon="download">📥</span> 导入账号</button></div></section>' +
            '<section class="account-tool-group"><div class="account-tool-heading"><strong>中控备份</strong><span class="account-tool-tag">完整配置</span></div>' +
            '<p class="account-tool-description">备份账号及中控配置；恢复会覆盖对应配置。</p>' +
            '<div class="account-tool-actions"><button type="button" data-act="backupAll" class="account-tool-button"><span data-ui-icon="save">💾</span> 下载备份</button>' +
            '<button type="button" data-act="restoreBackup" class="account-tool-button account-tool-caution" title="恢复前需确认，备份中的配置会覆盖现有对应项"><span data-ui-icon="download">📥</span> 恢复备份</button><button type="button" data-act="downloadRestoreSnapshot" class="account-tool-button" title="下载此标签页最近一次恢复尝试的维护快照（保留 7 天）">恢复前快照</button></div></section></div>' +
            '<p class="account-tools-note"><span data-ui-icon="lock">🔒</span> 账号凭据为加密数据，迁移时需使用相同的加密密钥。</p>' +
            '</div></details></td></tr>' +
            '<tr><td colspan="7" class="p-1"><div class="account-search-row flex gap-1 items-center">' +
            '<input aria-label="搜索账号" id="account_search" data-input-icon="search" placeholder="搜索账号/别名/邮箱/域名..." class="flex-1 text-xs border rounded px-2 py-1">' +
            '<button type="button" data-act="clearSearch" class="text-xs text-gray-400 hover:text-red-500 px-1" title="清除搜索 (Esc)"><span data-ui-icon="x">✕</span></button>' +
            '<button type="button" data-act="doSearch" class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded" title="搜索 (Enter)">搜索</button>' +
            '<span id="search_count" class="text-[10px] text-gray-400"></span></div></td></tr>';
    }
    return accountToolsOpen
        ? _tableHeaderCache.replace('class="account-tools-drawer"', 'class="account-tools-drawer" open')
        : _tableHeaderCache;
}

/** 计算用量占比（防御 stats 缺失 / max 为 0） */
function usagePercent(a) {
    const stats = a.stats || {};
    const total = stats.total || 0;
    const max = stats.max || 100000;
    if (max <= 0) return 0;
    return Math.round((total / max) * 1000) / 10;
}

function renderTable() {
    const tb = $('account_body');
    if (!tb) return;
    // 防御：accounts 必须是数组（后端异常时可能返回对象）
    if (!Array.isArray(state.accounts)) { console.error('[renderTable] accounts 不是数组:', state.accounts); state.accounts = []; }
    if (state.accounts.length === 0) {
        tb.innerHTML = _getTableHeader() + '<tr><td colspan="7" class="text-center text-gray-300 py-4">无数据</td></tr>';
        return;
    }
    const sortedAccounts = [...state.accounts].sort((a, b) => ((b.stats && b.stats.total) || 0) - ((a.stats && a.stats.total) || 0));
    const fragment = document.createDocumentFragment();
    const headerRow = document.createElement('tbody');
    headerRow.innerHTML = _getTableHeader();
    while (headerRow.firstChild) fragment.appendChild(headerRow.firstChild);

    sortedAccounts.forEach((a) => {
        // 用 accountId 反查原始下标：alias 虽已在后端强制唯一，accountId 更稳妥
        const originalIndex = state.accounts.findIndex(acc => acc.accountId === a.accountId);
        const count = Object.keys(TEMPLATES).reduce((s, t) => s + ((a['workers_' + t] || []).length), 0);
        const percent = usagePercent(a);
        let barColor = 'bg-green-500';
        if (percent > 80) barColor = 'bg-orange-500';
        if (percent >= 100) barColor = 'bg-red-600';

        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gray-50 border-b';

        // 复选框
        const tdChk = document.createElement('td'); tdChk.className = 'w-6';
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.className = 'acct-chk'; chk.value = originalIndex;
        chk.setAttribute('aria-label', '选择账号：' + a.alias);
        chk.addEventListener('change', updateBatchToolbar);
        tdChk.appendChild(chk); tr.appendChild(tdChk);

        // 别名（密钥缺失时加提示）
        const tdAlias = document.createElement('td'); tdAlias.className = 'font-medium';
        tdAlias.textContent = a.alias;
        if (!a.globalKey && !a.apiToken) {
            const warn = document.createElement('span');
            warn.className = 'text-red-500 ml-1 cursor-help';
            warn.title = '未配置凭据（Global API Key 或 API Token），或解密失败，请编辑账号重新填写';
            setUiContent(warn, 'triangle-alert', '');
            warn.setAttribute('role', 'img');
            warn.setAttribute('aria-label', warn.title);
            tdAlias.appendChild(warn);
        } else {
            // 标出该账号实际使用的凭据类型，便于排查「改了密码/令牌后失效」
            const mode = document.createElement('span');
            mode.className = 'text-gray-400 ml-1 text-[10px] cursor-help';
            mode.title = (a.apiToken && a.authMode !== 'key') ? '使用 API Token 认证' : '使用 Global API Key 认证';
            setUiContent(mode, (a.apiToken && a.authMode !== 'key') ? 'key-round' : 'shield-check', '');
            mode.setAttribute('role', 'img');
            mode.setAttribute('aria-label', mode.title);
            tdAlias.appendChild(mode);
        }
        tr.appendChild(tdAlias);

        // 域名
        const tdZone = document.createElement('td');
        const z = document.createElement('span');
        if (a.defaultZoneName) {
            z.className = 'bg-purple-100 text-purple-600 text-[10px] px-1 rounded';
            z.textContent = a.defaultZoneName;
        } else {
            z.className = 'text-gray-300'; z.textContent = '-';
        }
        tdZone.appendChild(z);
        tr.appendChild(tdZone);

        // Worker 数量
        const tdCount = document.createElement('td');
        const cnt = document.createElement('span');
        cnt.className = 'text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5';
        cnt.textContent = count + ' 个';
        tdCount.appendChild(cnt); tr.appendChild(tdCount);

        // 流量
        const tdStats = document.createElement('td');
        if (a.stats && a.stats.error) {
            const s = document.createElement('span');
            s.className = 'text-red-500 cursor-help'; s.title = a.stats.error;
            setUiContent(s, 'triangle-alert', ' 0'); tdStats.appendChild(s);
        } else {
            tdStats.textContent = (a.stats && a.stats.total) || 0;
        }
        tr.appendChild(tdStats);

        // 占比条
        const tdBar = document.createElement('td'); tdBar.className = 'account-ratio-cell';
        const barWrap = document.createElement('div'); barWrap.className = 'account-ratio-content';
        const barBg = document.createElement('div'); barBg.className = 'w-12 bg-gray-200 rounded-full h-1.5 overflow-hidden';
        const barFill = document.createElement('div');
        barFill.className = barColor + ' h-1.5';
        barFill.style.width = Math.min(percent, 100) + '%';
        barBg.appendChild(barFill); barWrap.appendChild(barBg);
        const barLabel = document.createElement('span'); barLabel.className = 'text-[10px]';
        barLabel.textContent = percent + '%'; barWrap.appendChild(barLabel);
        tdBar.appendChild(barWrap); tr.appendChild(tdBar);

        // 操作按钮
        const tdBtn = document.createElement('td'); tdBtn.className = 'account-actions-cell';
        const actions = document.createElement('div'); actions.className = 'account-actions-content';
        tdBtn.appendChild(actions);
        const btnMgr = document.createElement('button');
        btnMgr.type = 'button';
        btnMgr.className = 'text-purple-600 mr-2 text-xs font-bold hover:bg-purple-50 px-1 rounded';
        setUiContent(btnMgr, 'folder-open', ' 管理');
        btnMgr.addEventListener('click', () => openAccountManage(originalIndex));
        actions.appendChild(btnMgr);

        const btnEdit = document.createElement('button');

        btnEdit.type = 'button';
        btnEdit.className = 'text-blue-500 mr-2 text-xs'; setUiContent(btnEdit, 'pencil', '', { label: '编辑账号' });
        btnEdit.title = '编辑';
        btnEdit.addEventListener('click', () => editAccount(originalIndex));
        actions.appendChild(btnEdit);

        const btnDel = document.createElement('button');

        btnDel.type = 'button';
        btnDel.className = 'text-red-500 text-xs'; setUiContent(btnDel, 'x', '', { label: '删除账号' });
        btnDel.title = '删除';
        btnDel.addEventListener('click', () => delAccount(originalIndex));
        actions.appendChild(btnDel);

        tr.appendChild(tdBtn);
        fragment.appendChild(tr);
    });
    tb.innerHTML = '';
    tb.appendChild(fragment);
    updateBatchToolbar();
}

async function loadAccounts() {
    try {
        const d = await apiFetch('/api/accounts');
        acceptConfigView('accounts', d);
        if (!Array.isArray(d)) throw new Error('返回格式异常');
        state.accounts = d;
        state.accounts.forEach(a => a.stats = a.stats || { total: 0, max: a.dailyLimit || 100000 });
        renderTable();
    } catch (e) {
        console.error('[loadAccounts]', e);
        if (typeof Swal !== 'undefined') Swal.fire('账号列表加载失败', e.message, 'error');
    }
}

/** Account ID 格式：32 位十六进制（与后端 validateAccountsPayload 一致） */
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * 账号配置保存载荷：只保留权威配置允许的历史统计字段，剥离 /api/stats 返回的
 * `accountId` 等展示字段（原样回传会被判 400 INVALID）。保存与批量/单个删除都走这里。
 */
function accountSavePayload(accounts) {
    if (typeof frontendModules !== 'undefined' && frontendModules.accountSavePayload) return frontendModules.accountSavePayload(accounts);
    // build.js 总会打包 modules；此兜底只用于旧测试夹/无模块环境。
    return (accounts || []).map(({ stats, ...rest }) => rest);
}

async function saveAccount() {
    const alias = ($('in_alias').value || '').trim();
    const accountId = ($('in_id').value || '').trim();
    const email = ($('in_email').value || '').trim();
    const gkey = ($('in_gkey').value || '').trim();
    const apiToken = ($('in_api_token').value || '').trim();
    const useToken = currentAuthMode() === 'token';
    const dailyLimit = parseInt($('in_daily_limit').value, 10) || 0;

    // 必填校验（与后端保持一致，避免 400 后无提示）
    if (!alias) return Swal.fire('提示', '请填写备注 (Alias)', 'warning');
    if (!accountId) return Swal.fire('提示', '请填写 Account ID', 'warning');
    if (!ACCOUNT_ID_RE.test(accountId)) return Swal.fire('提示', 'Account ID 应为 32 位十六进制字符', 'warning');
    if (!useToken && !email) return Swal.fire('提示', '使用 Global API Key 时必须填写 Login Email', 'warning');
    // 所选鉴权方式必须有凭据：新增必填；编辑时留空表示沿用该账号已有的同类凭据
    const existingAcc = state.editingIndex >= 0 ? state.accounts[state.editingIndex] : undefined;
    if (useToken && !apiToken && !(existingAcc && existingAcc.apiToken)) {
        return Swal.fire('提示', '请填写 Cloudflare API Token', 'warning');
    }
    if (!useToken && !gkey && !(existingAcc && existingAcc.globalKey)) {
        return Swal.fire('提示', '请填写 Global API Key', 'warning');
    }

    // alias / accountId 唯一性前置校验：后端会拒，但本地先提示体验更好
    const conflict = state.accounts.find((a, i) => i !== state.editingIndex && (a.alias === alias || a.accountId === accountId));
    if (conflict) {
        return Swal.fire('提示', conflict.alias === alias
            ? '备注 (Alias) 已被账号「' + safeHtml(conflict.alias) + '」占用，请改为不同名称'
            : 'Account ID 已存在于账号「' + safeHtml(conflict.alias) + '」', 'warning');
    }

    const o = {
        alias, accountId, email,
        globalKey: gkey,
        apiToken: apiToken,
        authMode: useToken ? 'token' : 'key',
        defaultZoneName: $('in_zone_name').value,
        defaultZoneId: $('in_zone_id').value,
        dailyLimit,
        stats: (state.editingIndex >= 0 && state.accounts[state.editingIndex])
            ? (state.accounts[state.editingIndex].stats || { total: 0, max: dailyLimit || 100000 })
            : { total: 0, max: dailyLimit || 100000 }
    };
    Object.keys(TEMPLATES).forEach(t => {
        o['workers_' + t] = ($('in_workers_' + t).value || '').split(/,|，/).map(s => s.trim()).filter(s => s);
    });

    // 编辑时该侧留空 = 沿用已有凭据（后端保留旧密文）；authMode 会让后端清空另一侧
    if (state.editingIndex >= 0) {
        if (!gkey) delete o.globalKey;
        if (!apiToken) delete o.apiToken;
    }

    const backup = JSON.parse(JSON.stringify(state.accounts));   // 失败可回滚
    if (state.editingIndex >= 0) {
        state.accounts[state.editingIndex] = o;
    } else {
        state.accounts.push(o);
    }

    const btn = $('btn_save_acc');
    const restoreButton = beginButtonBusy(btn, ' 保存中...');
    try {
        await apiFetch('/api/accounts', { method: 'POST', body: JSON.stringify(accountSavePayload(state.accounts)) });
        // 保存成功后从服务端回读（拿到脱敏后的 key 与规范化数据）
        await loadAccounts();
        $('account_form').classList.add('hidden');
        state.editingIndex = -1;
    } catch (e) {
        state.accounts = backup;   // 回滚本地状态，避免 UI 与服务端不一致
        renderTable();
        console.error('[saveAccount]', e);
        Swal.fire('保存失败', e.message, 'error');
    } finally {
        restoreButton();
    }
}

function editAccount(i) {
    pinConfigView('accounts');
    state.editingIndex = i;
    const a = state.accounts[i];
    if (!a) return;
    $('in_alias').value = a.alias;
    $('in_id').value = a.accountId;
    $('in_email').value = a.email || "";
    // 安全: 不回填脱敏凭据，留空表示不修改（后端保留旧密文）
    $('in_gkey').value = "";
    $('in_gkey').placeholder = a.globalKey ? "留空=不修改" : "Global API Key";
    $('in_api_token').value = "";
    $('in_api_token').placeholder = a.apiToken ? "留空=不修改" : "Cloudflare API Token（需 Workers 与 KV 读写权限）";
    setAuthMode(a.authMode || (a.apiToken ? 'token' : 'key'));
    $('in_daily_limit').value = a.dailyLimit || "";
    $('in_zone_name').value = a.defaultZoneName || "";
    $('in_zone_id').value = a.defaultZoneId || "";

    const select = $('in_zone_select');
    select.innerHTML = '';
    if (a.defaultZoneName) {
        const opt = document.createElement('option');
        opt.value = a.defaultZoneId || '';
        opt.dataset.name = a.defaultZoneName;
        opt.textContent = a.defaultZoneName;
        opt.selected = true;
        select.appendChild(opt);
    } else {
        const opt = document.createElement('option');
        opt.value = ''; opt.textContent = '(请点击读取)';
        select.appendChild(opt);
    }

    Object.keys(TEMPLATES).forEach(t => $('in_workers_' + t).value = (a['workers_' + t] || []).join(','));
    const delBtn = $('btn_del_edit');
    if (delBtn) delBtn.classList.remove('hidden');
    $('account_form').classList.remove('hidden');
}

// Compare configuration, not transient usage statistics. This is a local UI guard, not KV concurrency control.
function accountRemovalSnapshot() {
    return JSON.stringify(state.accounts.map(({ stats, ...config }) => config));
}
let accountRemovalBusy = false;
async function confirmAccountRemoval(indices) {
    if (accountRemovalBusy) return;
    const selected = new Set(indices.filter(i => Number.isInteger(i) && i >= 0 && state.accounts[i]));
    if (!selected.size) return;
    const snapshot = accountRemovalSnapshot();
    const targets = [...selected].map(i => ({ alias: state.accounts[i].alias, accountId: state.accounts[i].accountId }));
    accountRemovalBusy = true;
    let changedDuringRequest = false;
    try {
        await Swal.fire({
            title: '移除账号配置？',
            html: '<p>将从中控移除以下 ' + targets.length + ' 个账号的配置与凭据，不删除 Cloudflare 账号、Worker 或 KV 命名空间。</p>' +
                '<ul class="text-left text-sm max-h-40 overflow-y-auto">' + targets.map(a => '<li>' + safeHtml(a.alias || '(未命名)') + ' — ' + safeHtml(a.accountId || '(无 ID)') + '</li>').join('') + '</ul>' +
                '<p>服务端会尝试清理被移除账号的账号级变量覆盖；失败由后续回收兜底，不代表所有关联配置均已清理。请先保存需要的备份。</p>',
            icon: 'warning', showCancelButton: true, confirmButtonColor: '#d33', confirmButtonText: '确认移除',
            input: 'text', inputLabel: '输入“移除”确认账号配置移除',
            inputAttributes: { autocomplete: 'off', spellcheck: 'false' }, focusConfirm: false,
            showLoaderOnConfirm: true, allowOutsideClick: () => !Swal.isLoading(), allowEscapeKey: () => !Swal.isLoading(),
            preConfirm: async value => {
                if (value !== '移除') { Swal.showValidationMessage('请精确输入“移除”'); return false; }
                if (accountRemovalSnapshot() !== snapshot) {
                    Swal.showValidationMessage('账号列表已变化，请取消后重新选择并确认'); return false;
                }
                const remaining = state.accounts.filter((_, i) => !selected.has(i));
                try {
                    await apiFetch('/api/accounts', { method: 'POST', body: JSON.stringify(accountSavePayload(remaining)) });
                } catch (e) {
                    Swal.showValidationMessage(safeHtml(e.message || '移除失败，请核对服务器状态后重试')); return false;
                }
                // Never roll back or overwrite a newer local edit while this request was in flight.
                if (accountRemovalSnapshot() === snapshot) {
                    state.accounts = state.accounts.filter((_, i) => !selected.has(i));
                    renderTable();
                } else {
                    changedDuringRequest = true;
                }
                return true;
            }
        });
        if (changedDuringRequest) await Swal.fire({ icon: 'warning', title: '移除请求已完成', text: '请求期间本地账号列表已变化，未覆盖当前列表。请重新加载并核对服务器状态后再操作。' });
    } finally { accountRemovalBusy = false; }
}
async function delAccount(i) { await confirmAccountRemoval([i]); }

function resetFormForAdd() {
    pinConfigView('accounts');
    state.editingIndex = -1;
    // 排除 radio：给 radio 赋空字符串会把 value 清掉，鉴权方式就再也读不出来了
    document.querySelectorAll('#account_form input:not([type="radio"])').forEach(i => i.value = '');
    $('in_gkey').placeholder = 'Global API Key';
    $('in_api_token').placeholder = 'Cloudflare API Token（需 Workers 与 KV 读写权限）';
    setAuthMode('token');
    $('in_zone_select').innerHTML = '<option value="">(请先填写API信息后点击读取)</option>';
    const delBtn = $('btn_del_edit');
    if (delBtn) delBtn.classList.add('hidden');
    $('account_form').classList.remove('hidden');
}

/** 当前表单选择的鉴权方式 */
function currentAuthMode() {
    const el = document.querySelector('input[name="auth_mode"]:checked');
    return el ? el.value : 'token';
}

/** 切换鉴权方式对应的输入区显隐（由 data-act-change 触发） */
function toggleAuthFields() {
    const isToken = currentAuthMode() === 'token';
    const t = $('field_auth_token');
    const k = $('field_auth_key');
    if (t) t.classList.toggle('hidden', !isToken);
    if (k) k.classList.toggle('hidden', isToken);
}

/** 以编程方式设置鉴权方式（单选按钮 + 字段显隐） */
function setAuthMode(mode) {
    const el = document.querySelector('input[name="auth_mode"][value="' + (mode === 'key' ? 'key' : 'token') + '"]');
    if (el) el.checked = true;
    toggleAuthFields();
}
function cancelEdit() {
    releaseConfigView('accounts');
    $('account_form').classList.add('hidden');
    state.editingIndex = -1;
}
async function deleteFromEdit() {
    const i = state.editingIndex;
    cancelEdit();
    if (i >= 0) await delAccount(i);
}

async function loadStats() {
    const b = $('btn_stats');
    if (!b) return;
    const restoreButton = beginButtonBusy(b, ' 刷新中...');
    try {
        const d = await apiFetch('/api/stats');
        if (!Array.isArray(d)) throw new Error('返回格式异常');
        const errs = [];
        state.accounts.forEach(a => {
            const s = d.find(x => x.alias === a.alias);
            if (s) {
                // 只保留展示所需字段：/api/stats 的 accountId 等不是账号配置数据。
                a.stats = { total: s.total, max: s.max, ...(s.error ? { error: s.error } : {}) };
                if (s.error) errs.push(safeHtml(a.alias) + ': ' + safeHtml(s.error));
            } else {
                a.stats = { total: 0, max: a.dailyLimit || 100000, error: '未匹配到账号' };
                errs.push(safeHtml(a.alias) + ': 未匹配到账号');
            }
        });
        renderTable();
        if (errs.length) {
            Swal.fire({
                title: '用量查询异常',
                html: '<div class="text-left text-xs max-h-60 overflow-y-auto">' +
                    errs.map(e => '<p class="text-red-600 mb-1"><span data-ui-icon="triangle-alert">⚠️</span> ' + e + '</p>').join('') + '</div>',
                icon: 'warning', confirmButtonColor: '#4f46e5'
            });
        }
    } catch (e) {
        Swal.fire('用量查询失败', e.message, 'error');
    } finally {
        restoreButton();
    }
}

async function fetchZonesForAccount() {
    const id = ($('in_id').value || '').trim();
    const select = $('in_zone_select');

    // 读取使用服务端 KV 中存储的凭据，表单里的 email/token/key 均不参与，故只校验 Account ID
    if (!ACCOUNT_ID_RE.test(id)) return Swal.fire('提示', '请先填写合法的 Account ID（32 位十六进制）', 'warning');
    if (state.editingIndex < 0) {
        return Swal.fire('提示', '新账号请先「保存账号」，之后再读取域名列表（读取使用服务端存储的凭据）', 'info');
    }

    select.innerHTML = '<option>Loading...</option>';
    try {
        const d = await apiFetch('/api/zones', { method: 'POST', body: JSON.stringify({ accountId: id }) });
        if (d.success) {
            select.innerHTML = '';
            const first = document.createElement('option');
            first.value = ''; first.textContent = '-- 请选择预设域名 --';
            select.appendChild(first);
            (d.zones || []).forEach(z => {
                const opt = document.createElement('option');
                opt.value = z.id; opt.dataset.name = z.name; opt.textContent = z.name;
                select.appendChild(opt);
            });
            if (!d.zones || d.zones.length === 0) {
                const none = document.createElement('option');
                none.value = ''; none.textContent = '(该账号下没有域名)';
                select.appendChild(none);
            }
        } else {
            select.innerHTML = '<option>读取失败</option>';
            Swal.fire('错误', d.msg || '读取失败', 'error');
        }
    } catch (e) {
        console.error('[fetchZones]', e);
        select.innerHTML = '<option>读取失败</option>';
        Swal.fire('读取域名失败', e.message, 'error');
    }
}

function updateZoneInfo() {
    const sel = $('in_zone_select');
    if (sel.selectedIndex > 0) {
        $('in_zone_id').value = sel.value;
        $('in_zone_name').value = sel.options[sel.selectedIndex].dataset.name || '';
    } else {
        $('in_zone_id').value = '';
        $('in_zone_name').value = '';
    }
}

async function verifyAllCredentials() {
    Swal.fire({ title: '验证中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const results = await apiFetch('/api/verify_credentials');
        if (!Array.isArray(results)) throw new Error('返回格式异常');
        const ok = results.filter((x) => x.ok).length;
        const fail = results.filter((x) => !x.ok).length;
        let html = '<span data-ui-icon="circle-check">✅</span> ' + ok + ' / <span data-ui-icon="x">❌</span> ' + fail + '<br><div class="text-left text-xs max-h-40 overflow-y-auto mt-2">';
        results.forEach((x) => {
            if (!x.ok) html += '<p class="text-red-500">' + safeHtml(x.alias) + ': ' + safeHtml(x.error || ('HTTP ' + x.status)) + '</p>';
        });
        html += '</div>';
        Swal.fire({ title: '凭据验证结果', html, icon: fail > 0 ? 'warning' : 'success' });
    } catch (e) { Swal.fire('验证失败', e.message, 'error'); }
}

// ===== 批量选择 =====
function selectAllAccounts() { document.querySelectorAll('.acct-chk').forEach(c => c.checked = true); updateBatchToolbar(); }
function deselectAllAccounts() { document.querySelectorAll('.acct-chk').forEach(c => c.checked = false); updateBatchToolbar(); }
function updateBatchToolbar() {
    const selected = document.querySelectorAll('.acct-chk:checked').length;
    const total = document.querySelectorAll('.acct-chk').length;
    const countEl = $('batch_count');
    const delBtn = $('btn_batch_del');
    if (countEl) countEl.textContent = selected > 0 ? '已选 ' + selected + '/' + total : '';
    if (delBtn) {
        delBtn.disabled = selected === 0;
        delBtn.classList.toggle('opacity-40', selected === 0);
    }
}
async function batchDeleteAccounts() {
    const selected = Array.from(document.querySelectorAll('.acct-chk:checked')).map(c => parseInt(c.value, 10)).filter(n => Number.isInteger(n) && n >= 0);
    if (selected.length === 0) return Swal.fire('提示', '请先选择账号', 'info');
    await confirmAccountRemoval(selected);
}

// ===== 自动更新配置 =====
function updateAutoToggleLabel() {
    const el = $('auto_toggle_label');
    const master = $('auto_update_toggle');
    if (!el || !master) return;
    const on = master.checked;
    el.textContent = on ? '开' : '关';
    el.className = on ? 'text-[10px] font-bold text-green-600' : 'text-[10px] font-bold text-gray-400';
    // 主开关联动每模板开关（模板列表来自服务端注入的 TEMPLATES，不再硬编码三项）
    Object.keys(TEMPLATES).forEach(t => {
        const sub = $('auto_' + t + '_toggle');
        if (sub) sub.checked = on;
    });
}

async function loadGlobalConfig() {
    try {
        const c = await apiFetch('/api/auto_config');
        acceptConfigView('autoConfig', c);
        applyAutoConfigToUi(c || {});
    } catch (e) { configDrafts.loadFailed('auto'); console.error('[loadGlobalConfig]', e); }
}

async function saveAutoConfig() {
    if (!configDrafts.isLoaded('auto') || configDrafts.isBusy('auto')) return;
    const interval = parseInt($('auto_update_interval').value, 10);
    const fuse = parseInt($('fuse_threshold').value, 10) || 0;
    const webhook = ($('fuse_webhook').value || '').trim();

    if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
        return Swal.fire('提示', '检查间隔必须是 1-1440 之间的分钟数', 'warning');
    }
    if (fuse < 0 || fuse > 100) {
        return Swal.fire('提示', '熔断阈值必须是 0-100 的百分比（0 = 关闭）', 'warning');
    }
    if (webhook && !/^https:\/\//i.test(webhook)) {
        return Swal.fire('提示', '熔断 Webhook 必须以 https:// 开头', 'warning');
    }

    const payload = {
        enabled: $('auto_update_toggle').checked,
        interval, fuseThreshold: fuse, fuseWebhook: webhook
    };
    Object.keys(TEMPLATES).forEach(t => {
        const el = $('auto_' + t + '_toggle');
        payload['auto' + t.charAt(0).toUpperCase() + t.slice(1)] = el ? el.checked : true;
    });

    configDrafts.setBusy('auto', true);
    try {
        const saved = await apiFetch('/api/auto_config', { method: 'POST', body: JSON.stringify(payload) });
        // 使用写入响应，而不是马上重读最终一致的 KV。兼容旧服务端的 success-only 响应。
        applyAutoConfigToUi(saved.config || payload);
        Swal.fire({ icon: 'success', title: '已保存', timer: 1200, showConfirmButton: false });
    } catch (e) {
        console.error('[saveAutoConfig]', e);
        Swal.fire('保存失败', e.message, 'error');
    } finally { configDrafts.setBusy('auto', false); }
}

registerActions({
    doSearch: doSearch,
    clearSearch: clearSearch,
    loadStats: loadStats,
    resetFormForAdd: resetFormForAdd,
    cancelEdit: cancelEdit,
    saveAccount: saveAccount,
    deleteFromEdit: deleteFromEdit,
    fetchZonesForAccount: fetchZonesForAccount,
    updateZoneInfo: updateZoneInfo,
    toggleAuthFields: toggleAuthFields,
    switchProjectTab: switchProjectTab,
    verifyAllCredentials: verifyAllCredentials,
    selectAllAccounts: selectAllAccounts,
    deselectAllAccounts: deselectAllAccounts,
    batchDeleteAccounts: batchDeleteAccounts,
    updateAutoToggleLabel: updateAutoToggleLabel,
    saveAutoConfig: saveAutoConfig
});
