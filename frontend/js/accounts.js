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
function _getTableHeader() {
    if (!_tableHeaderCache) {
        _tableHeaderCache =
            '<tr><td colspan="7" class="p-1"><div class="flex gap-1 mb-1">' +
            '<button data-act="selectAllAccounts" class="text-xs bg-gray-100 px-2 py-0.5 rounded">全选</button>' +
            '<button data-act="deselectAllAccounts" class="text-xs bg-gray-100 px-2 py-0.5 rounded">取消</button>' +
            '<button data-act="batchDeleteAccounts" id="btn_batch_del" class="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded">批量删除</button>' +
            '<button data-act="verifyAllCredentials" class="text-xs bg-teal-100 text-teal-700 px-2 py-0.5 rounded font-bold" title="批量验证所有账号 API Key 是否有效">🔑 验证凭据</button>' +
            '<button data-act="exportAccounts" class="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded ml-auto">导出</button>' +
            '<button data-act="importAccounts" class="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded">导入</button>' +
            '<button data-act="backupAll" class="text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded">备份</button>' +
            '<button data-act="restoreBackup" class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">恢复</button>' +
            '<span id="batch_count" class="text-[10px] text-gray-400 ml-1"></span></div></td></tr>' +
            '<tr><td colspan="7" class="p-1"><div class="flex gap-1 items-center">' +
            '<input id="account_search" placeholder="🔍 搜索账号/别名/邮箱/域名..." class="flex-1 text-xs border rounded px-2 py-1">' +
            '<button data-act="clearSearch" class="text-xs text-gray-400 hover:text-red-500 px-1" title="清除搜索 (Esc)">✕</button>' +
            '<button data-act="doSearch" class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded" title="搜索 (Enter)">搜索</button>' +
            '<span id="search_count" class="text-[10px] text-gray-400"></span></div></td></tr>';
    }
    return _tableHeaderCache;
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
        chk.addEventListener('change', updateBatchToolbar);
        tdChk.appendChild(chk); tr.appendChild(tdChk);

        // 别名（密钥缺失时加提示）
        const tdAlias = document.createElement('td'); tdAlias.className = 'font-medium';
        tdAlias.textContent = a.alias;
        if (!a.globalKey) {
            const warn = document.createElement('span');
            warn.className = 'text-red-500 ml-1 cursor-help';
            warn.title = 'API Key 缺失或解密失败，请编辑账号重新填写';
            warn.textContent = '🔑';
            tdAlias.appendChild(warn);
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
            s.textContent = '⚠️ 0'; tdStats.appendChild(s);
        } else {
            tdStats.textContent = (a.stats && a.stats.total) || 0;
        }
        tr.appendChild(tdStats);

        // 占比条
        const tdBar = document.createElement('td');
        const barWrap = document.createElement('div'); barWrap.className = 'flex items-center gap-2';
        const barBg = document.createElement('div'); barBg.className = 'w-12 bg-gray-200 rounded-full h-1.5 overflow-hidden';
        const barFill = document.createElement('div');
        barFill.className = barColor + ' h-1.5';
        barFill.style.width = Math.min(percent, 100) + '%';
        barBg.appendChild(barFill); barWrap.appendChild(barBg);
        const barLabel = document.createElement('span'); barLabel.className = 'text-[10px]';
        barLabel.textContent = percent + '%'; barWrap.appendChild(barLabel);
        tdBar.appendChild(barWrap); tr.appendChild(tdBar);

        // 操作按钮
        const tdBtn = document.createElement('td'); tdBtn.className = 'text-right';
        const btnMgr = document.createElement('button');
        btnMgr.className = 'text-purple-600 mr-2 text-xs font-bold hover:bg-purple-50 px-1 rounded';
        btnMgr.textContent = '📂 管理';
        btnMgr.addEventListener('click', () => openAccountManage(originalIndex));
        tdBtn.appendChild(btnMgr);

        const btnEdit = document.createElement('button');
        btnEdit.className = 'text-blue-500 mr-2 text-xs'; btnEdit.textContent = '✎';
        btnEdit.title = '编辑';
        btnEdit.addEventListener('click', () => editAccount(originalIndex));
        tdBtn.appendChild(btnEdit);

        const btnDel = document.createElement('button');
        btnDel.className = 'text-red-500 text-xs'; btnDel.textContent = '×';
        btnDel.title = '删除';
        btnDel.addEventListener('click', () => delAccount(originalIndex));
        tdBtn.appendChild(btnDel);

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

async function saveAccount() {
    const alias = ($('in_alias').value || '').trim();
    const accountId = ($('in_id').value || '').trim();
    const email = ($('in_email').value || '').trim();
    const gkey = ($('in_gkey').value || '').trim();
    const dailyLimit = parseInt($('in_daily_limit').value, 10) || 0;

    // 必填校验（与后端保持一致，避免 400 后无提示）
    if (!alias) return Swal.fire('提示', '请填写备注 (Alias)', 'warning');
    if (!accountId) return Swal.fire('提示', '请填写 Account ID', 'warning');
    if (!ACCOUNT_ID_RE.test(accountId)) return Swal.fire('提示', 'Account ID 应为 32 位十六进制字符', 'warning');
    if (!email) return Swal.fire('提示', '请填写 Login Email', 'warning');
    // 新增账号必须提供 key；编辑时留空 = 不修改（后端保留旧密文）
    if (state.editingIndex < 0 && !gkey) return Swal.fire('提示', '新增账号必须填写 Global API Key', 'warning');

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

    const backup = JSON.parse(JSON.stringify(state.accounts));   // 失败可回滚
    if (state.editingIndex >= 0) {
        if (!o.globalKey) delete o.globalKey;
        state.accounts[state.editingIndex] = o;
    } else {
        state.accounts.push(o);
    }

    const btn = $('btn_save_acc');
    const origText = btn ? btn.innerText : '';
    if (btn) { btn.disabled = true; btn.innerText = '⏳ 保存中...'; }
    try {
        await apiFetch('/api/accounts', { method: 'POST', body: JSON.stringify(state.accounts) });
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
        if (btn) { btn.disabled = false; btn.innerText = origText; }
    }
}

function editAccount(i) {
    state.editingIndex = i;
    const a = state.accounts[i];
    if (!a) return;
    $('in_alias').value = a.alias;
    $('in_id').value = a.accountId;
    $('in_email').value = a.email || "";
    // 安全: 不回填脱敏 key，留空表示不修改（后端保留旧密文）
    $('in_gkey').value = "";
    $('in_gkey').placeholder = "留空=不修改";
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

async function delAccount(i) {
    const target = state.accounts[i];
    if (!target) return;
    const confirmed = await Swal.fire({
        title: '删除账号配置？',
        text: '将从中控移除「' + target.alias + '」（不影响 Cloudflare 上的 Worker）',
        icon: 'warning', showCancelButton: true, confirmButtonColor: '#d33', confirmButtonText: '确认删除'
    });
    if (!confirmed.isConfirmed) return;
    const backup = JSON.parse(JSON.stringify(state.accounts));
    state.accounts.splice(i, 1);
    try {
        await apiFetch('/api/accounts', { method: 'POST', body: JSON.stringify(state.accounts) });
        renderTable();
    } catch (e) {
        state.accounts = backup; renderTable();
        console.error('[delAccount]', e);
        Swal.fire('删除失败', e.message, 'error');
    }
}

function resetFormForAdd() {
    state.editingIndex = -1;
    document.querySelectorAll('#account_form input').forEach(i => i.value = '');
    $('in_gkey').placeholder = 'Global API Key';
    $('in_zone_select').innerHTML = '<option value="">(请先填写API信息后点击读取)</option>';
    const delBtn = $('btn_del_edit');
    if (delBtn) delBtn.classList.add('hidden');
    $('account_form').classList.remove('hidden');
}
function cancelEdit() {
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
    if (b) b.disabled = true;
    try {
        const d = await apiFetch('/api/stats');
        if (!Array.isArray(d)) throw new Error('返回格式异常');
        const errs = [];
        state.accounts.forEach(a => {
            const s = d.find(x => x.alias === a.alias);
            if (s) {
                a.stats = s;
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
                    errs.map(e => '<p class="text-red-600 mb-1">⚠️ ' + e + '</p>').join('') + '</div>',
                icon: 'warning', confirmButtonColor: '#4f46e5'
            });
        }
    } catch (e) {
        Swal.fire('用量查询失败', e.message, 'error');
    } finally {
        if (b) b.disabled = false;
    }
}

async function fetchZonesForAccount() {
    const email = $('in_email').value;
    const key = $('in_gkey').value;
    const id = ($('in_id').value || '').trim();
    const select = $('in_zone_select');

    // key 仅在校验时需要；编辑模式 key 留空=不修改，后端用 KV 中的服务端凭据读取，故允许
    if (!email || (!key && state.editingIndex < 0)) return Swal.fire('提示', '请先填写 Email, API Key', 'warning');
    if (!ACCOUNT_ID_RE.test(id)) return Swal.fire('提示', '请先填写合法的 Account ID（32 位十六进制）', 'warning');
    if (state.editingIndex < 0) {
        return Swal.fire('提示', '新账号请先「💾 保存账号」，之后再读取域名列表（读取使用服务端存储的凭据）', 'info');
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
        let html = '✅ ' + ok + ' / ❌ ' + fail + '<br><div class="text-left text-xs max-h-40 overflow-y-auto mt-2">';
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
    const result = await Swal.fire({ title: '批量删除', text: '确定删除 ' + selected.length + ' 个账号？', icon: 'warning', showCancelButton: true, confirmButtonColor: '#d33', confirmButtonText: '确认删除' });
    if (!result.isConfirmed) return;
    const backup = JSON.parse(JSON.stringify(state.accounts));   // 失败可回滚
    // 从后往前删，避免下标漂移
    selected.sort((a, b) => b - a).forEach(i => state.accounts.splice(i, 1));
    try {
        await apiFetch('/api/accounts', { method: 'POST', body: JSON.stringify(state.accounts) });
        renderTable();
        Swal.fire('已删除', selected.length + ' 个账号已删除', 'success');
    } catch (e) {
        state.accounts = backup; renderTable();
        console.error('[batchDeleteAccounts]', e);
        Swal.fire('批量删除失败', e.message, 'error');
    }
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
        applyAutoConfigToUi(c || {});
    } catch (e) { console.error('[loadGlobalConfig]', e); }
}

async function saveAutoConfig() {
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

    try {
        await apiFetch('/api/auto_config', { method: 'POST', body: JSON.stringify(payload) });
        Swal.fire({ icon: 'success', title: '已保存', timer: 1200, showConfirmButton: false });
    } catch (e) {
        console.error('[saveAutoConfig]', e);
        Swal.fire('保存失败', e.message, 'error');
    }
}

// @exports
window.safeHtml = safeHtml;
window.renderTable = renderTable;
window.loadAccounts = loadAccounts;
window.loadStats = loadStats;
window.loadGlobalConfig = loadGlobalConfig;
window.updateAutoToggleLabel = updateAutoToggleLabel;
window.editAccount = editAccount;
window.delAccount = delAccount;
window.updateBatchToolbar = updateBatchToolbar;

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
    verifyAllCredentials: verifyAllCredentials,
    selectAllAccounts: selectAllAccounts,
    deselectAllAccounts: deselectAllAccounts,
    batchDeleteAccounts: batchDeleteAccounts,
    updateAutoToggleLabel: updateAutoToggleLabel,
    saveAutoConfig: saveAutoConfig
});
