// ===== 账号管理 =====

// HTML 转义辅助函数 — 防止 XSS
function safeHtml(s) { if(!s && s!==0) return ""; const d=document.createElement("div"); d.textContent=String(s); return d.innerHTML; }
function safeJsStr(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"'); }


function doSearch() {
    const input = document.getElementById('account_search');
    const q = (input||{}).value||'';
    const rows = document.querySelectorAll('#account_body tr');
    let visible = 0, total = 0;
    rows.forEach(r => {
        // 只过滤数据行（有复选框的），工具栏和搜索行始终可见
        const isDataRow = !!r.querySelector('input[type=checkbox]');
        if (!isDataRow) return; // 跳过工具栏和搜索行
        total++;
        if (q === '') { r.style.display = ''; visible++; }
        else {
            const text = r.textContent.toLowerCase();
            const show = text.includes(q.toLowerCase());
            r.style.display = show ? '' : 'none';
            if (show) visible++;
        }
    });
    const countEl = document.getElementById('search_count');
    if (countEl) countEl.textContent = q ? visible + '/' + total : '';
}
function clearSearch() {
    const input = document.getElementById('account_search');
    if (input) { input.value = ''; input.focus(); doSearch(); }
}
document.addEventListener('keydown', function(e) {
    if (document.activeElement && document.activeElement.id === 'account_search') {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
        else if (e.key === 'Escape') { clearSearch(); }
    }
});

// 表格工具栏 + 搜索行缓存（避免重复构建）
let _tableHeaderCache = '';
function _getTableHeader() {
    if (!_tableHeaderCache) {
        _tableHeaderCache = '<tr><td colspan="7" class="p-1"><div class="flex gap-1 mb-1"><button onclick="selectAllAccounts()" class="text-xs bg-gray-100 px-2 py-0.5 rounded">全选</button><button onclick="deselectAllAccounts()" class="text-xs bg-gray-100 px-2 py-0.5 rounded">取消</button><button onclick="batchDeleteAccounts()" class="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded">批量删除</button><button onclick="verifyAllCredentials()" class="text-xs bg-teal-100 text-teal-700 px-2 py-0.5 rounded font-bold" title="批量验证所有账号 API Key 是否有效">🔑 验证凭据</button><button onclick="exportAccounts()" class="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded ml-auto">导出</button><button onclick="importAccounts()" class="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded">导入</button><button onclick="backupAll()" class="text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded">备份</button><button onclick="restoreBackup()" class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">恢复</button><span id="batch_count" class="text-[10px] text-gray-400 ml-1"></span></div></td></tr>' +
        '<tr><td colspan="7" class="p-1"><div class="flex gap-1 items-center"><input id="account_search" placeholder="🔍 搜索账号/别名/邮箱/域名..." class="flex-1 text-xs border rounded px-2 py-1"><button id="search_clear" onclick="clearSearch()" class="text-xs text-gray-400 hover:text-red-500 px-1" title="清除搜索 (Esc)">✕</button><button onclick="doSearch()" class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded" title="搜索 (Enter)">搜索</button><span id="search_count" class="text-[10px] text-gray-400"></span></div></td></tr>';
    }
    return _tableHeaderCache;
}

function renderTable() {
    const tb = document.getElementById('account_body');
    if (!tb) return;
    // 防御：accounts 必须是数组（后端异常时可能返回对象）
    if (!Array.isArray(accounts)) { console.error('[renderTable] accounts 不是数组:', accounts); accounts = []; }
    if (accounts.length === 0) {
        tb.innerHTML = _getTableHeader() + '<tr><td colspan="7" class="text-center text-gray-300 py-4">无数据</td></tr>';
        return;
    }
    const sortedAccounts = [...accounts].sort((a, b) => ((b.stats && b.stats.total) || 0) - ((a.stats && a.stats.total) || 0));
    // 头部工具栏 + 搜索行保留 innerHTML（无动态变量）
    const headerHTML = _getTableHeader();
    // 数据行用 DOM API 构建，避免 innerHTML 中的 onclick 依赖全局作用域
    const fragment = document.createDocumentFragment();
    const headerRow = document.createElement('tbody');
    headerRow.innerHTML = headerHTML;
    while (headerRow.firstChild) fragment.appendChild(headerRow.firstChild);
    sortedAccounts.forEach((a) => {
        const originalIndex = accounts.findIndex(acc => acc.alias === a.alias);
        const count = Object.keys(TEMPLATES).reduce((s,t) => s + (a['workers_'+t]||[]).length, 0);
        const percent = ((a.stats.total / a.stats.max) * 100).toFixed(1);
        let barColor = 'bg-green-500'; if (percent > 80) barColor = 'bg-orange-500'; if (percent >= 100) barColor = 'bg-red-600';

        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gray-50 border-b';

        // 复选框
        const tdChk = document.createElement('td'); tdChk.className = 'w-6';
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.className = 'acct-chk'; chk.value = originalIndex;
        chk.addEventListener('change', updateBatchToolbar);
        tdChk.appendChild(chk); tr.appendChild(tdChk);

        // 别名
        const tdAlias = document.createElement('td'); tdAlias.className = 'font-medium';
        tdAlias.textContent = a.alias; tr.appendChild(tdAlias);

        // 域名
        const tdZone = document.createElement('td');
        if (a.defaultZoneName) {
            const z = document.createElement('span');
            z.className = 'bg-purple-100 text-purple-600 text-[10px] px-1 rounded';
            z.textContent = a.defaultZoneName;
            tdZone.appendChild(z);
        } else {
            const z = document.createElement('span');
            z.className = 'text-gray-300'; z.textContent = '-';
            tdZone.appendChild(z);
        }
        tr.appendChild(tdZone);

        // Worker 数量
        const tdCount = document.createElement('td');
        const cnt = document.createElement('span');
        cnt.className = 'text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5';
        cnt.textContent = count + ' 个';
        tdCount.appendChild(cnt); tr.appendChild(tdCount);

        // 流量
        const tdStats = document.createElement('td');
        if (a.stats.error) {
            const s = document.createElement('span');
            s.className = 'text-red-500 cursor-help'; s.title = a.stats.error || '';
            s.textContent = '⚠️ 0'; tdStats.appendChild(s);
        } else {
            tdStats.textContent = a.stats.total;
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
        btnEdit.addEventListener('click', () => editAccount(originalIndex));
        tdBtn.appendChild(btnEdit);

        const btnDel = document.createElement('button');
        btnDel.className = 'text-red-500 text-xs'; btnDel.textContent = '×';
        btnDel.addEventListener('click', () => delAccount(originalIndex));
        tdBtn.appendChild(btnDel);

        tr.appendChild(tdBtn);
        fragment.appendChild(tr);
    });
    tb.innerHTML = '';
    tb.appendChild(fragment);
    // 清除动态元素缓存（innerHTML 重建后旧 DOM 引用失效）
    $clear('account_search');
    $clear('search_clear');
    $clear('search_count');
}

async function loadAccounts() {
    try {
        const r = await fetch('/api/accounts');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        if (!Array.isArray(d)) throw new Error((d && d.msg) || '返回格式异常');
        accounts = d;
        accounts.forEach(a => a.stats = a.stats || { total: 0, max: a.dailyLimit || 100000 });
        renderTable();
    } catch(e) {
        console.error('[loadAccounts]', e);
        if (typeof Swal !== 'undefined') Swal.fire('账号列表加载失败', e.message, 'error');
    }
}

async function saveAccount() {
    const alias = ($('in_alias').value || '').trim();
    const accountId = ($('in_id').value || '').trim();
    const email = ($('in_email').value || '').trim();
    const gkey = ($('in_gkey').value || '').trim();
    const dailyLimit = parseInt($('in_daily_limit').value, 10) || 0;

    // 必填校验（与后端 POST /api/accounts 校验保持一致，避免 400 后无提示）
    if (!alias) return Swal.fire('提示', '请填写备注 (Alias)', 'warning');
    if (!accountId) return Swal.fire('提示', '请填写 Account ID', 'warning');
    if (!email) return Swal.fire('提示', '请填写 Login Email', 'warning');
    // 新增账号必须提供 key；编辑时留空 = 不修改（后端保留旧密文）
    if (editingIndex < 0 && !gkey) return Swal.fire('提示', '新增账号必须填写 Global API Key', 'warning');

    const o = {
        alias, accountId, email,
        globalKey: gkey,
        defaultZoneName: $('in_zone_name').value,
        defaultZoneId: $('in_zone_id').value,
        dailyLimit,
        stats: (editingIndex >= 0 && accounts[editingIndex])
            ? (accounts[editingIndex].stats || { total: 0, max: dailyLimit || 100000 })
            : { total: 0, max: dailyLimit || 100000 }
    };
    Object.keys(TEMPLATES).forEach(t => o['workers_' + t] = $('in_workers_' + t).value.split(/,|，/).map(s => s.trim()).filter(s => s));

    const backup = JSON.parse(JSON.stringify(accounts));   // 失败可回滚
    if (editingIndex >= 0) { if (!o.globalKey) delete o.globalKey; accounts[editingIndex] = o; } else accounts.push(o);

    const btn = $('btn_save_acc');
    const origText = btn ? btn.innerText : '';
    if (btn) { btn.disabled = true; btn.innerText = '⏳ 保存中...'; }
    try {
        const r = await fetch('/api/accounts', { method: 'POST', body: JSON.stringify(accounts) });
        if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const d = await r.json(); if (d && d.msg) msg = d.msg; } catch (pe) { console.warn('[saveAccount] 错误响应非 JSON', pe); }
            throw new Error(msg);
        }
        renderTable();
        $('account_form').classList.add('hidden');
    } catch (e) {
        accounts = backup;   // 回滚本地状态，避免 UI 与服务端不一致
        renderTable();
        console.error('[saveAccount]', e);
        Swal.fire('保存失败', e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = origText; }
    }
}

function editAccount(i){
    editingIndex=i; const a=accounts[i];
    $('in_alias').value=a.alias;
    $('in_id').value=a.accountId;
    $('in_email').value=a.email||"";
    // 安全: 不回填脱敏 key，留空表示不修改（后端保留旧密文）
    $('in_gkey').value="";
    $('in_gkey').placeholder="留空=不修改";
    $('in_daily_limit').value=a.dailyLimit||"";
    $('in_zone_name').value=a.defaultZoneName||"";
    $('in_zone_id').value=a.defaultZoneId||"";

    const select = $('in_zone_select');
    if(a.defaultZoneName) { select.innerHTML = `<option value="${safeHtml(a.defaultZoneId)}" data-name="${safeHtml(a.defaultZoneName)}" selected>${safeHtml(a.defaultZoneName)}</option>`; } else { select.innerHTML = '<option value="">(请点击读取)</option>'; }

    Object.keys(TEMPLATES).forEach(t=>$('in_workers_'+t).value=(a['workers_'+t]||[]).join(','));
    $('account_form').classList.remove('hidden');
}

async function delAccount(i){
    if(!confirm('删除账号配置？')) return;
    const backup = JSON.parse(JSON.stringify(accounts));
    accounts.splice(i,1);
    try {
        const r = await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)});
        if(!r.ok) throw new Error('HTTP ' + r.status);
        renderTable();
    } catch(e) {
        accounts = backup; renderTable();
        console.error('[delAccount]', e);
        Swal.fire('删除失败', e.message, 'error');
    }
}
function resetFormForAdd(){ editingIndex=-1; $clearAll(); document.querySelectorAll('#account_form input').forEach(i=>i.value=''); $('in_gkey').placeholder='Global API Key'; $('in_zone_select').innerHTML='<option value="">(请先填写API信息后点击读取)</option>'; $('account_form').classList.remove('hidden'); }
function cancelEdit(){ $('account_form').classList.add('hidden'); }
async function deleteFromEdit(){ if(editingIndex>=0)delAccount(editingIndex); cancelEdit(); }

async function loadStats(){ const b=document.getElementById('btn_stats'); b.disabled=true; try{ const r=await fetch('/api/stats'); if(!r.ok)throw new Error(`HTTP ${r.status}`); const d=await r.json(); if(!Array.isArray(d))throw new Error((d&&d.msg)||'返回格式异常'); const errs=[]; accounts.forEach(a=>{ const s=d.find(x=>x.alias===a.alias); if(s){ a.stats=s; if(s.error)errs.push(`${safeHtml(a.alias)}: ${safeHtml(s.error)}`); } else { a.stats={total:0,max:a.dailyLimit||100000,error:'未匹配到账号'}; errs.push(`${safeHtml(a.alias)}: 未匹配到账号`); } }); renderTable(); if(errs.length)Swal.fire({title:'用量查询异常',html:`<div class="text-left text-xs max-h-60 overflow-y-auto">${errs.map(e=>`<p class="text-red-600 mb-1">⚠️ ${e}</p>`).join('')}</div>`,icon:'warning',confirmButtonColor:'#4f46e5'}); }catch(e){ Swal.fire('用量查询失败',e.message,'error'); } b.disabled=false; }

async function fetchZonesForAccount() {
    const email = document.getElementById('in_email').value;
    const key = document.getElementById('in_gkey').value;
    const id = document.getElementById('in_id').value;
    const select = document.getElementById('in_zone_select');

    // key 仅在校验时需要；编辑模式 key 留空=不修改，后端用 KV 中的服务端凭据读取，故允许
    if (!email || (!key && editingIndex < 0)) return Swal.fire('提示', '请先填写 Email, API Key', 'warning');

    select.innerHTML = '<option>Loading...</option>';
    try {
        const res = await fetch('/api/zones', {
            method: 'POST',
            body: JSON.stringify({ accountId: id })
        });
        const d = await res.json();
        if (d.success) {
            select.innerHTML = '<option value="">-- 请选择预设域名 --</option>' +
                d.zones.map(z => `<option value="${safeHtml(z.id)}" data-name="${safeHtml(z.name)}">${safeHtml(z.name)}</option>`).join('');
        } else {
            select.innerHTML = '<option>读取失败</option>';
            Swal.fire('错误', d.msg, 'error');
        }
    } catch(e) { console.error('[fetchZones]', e); select.innerHTML = '<option>网络错误</option>'; }
}

function updateZoneInfo() {
    const sel = document.getElementById('in_zone_select');
    if(sel.selectedIndex > 0) {
        document.getElementById('in_zone_id').value = sel.value;
        document.getElementById('in_zone_name').value = sel.options[sel.selectedIndex].dataset.name;
    }
}


async function verifyAllCredentials() {
    Swal.fire({ title: '验证中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
        const r = await fetch('/api/verify_credentials');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const results = await r.json();
        if (!Array.isArray(results)) throw new Error((results && results.msg) || '返回格式异常');
        const ok = results.filter((x) => x.ok).length;
        const fail = results.filter((x) => !x.ok).length;
        let html = '✅ ' + ok + ' / ❌ ' + fail + '<br><div class="text-left text-xs max-h-40 overflow-y-auto mt-2">';
        results.forEach((x) => { if (!x.ok) html += '<p class="text-red-500">' + safeHtml(x.alias) + ': ' + safeHtml(x.error || ('HTTP ' + x.status)) + '</p>'; });
        html += '</div>';
        Swal.fire({ title: '凭据验证结果', html, icon: fail > 0 ? 'warning' : 'success' });
    } catch(e) { Swal.fire('验证失败', e.message, 'error'); }
}


// ===== 账号管理弹窗 =====

function selectAllAccounts() { document.querySelectorAll('.acct-chk').forEach(c => c.checked = true); updateBatchToolbar(); }
function deselectAllAccounts() { document.querySelectorAll('.acct-chk').forEach(c => c.checked = false); updateBatchToolbar(); }
function updateBatchToolbar() {
    const selected = document.querySelectorAll('.acct-chk:checked').length;
    const total = document.querySelectorAll('.acct-chk').length;
    const countEl = document.getElementById('batch_count');
    const delBtn = document.querySelector('#account_list_container button[onclick*="batchDeleteAccounts"]');
    if (countEl) countEl.textContent = selected > 0 ? '已选 ' + selected + '/' + total : '';
    if (delBtn) {
      if (selected === 0) { delBtn.disabled = true; delBtn.classList.add('opacity-40'); }
      else { delBtn.disabled = false; delBtn.classList.remove('opacity-40'); }
    }
  }
async function batchDeleteAccounts() {
    const selected = Array.from(document.querySelectorAll('.acct-chk:checked')).map(c => parseInt(c.value));
    if (selected.length === 0) return Swal.fire('提示', '请先选择账号', 'info');
    const result = await Swal.fire({ title: '批量删除', text: '确定删除 ' + selected.length + ' 个账号？', icon: 'warning', showCancelButton: true, confirmButtonColor: '#d33', confirmButtonText: '确认删除' });
    if (!result.isConfirmed) return;
    const backup = JSON.parse(JSON.stringify(accounts));   // 失败可回滚
    // Delete in reverse order to preserve indices
    selected.sort((a,b) => b - a).forEach(i => accounts.splice(i, 1));
    try {
        const r = await fetch('/api/accounts', { method: 'POST', body: JSON.stringify(accounts) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        renderTable();
        Swal.fire('已删除', selected.length + ' 个账号已删除', 'success');
    } catch (e) {
        accounts = backup; renderTable();
        console.error('[batchDeleteAccounts]', e);
        Swal.fire('批量删除失败', e.message, 'error');
    }
}


// Auto Config
function updateAutoToggleLabel(){ const el=document.getElementById("auto_toggle_label"); const master=document.getElementById("auto_update_toggle"); if(el&&master){ const on=master.checked; el.textContent=on?"开":"关"; el.className=on?"text-[10px] font-bold text-green-600":"text-[10px] font-bold text-gray-400"; document.getElementById("auto_cmliu_toggle").checked=on; document.getElementById("auto_joey_toggle").checked=on; document.getElementById("auto_ech_toggle").checked=on; } }
async function loadGlobalConfig(){ try{ const r=await fetch('/api/auto_config'); const c=await r.json(); document.getElementById('auto_update_toggle').checked=!!c.enabled; updateAutoToggleLabel(); document.getElementById('auto_update_interval').value=c.interval||30; document.getElementById('fuse_threshold').value=c.fuseThreshold||0; document.getElementById('fuse_webhook').value=c.fuseWebhook||''; document.getElementById('auto_cmliu_toggle').checked=c.enabled&&c.autoCmliu!==false; document.getElementById('auto_joey_toggle').checked=c.enabled&&c.autoJoey!==false; document.getElementById('auto_ech_toggle').checked=c.enabled&&c.autoEch!==false; }catch(e){ console.error('[loadGlobalConfig]', e); } }
async function saveAutoConfig(){
    try {
        const r = await fetch('/api/auto_config',{method:'POST',body:JSON.stringify({enabled:document.getElementById('auto_update_toggle').checked, interval:document.getElementById('auto_update_interval').value, fuseThreshold:document.getElementById('fuse_threshold').value, fuseWebhook:document.getElementById('fuse_webhook').value, autoCmliu:document.getElementById('auto_cmliu_toggle').checked, autoJoey:document.getElementById('auto_joey_toggle').checked, autoEch:document.getElementById('auto_ech_toggle').checked})});
        if(!r.ok) throw new Error('HTTP ' + r.status);
        Swal.fire({icon:'success',title:'已保存',timer:1200,showConfirmButton:false});
        setTimeout(()=>location.reload(),1300);
    } catch(e) {
        console.error('[saveAutoConfig]', e);
        Swal.fire('保存失败', e.message, 'error');
    }
}



// @exports
window.safeHtml = safeHtml;
window.doSearch = doSearch;
window.clearSearch = clearSearch;
window.renderTable = renderTable;
window.loadAccounts = loadAccounts;
window.loadStats = loadStats;
window.loadGlobalConfig = loadGlobalConfig;
window.updateAutoToggleLabel = updateAutoToggleLabel;
window.saveAccount = saveAccount;
window.editAccount = editAccount;
window.delAccount = delAccount;
window.resetFormForAdd = resetFormForAdd;
window.cancelEdit = cancelEdit;
window.selectAllAccounts = selectAllAccounts;
window.deselectAllAccounts = deselectAllAccounts;
window.batchDeleteAccounts = batchDeleteAccounts;
window.verifyAllCredentials = verifyAllCredentials;
window.deleteFromEdit = deleteFromEdit;
window.fetchZonesForAccount = fetchZonesForAccount;
window.updateZoneInfo = updateZoneInfo;
window.saveAutoConfig = saveAutoConfig;
