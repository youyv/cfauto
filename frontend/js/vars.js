// ===== 变量管理 =====

function renderProxySelector() {
    const c = $('ech_proxy_selector_container');
    if (!c) return;
    c.innerHTML = '';
    const sel = document.createElement('select');
    sel.id = 'ech_proxy_select';
    sel.className = 'w-full text-xs border rounded p-1 mb-1';
    sel.addEventListener('change', applyEchProxy);
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = '-- Select ProxyIP --';
    sel.appendChild(defOpt);
    ECH_PROXIES.forEach(function (g) {
        const grp = document.createElement('optgroup');
        grp.label = g.group;
        g.list.forEach(function (i) {
            const o = document.createElement('option');
            o.value = i.split(' ')[0];
            o.textContent = i;
            grp.appendChild(o);
        });
        sel.appendChild(grp);
    });
    c.appendChild(sel);
}
function applyEchProxy() {
    const el = $('ech_proxy_select');
    const v = el ? el.value : '';
    if (!v) return;
    // 已存在 PROXYIP 行则就地更新，避免重复添加同名变量
    const existing = Array.from(document.querySelectorAll('.var-row-ech'))
        .find(r => r.querySelector('.key') && r.querySelector('.key').value === 'PROXYIP');
    if (existing) existing.querySelector('.val').value = v;
    else addVarRow('ech', 'PROXYIP', v);
}

/** cmliu 特定变量的候选值池 */
const VAR_SUGGESTIONS = {
    DOH: ["https://dns.jhb.ovh/joeyblog", "https://doh.cmliussss.com/CMLiussss", "cloudflare-ech.com"]
};

// 使用 DOM API 构建变量行，避免 innerHTML 的 XSS 风险
function addVarRow(t, k, v, s) {
    const c = $('vars_' + t);
    if (!c) return;
    // 之前标记为删除的键重新添加时撤销删除标记
    if (k && state.deletedVars[t]) {
        const idx = state.deletedVars[t].indexOf(k);
        if (idx !== -1) state.deletedVars[t].splice(idx, 1);
    }
    const d = document.createElement('div');
    d.className = 'flex gap-1 items-center mb-1 var-row-' + t;

    const keyInput = document.createElement('input');
    keyInput.className = 'input-field w-1/4 key font-bold';
    keyInput.placeholder = 'Key';
    if (k) keyInput.value = k;
    d.appendChild(keyInput);

    const valInput = document.createElement('input');
    valInput.className = 'input-field w-2/4 val';
    valInput.placeholder = 'Val';
    // 留空 = 沿用上游默认值；真正要删除请点 × （与后端 mergeVariableBindings 语义一致）
    valInput.title = '留空表示不写入该绑定（沿用上游模板默认值）；要移除变量请点右侧 ×';
    if (v) valInput.value = v;
    d.appendChild(valInput);

    const secHidden = document.createElement('input');
    secHidden.type = 'hidden';
    secHidden.className = 'is-secret';
    d.appendChild(secHidden);

    const secLabel = document.createElement('label');
    secLabel.className = 'text-[9px] flex items-center gap-0.5';
    const secChk = document.createElement('input');
    secChk.type = 'checkbox';
    secChk.className = 'secret-chk';
    secChk.title = '标记为 Secret 变量';
    secChk.addEventListener('change', function () { secHidden.value = this.checked ? '1' : ''; });
    if (s) { secChk.checked = true; secHidden.value = '1'; }
    secLabel.appendChild(secChk);
    secLabel.appendChild(document.createTextNode('\uD83D\uDD12'));
    d.appendChild(secLabel);

    if (t === 'cmliu' && (k === 'PROXYIP' || k === 'DOH')) {
        const pool = k === 'DOH' ? VAR_SUGGESTIONS.DOH : ECH_PROXIES.flatMap(g => g.list);
        const sel = document.createElement('select');
        sel.className = 'w-4 border rounded text-[8px] bg-gray-50 cursor-pointer';
        sel.title = '从候选值中选择';
        sel.addEventListener('change', function () {
            if (this.value) valInput.value = this.value;
        });
        const defOpt = document.createElement('option');
        defOpt.text = '\u25BC';
        defOpt.value = '';
        sel.appendChild(defOpt);
        pool.forEach(function (u) {
            const o = document.createElement('option');
            o.value = u.split(' ')[0];
            o.textContent = u;
            sel.appendChild(o);
        });
        d.appendChild(sel);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'text-gray-300 hover:text-red-500 px-1 font-bold';
    delBtn.textContent = '\u00D7';
    delBtn.title = '删除该变量（部署时会从 Worker 移除）';
    delBtn.addEventListener('click', function () { removeVarRow(delBtn, t); });
    d.appendChild(delBtn);

    c.appendChild(d);
}
function removeVarRow(b, t) {
    const row = b.parentElement;
    const keyEl = row.querySelector('.key');
    const k = keyEl ? keyEl.value.trim() : '';
    if (k && state.deletedVars[t] && !state.deletedVars[t].includes(k)) state.deletedVars[t].push(k);
    row.remove();
}

/** 收集某模板当前 UI 上的变量（跳过空 key，去重保留最后一个） */
function collectVars(t) {
    const map = new Map();
    document.querySelectorAll('.var-row-' + t).forEach(r => {
        const k = (r.querySelector('.key').value || '').trim();
        if (!k) return;
        const v = r.querySelector('.val').value;
        const isSecret = r.querySelector('.is-secret').value === '1';
        map.set(k, isSecret ? { key: k, value: v, secret: true } : { key: k, value: v });
    });
    return Array.from(map.values());
}

async function loadVars(t) {
    const c = $('vars_' + t);
    if (!c) return;
    c.textContent = 'loading...';
    try {
        const v = await apiFetch('/api/settings?type=' + encodeURIComponent(t));
        const m = new Map();
        if (Array.isArray(v)) v.forEach(x => { if (x && x.key) m.set(x.key, x); });
        TEMPLATES[t].defaultVars.forEach(k => {
            if (!m.has(k)) m.set(k, { key: k, value: k === TEMPLATES[t].uuidField ? crypto.randomUUID() : '' });
        });
        c.innerHTML = '';
        state.deletedVars[t] = [];
        m.forEach((entry) => addVarRow(t, entry.key, entry.value, entry.secret));
    } catch (e) {
        console.error('[loadVars]', t, e);
        c.textContent = '加载失败: ' + e.message;
    }
}

function refreshUUID(t) {
    const k = TEMPLATES[t].uuidField;
    if (!k) return Swal.fire('提示', TEMPLATES[t].name + ' 没有 UUID 变量', 'info');
    let found = false;
    document.querySelectorAll('.var-row-' + t).forEach(r => {
        if (r.querySelector('.key').value === k) {
            const i = r.querySelector('.val');
            i.value = crypto.randomUUID();
            i.classList.add('bg-green-100');
            setTimeout(() => i.classList.remove('bg-green-100'), 500);
            found = true;
        }
    });
    if (!found) addVarRow(t, k, crypto.randomUUID());
}

// ===== 同步逻辑 =====
function selectSyncAccount(t) {
    const m = $('sync_select_modal');
    const l = $('sync_list');
    const v = state.accounts.filter(a => (a['workers_' + t] || []).length > 0);
    l.innerHTML = '';
    if (v.length === 0) {
        const tip = document.createElement('div');
        tip.className = 'text-xs text-orange-500 py-2';
        tip.textContent = '没有已部署 ' + TEMPLATES[t].name + ' 的账号';
        l.appendChild(tip);
    }
    v.forEach(a => {
        (a['workers_' + t] || []).forEach(wName => {
            const b = document.createElement('button');
            b.className = 'w-full text-left bg-slate-50 p-2 mb-1 text-xs border rounded hover:bg-blue-50';
            const strong = document.createElement('b'); strong.textContent = a.alias;
            b.appendChild(strong);
            b.appendChild(document.createTextNode(' -> ' + wName));
            b.addEventListener('click', () => doSync(a, t, wName));
            l.appendChild(b);
        });
    });
    m.classList.remove('hidden');
}

async function doSync(a, t, n) {
    closeModal('sync_select_modal');
    const confirmed = await Swal.fire({
        title: '确认覆盖当前变量配置?',
        text: '将用 ' + a.alias + ' -> ' + n + ' 上的绑定替换面板中的 ' + t + ' 变量',
        icon: 'warning', showCancelButton: true, confirmButtonText: '覆盖'
    });
    if (!confirmed.isConfirmed) return;
    try {
        const d = await apiFetch('/api/fetch_bindings', {
            method: 'POST',
            body: JSON.stringify({ accountId: a.accountId, workerName: n })
        });
        if (d.success) {
            const c = $('vars_' + t);
            c.innerHTML = '';
            state.deletedVars[t] = [];
            (d.data || []).forEach(v => addVarRow(t, v.key, v.value, v.secret));
            const secretCount = (d.data || []).filter(v => v.secret).length;
            Swal.fire('同步成功', '变量已更新' + (secretCount > 0 ? '（' + secretCount + ' 个 secret 的值 CF 不返回，需手动填写）' : ''), 'success');
        } else { Swal.fire('同步失败', d.msg || '未知错误', 'error'); }
    } catch (e) { Swal.fire('同步失败', e.message, 'error'); }
}

// ===== 版本检查 =====
async function previewDiff(t) {
    openWorkbench();
    wbLog('🔍 获取 ' + t + ' 版本差异...', 'text-blue-400');
    try {
        const d = await apiFetch('/api/diff?type=' + encodeURIComponent(t));
        if (d.status === 'up-to-date') {
            wbLog('✅ ' + d.message + ' (' + d.localSha + ')', 'text-green-400');
        } else if (d.status === 'no_data') {
            wbLog('⚠️  ' + d.message, 'text-yellow-400');
        } else {
            wbLog('📋 ' + t + ' 版本对比: ' + d.localSha + ' → ' + d.remoteSha + ' (落后 ' + d.behindBy + ' 个提交)', 'text-white');
            if (d.commits && d.commits.length > 0) {
                wbLog('─── 上游变更记录 ───', 'text-slate-500');
                d.commits.forEach(function (cm) {
                    wbLog(cm.sha + ' | ' + cm.author + ' | ' + cm.message, 'text-slate-400');
                });
            }
        }
        if (d.pending && d.pending.length > 0) {
            wbLog('⚠️ ' + d.pending.length + ' 个目标上一轮部署失败，仍在重试队列中', 'text-orange-400');
        }
    } catch (e) { wbLog('❌ 差异获取失败: ' + e.message, 'text-red-500'); }
}

async function checkUpdate(t) {
    const el = $('ver_' + t);
    if (!el) return;
    try {
        const d = await apiFetch('/api/check_update?type=' + encodeURIComponent(t));
        if (!d.success) throw new Error(d.msg || '版本检查失败');

        const fmt = (iso) => new Date(iso).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const remoteDate = fmt(d.remote.date);
        const localDateStr = (d.local && d.local.date) ? fmt(d.local.date) : '未部署';
        const isBehind = d.remote && (!d.local || d.remote.sha !== d.local.sha);

        el.textContent = '';

        // 上游行
        const upRow = document.createElement('div');
        upRow.className = 'flex justify-between items-center ' + (isBehind ? 'text-red-600 font-bold' : 'text-green-600');
        const upLeft = document.createElement('span');
        upLeft.textContent = (isBehind ? '🚀 上游: ' : '✅ 上游: ') + remoteDate;
        upRow.appendChild(upLeft);
        const upRight = document.createElement('span');
        if (isBehind) {
            upRight.className = 'animate-pulse';
            upRight.textContent = 'New!';
        } else {
            upRight.textContent = 'Latest';
        }
        upRow.appendChild(upRight);
        if (isBehind) {
            const diffBtn = document.createElement('button');
            diffBtn.className = 'text-blue-500 underline font-normal';
            diffBtn.textContent = '🔍差异';
            diffBtn.addEventListener('click', () => previewDiff(t));
            upRow.appendChild(diffBtn);
        }
        el.appendChild(upRow);

        // 本地行
        const localRow = document.createElement('div');
        const sameSha = d.local && d.remote && d.local.sha === d.remote.sha;
        localRow.className = 'flex justify-between ' + (sameSha ? 'text-gray-500' : 'text-orange-500 font-bold');
        const lLeft = document.createElement('span');
        lLeft.textContent = '💻 本地: ' + localDateStr;
        localRow.appendChild(lLeft);
        const lRight = document.createElement('span');
        lRight.textContent = d.mode === 'fixed' ? '🔒 Locked' : '';
        localRow.appendChild(lRight);
        el.appendChild(localRow);

        // 部分失败提示：版本号一致但仍有目标落后
        if (d.pending && d.pending.length > 0) {
            const pendRow = document.createElement('div');
            pendRow.className = 'text-orange-600 font-bold';
            pendRow.textContent = '⚠️ ' + d.pending.length + ' 个 Worker 部署失败，待重试';
            pendRow.title = d.pending.join('\n');
            el.appendChild(pendRow);
        }
    } catch (err) {
        let reason = (err && err.message) ? String(err.message) : 'Unknown';
        if (reason.length > 60) reason = reason.substring(0, 60) + '...';
        el.textContent = '';
        const ws = document.createElement('span');
        ws.className = 'text-red-400 text-[10px]';
        ws.textContent = '⚠️ ';
        el.appendChild(ws);
        el.appendChild(document.createTextNode(reason));
    }
}

async function checkDeployConfig(t) {
    const b = $('badge_' + t);
    try {
        const c = await apiFetch('/api/deploy_config?type=' + encodeURIComponent(t));
        state.deployConfigs[t] = c;
        if (!b) return;
        if (c.mode === 'fixed') {
            b.className = 'text-[9px] px-1.5 py-0.5 rounded text-white bg-orange-500 font-bold';
            b.innerText = 'Locked';
        } else {
            b.className = 'text-[9px] px-1.5 py-0.5 rounded text-white bg-green-500';
            b.innerText = 'Auto Update';
        }
    } catch (e) {
        console.error('[checkDeployConfig]', t, e);
        if (b) {
            b.className = 'text-[9px] px-1.5 py-0.5 rounded text-white bg-gray-400';
            b.innerText = 'Error';
        }
    }
}

// previewDiff 不注册为 action：它只挂在 checkUpdate 动态生成的「🔍差异」按钮上
// （addEventListener），HTML 里没有对应的 data-act。
registerActions({
    addVarRow: addVarRow,
    refreshUUID: refreshUUID,
    selectSyncAccount: selectSyncAccount
});
