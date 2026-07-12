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
        _tableHeaderCache = '<tr><td colspan="7" class="p-1"><div class="flex gap-1 mb-1"><button onclick="selectAllAccounts()" class="text-xs bg-gray-100 px-2 py-0.5 rounded">全选</button><button onclick="deselectAllAccounts()" class="text-xs bg-gray-100 px-2 py-0.5 rounded">取消</button><button onclick="batchDeleteAccounts()" class="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded">批量删除</button><button onclick="migrateEncryptKeys()" class="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded font-bold" title="加密所有明文 API Key">🔐 加密迁移</button><button onclick="exportAccounts()" class="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded ml-auto">导出</button><button onclick="importAccounts()" class="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded">导入</button><button onclick="backupAll()" class="text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded">备份</button><button onclick="restoreBackup()" class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">恢复</button><span id="batch_count" class="text-[10px] text-gray-400 ml-1"></span></div></td></tr>' +
        '<tr><td colspan="7" class="p-1"><div class="flex gap-1 items-center"><input id="account_search" placeholder="🔍 搜索账号/别名/邮箱/域名..." class="flex-1 text-xs border rounded px-2 py-1"><button id="search_clear" onclick="clearSearch()" class="text-xs text-gray-400 hover:text-red-500 px-1" title="清除搜索 (Esc)">✕</button><button onclick="doSearch()" class="text-xs bg-blue-500 text-white px-2 py-0.5 rounded" title="搜索 (Enter)">搜索</button><span id="search_count" class="text-[10px] text-gray-400"></span></div></td></tr>';
    }
    return _tableHeaderCache;
}

function renderTable() {
    const tb = document.getElementById('account_body');
    if (accounts.length === 0) {
        tb.innerHTML = _getTableHeader() + '<tr><td colspan="7" class="text-center text-gray-300 py-4">无数据</td></tr>';
        return;
    }
    const sortedAccounts = [...accounts].sort((a, b) => b.stats.total - a.stats.total);
    // 构建数据行（保留 innerHTML 因为模板复杂度高，但头部缓存避免重复解析）
    tb.innerHTML = _getTableHeader() + sortedAccounts.map((a) => {
        const originalIndex = accounts.findIndex(acc => acc.alias === a.alias);
        const count = Object.keys(TEMPLATES).reduce((s,t) => s + (a['workers_'+t]||[]).length, 0);
        const percent = ((a.stats.total / a.stats.max) * 100).toFixed(1);
        let barColor = 'bg-green-500'; if (percent > 80) barColor = 'bg-orange-500'; if (percent >= 100) barColor = 'bg-red-600';
        const zoneBadge = a.defaultZoneName ? `<span class="bg-purple-100 text-purple-600 text-[10px] px-1 rounded">${safeHtml(a.defaultZoneName)}</span>` : '<span class="text-gray-300">-</span>';
        return `<tr class="hover:bg-gray-50 border-b">
            <td class="w-6"><input type="checkbox" class="acct-chk" value="${originalIndex}" onchange="updateBatchToolbar()"></td>
            <td class="font-medium">${safeHtml(a.alias)}</td>
            <td>${zoneBadge}</td>
            <td><span class="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">${count} 个</span></td>
            <td>${a.stats.error?`<span class="text-red-500 cursor-help" title="${safeHtml(a.stats.error||"")}">⚠️ 0</span>`:a.stats.total}</td>
            <td><div class="flex items-center gap-2"><div class="w-12 bg-gray-200 rounded-full h-1.5 overflow-hidden"><div class="${barColor} h-1.5" style="width: ${Math.min(percent, 100)}%"></div></div><span class="text-[10px]">${percent}%</span></div></td>
            <td class="text-right">
                <button onclick="openAccountManage(${originalIndex})" class="text-purple-600 mr-2 text-xs font-bold hover:bg-purple-50 px-1 rounded">📂 管理</button>
                <button onclick="editAccount(${originalIndex})" class="text-blue-500 mr-2 text-xs">✎</button>
                <button onclick="delAccount(${originalIndex})" class="text-red-500 text-xs">×</button>
            </td>
        </tr>`;
    }).join('');
    // 清除动态元素缓存（innerHTML 重建后旧 DOM 引用失效）
    $clear('account_search');
    $clear('search_clear');
    $clear('search_count');
}

async function loadAccounts() { try { const r = await fetch('/api/accounts'); accounts = await r.json(); accounts.forEach(a => a.stats = a.stats || {total:0,max:100000}); renderTable(); } catch(e){ console.error('[loadAccounts]', e); } }

async function saveAccount() {
    const o={
        alias:$('in_alias').value,
        accountId:$('in_id').value,
        email:$('in_email').value,
        globalKey:$('in_gkey').value,
        defaultZoneName:$('in_zone_name').value,
        defaultZoneId:$('in_zone_id').value,
        dailyLimit:parseInt($('in_daily_limit').value, 10) || 0,
        stats:(editingIndex>=0 && accounts[editingIndex]) ? (accounts[editingIndex].stats || {total:0,max:parseInt($('in_daily_limit').value, 10)||100000}) : {total:0,max:parseInt($('in_daily_limit').value)||100000}
    };
    Object.keys(TEMPLATES).forEach(t=>o['workers_'+t]=$('in_workers_'+t).value.split(/,|，/).map(s=>s.trim()).filter(s=>s));
    if(editingIndex>=0)accounts[editingIndex]=o; else accounts.push(o);
    await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)});
    renderTable();
    $('account_form').classList.add('hidden');
}

function editAccount(i){
    editingIndex=i; const a=accounts[i];
    $('in_alias').value=a.alias;
    $('in_id').value=a.accountId;
    $('in_email').value=a.email||"";
    $('in_gkey').value=a.globalKey||"";
    $('in_daily_limit').value=a.dailyLimit||"";
    $('in_zone_name').value=a.defaultZoneName||"";
    $('in_zone_id').value=a.defaultZoneId||"";

    const select = $('in_zone_select');
    if(a.defaultZoneName) { select.innerHTML = `<option value="${safeHtml(a.defaultZoneId)}" data-name="${safeHtml(a.defaultZoneName)}" selected>${safeHtml(a.defaultZoneName)}</option>`; } else { select.innerHTML = '<option value="">(请点击读取)</option>'; }

    Object.keys(TEMPLATES).forEach(t=>$('in_workers_'+t).value=(a['workers_'+t]||[]).join(','));
    $('account_form').classList.remove('hidden');
}

async function delAccount(i){ if(confirm('删除账号配置？')){ accounts.splice(i,1); await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)}); renderTable(); } }
function resetFormForAdd(){ editingIndex=-1; $clearAll(); document.querySelectorAll('#account_form input').forEach(i=>i.value=''); $('in_zone_select').innerHTML='<option value="">(请先填写API信息后点击读取)</option>'; $('account_form').classList.remove('hidden'); }
function cancelEdit(){ $('account_form').classList.add('hidden'); }
async function deleteFromEdit(){ if(editingIndex>=0)delAccount(editingIndex); cancelEdit(); }

async function loadStats(){ const b=document.getElementById('btn_stats'); b.disabled=true; try{ const r=await fetch('/api/stats'); if(!r.ok)throw new Error(`HTTP ${r.status}`); const d=await r.json(); const errs=[]; accounts.forEach(a=>{ const s=d.find(x=>x.alias===a.alias); if(s){ a.stats=s; if(s.error)errs.push(`${safeHtml(a.alias)}: ${s.error}`); } else { a.stats={total:0,max:100000,error:'未匹配到账号'}; errs.push(`${safeHtml(a.alias)}: 未匹配到账号`); } }); renderTable(); if(errs.length)Swal.fire({title:'用量查询异常',html:`<div class="text-left text-xs max-h-60 overflow-y-auto">${errs.map(e=>`<p class="text-red-600 mb-1">⚠️ ${e}</p>`).join('')}</div>`,icon:'warning',confirmButtonColor:'#4f46e5'}); }catch(e){ Swal.fire('用量查询失败',e.message,'error'); } b.disabled=false; }

async function fetchZonesForAccount() {
    const email = document.getElementById('in_email').value;
    const key = document.getElementById('in_gkey').value;
    const id = document.getElementById('in_id').value;
    const select = document.getElementById('in_zone_select');

    if (!email || !key) return Swal.fire('提示', '请先填写 Email, API Key', 'warning');

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
        const results = await r.json();
        const ok = results.filter((x) => x.ok).length;
        const fail = results.filter((x) => !x.ok).length;
        let html = '✅ ' + ok + ' / ❌ ' + fail + '<br><div class="text-left text-xs max-h-40 overflow-y-auto mt-2">';
        results.forEach((x) => { if (!x.ok) html += '<p class="text-red-500">' + safeHtml(x.alias) + ': ' + (x.error || 'HTTP ' + x.status) + '</p>'; });
        html += '</div>';
        Swal.fire({ title: '凭据验证结果', html, icon: fail > 0 ? 'warning' : 'success' });
    } catch(e) { Swal.fire('验证失败', e.message, 'error'); }
}

async function exportAccounts() {
    try {
        const r = await fetch('/api/accounts/export');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'accounts-' + new Date().toISOString().slice(0,10) + '.json';
        a.click(); URL.revokeObjectURL(url);
    } catch(e) { Swal.fire('导出失败', e.message, 'error'); }
}
async function importAccounts() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
        try {
            const file = input.files[0];
            if (!file) return;
            const text = await file.text();
            const data = JSON.parse(text);
            const res = await fetch('/api/accounts/import', { method: 'POST', body: JSON.stringify(data) });
            const result = await res.json();
            if (result.success) {
                Swal.fire('导入完成', '新增 ' + result.added + ' 个, 跳过 ' + result.skipped + ' 个, 共 ' + result.total + ' 个账号', 'success');
                await loadAccounts();
            } else { Swal.fire('导入失败', result.msg, 'error'); }
        } catch(e) { Swal.fire('导入失败', e.message, 'error'); }
    };
    input.click();
}
async function backupAll() {
    try {
        const r = await fetch('/api/backup');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'worker-backup-' + new Date().toISOString().slice(0,10) + '.json';
        a.click(); URL.revokeObjectURL(url);
        Swal.fire('备份完成', '数据已下载', 'success');
    } catch(e) { Swal.fire('备份失败', e.message, 'error'); }
}
async function restoreBackup() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
        const result = await Swal.fire({
            title: '⚠️ 恢复数据', text: '此操作会覆盖现有配置，确定继续？', icon: 'warning',
            showCancelButton: true, confirmButtonText: '确认恢复', confirmButtonColor: '#d33'
        });
        if (!result.isConfirmed) return;
        try {
            const file = input.files[0];
            if (!file) return;
            const text = await file.text();
            const data = JSON.parse(text);
            const res = await fetch('/api/restore', { method: 'POST', body: JSON.stringify(data) });
            const r = await res.json();
            if (r.success) {
                Swal.fire('恢复完成', '已恢复 ' + r.restored + ' 项配置', 'success');
                location.reload();
            } else { Swal.fire('恢复失败', r.msg, 'error'); }
        } catch(e) { Swal.fire('恢复失败', e.message, 'error'); }
    };
    input.click();
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
    // Delete in reverse order to preserve indices
    selected.sort((a,b) => b - a).forEach(i => accounts.splice(i, 1));
    await fetch('/api/accounts', { method: 'POST', body: JSON.stringify(accounts) });
    renderTable();
    Swal.fire('已删除', selected.length + ' 个账号已删除', 'success');
}

let currentManageAccIndex = -1;

async function openAccountManage(i) {
    currentManageAccIndex = i;
    const acc = accounts[i];
    if (!acc.globalKey) return Swal.fire('无法管理', '请先配置 Global API Key', 'error');

    const modal = document.getElementById('account_manage_modal');
    const table = document.getElementById('manage_table');
    const tbody = document.getElementById('manage_list_body');
    const loading = document.getElementById('manage_loading');
    const subDisplay = document.getElementById('manage_subdomain_display');

    document.getElementById('manage_modal_title').innerText = `📂 管理账号: ${acc.alias}`;
    subDisplay.innerText = '加载中...';
    modal.classList.remove('hidden');
    table.classList.add('hidden');
    loading.classList.remove('hidden');
    tbody.innerHTML = '';

    try {
        const [workersRes, subRes] = await Promise.all([
            fetch('/api/all_workers', {
                method: 'POST',
                body: JSON.stringify({ accountId: acc.accountId })
            }),
            fetch('/api/get_subdomain', {
                method: 'POST',
                body: JSON.stringify({ accountId: acc.accountId })
            })
        ]);

        const subData = await subRes.json();
        if (subData.success && subData.subdomain) {
            subDisplay.innerText = subData.subdomain;
        } else {
            subDisplay.innerText = subData.msg || '未设置';
        }

        const d = await workersRes.json();
        loading.classList.add('hidden');

        if (d.success) {
            table.classList.remove('hidden');
            if (d.workers.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4">无 Worker</td></tr>';
            } else {
                tbody.innerHTML = d.workers.map(w => `
                    <tr class="hover:bg-gray-50 border-b">
                        <td class="font-bold text-indigo-600">${safeHtml(w.id)}</td>
                        <td>${safeHtml(new Date(w.created_on).toLocaleDateString())}</td>
                        <td>${safeHtml(new Date(w.modified_on).toLocaleDateString())}</td>
                        <td class="text-right">
                            <button onclick="confirmDeleteWorker('${safeJsStr(acc.alias)}', '${safeJsStr(w.id)}', ${i})" class="text-xs bg-red-100 text-red-600 px-2 py-1 rounded hover:bg-red-200">🗑️ 删除</button>
                        </td>
                    </tr>
                `).join('');
            }
        } else {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center text-red-500 py-4">${safeHtml(d.msg)}</td></tr>`;
            table.classList.remove('hidden');
        }
    } catch(e) { console.error('[openAccountManage]', e); loading.innerText = "网络错误"; }
}

async function promptChangeSubdomain() {
    if (currentManageAccIndex < 0) return;
    const acc = accounts[currentManageAccIndex];
    const currentSub = document.getElementById('manage_subdomain_display').innerText;

    const { value: newSub } = await Swal.fire({
        title: '修改 Workers.dev 子域名',
        html: `
            <div class="text-left text-sm space-y-2">
                <div class="bg-gray-50 p-2 rounded">当前: <b>${currentSub}</b>.workers.dev</div>
                <input id="swal_new_subdomain" class="swal2-input" placeholder="输入新子域名前缀" style="margin:0;width:100%">
                <div class="text-xs text-gray-400">⚠️ 修改子域名可能需要数分钟生效，且可能影响现有 Worker 的访问地址。</div>
            </div>
        `,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: '确认修改',
        cancelButtonText: '取消',
        confirmButtonColor: '#4f46e5',
        preConfirm: () => {
            const val = document.getElementById('swal_new_subdomain').value.trim();
            if (!val) { Swal.showValidationMessage('请输入新子域名'); return false; }
            if (val.length < 1 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(val)) {
                Swal.showValidationMessage('子域名只能包含字母、数字和连字符'); return false;
            }
            return val;
        }
    });

    if (!newSub) return;

    const confirm2 = await Swal.fire({
        title: '二次确认',
        html: `确定将子域名从 <b>${currentSub}</b> 改为 <b>${newSub}</b> 吗？<br><span class="text-xs text-red-500">此操作会影响所有使用 workers.dev 域名的 Worker！</span>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '确认修改',
        cancelButtonText: '取消',
        confirmButtonColor: '#d33'
    });

    if (!confirm2.isConfirmed) return;

    try {
        Swal.fire({ title: '修改中...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const res = await fetch('/api/change_subdomain', {
            method: 'POST',
            body: JSON.stringify({ accountId: acc.accountId, newSubdomain: newSub })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('manage_subdomain_display').innerText = data.subdomain || newSub;
            Swal.fire('修改成功', `子域名已更新为: ${data.subdomain || newSub}.workers.dev`, 'success');
        } else {
            Swal.fire('修改失败', data.msg || '未知错误', 'error');
        }
    } catch(e) {
        Swal.fire('错误', '网络错误: ' + e.message, 'error');
    }
}

async function confirmDeleteWorker(alias, workerId, accIndex) {
    const result = await Swal.fire({
        title: '危险操作',
        html: `
          <p>确认要删除 <b>${safeHtml(workerId)}</b> 吗？</p>
          <div class="mt-4 text-left bg-gray-50 p-2 rounded text-xs">
              <label class="flex items-center space-x-2">
                  <input type="checkbox" id="del_kv_chk" checked class="form-checkbox text-red-600">
                  <span class="text-gray-700 font-bold">同时删除绑定的 KV (推荐)</span>
              </label>
              <p class="text-gray-400 mt-1 pl-5">执行顺序: 1.读取绑定 -> 2.删除Worker(自动解绑) -> 3.删除KV空间</p>
          </div>
        `,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '确认删除',
        confirmButtonColor: '#d33',
        showLoaderOnConfirm: true,
        preConfirm: () => {
            const deleteKv = document.getElementById('del_kv_chk').checked;
            const acc = accounts[accIndex];
            return fetch('/api/delete_worker', {
                method: 'POST',
                body: JSON.stringify({
                    accountId: acc.accountId,
                    workerName: workerId,
                    deleteKv: deleteKv
                })
            }).then(response => response.json()).then(data => {
                if (!data.success) throw new Error(data.msg);
                return data;
            }).catch(error => Swal.showValidationMessage(`删除失败: ${error}`));
        }
    });

    if (result.isConfirmed) {
        Swal.fire('已删除', 'Worker 及相关资源已清理', 'success');
        await loadAccounts();
        openAccountManage(accIndex);
    }
}

// Auto Config
function updateAutoToggleLabel(){ const el=document.getElementById("auto_toggle_label"); const master=document.getElementById("auto_update_toggle"); if(el&&master){ const on=master.checked; el.textContent=on?"开":"关"; el.className=on?"text-[10px] font-bold text-green-600":"text-[10px] font-bold text-gray-400"; document.getElementById("auto_cmliu_toggle").checked=on; document.getElementById("auto_joey_toggle").checked=on; document.getElementById("auto_ech_toggle").checked=on; } }
async function loadGlobalConfig(){ try{ const r=await fetch('/api/auto_config'); const c=await r.json(); document.getElementById('auto_update_toggle').checked=!!c.enabled; updateAutoToggleLabel(); document.getElementById('auto_update_interval').value=c.interval||30; document.getElementById('fuse_threshold').value=c.fuseThreshold||0; document.getElementById('fuse_webhook').value=c.fuseWebhook||''; document.getElementById('auto_cmliu_toggle').checked=c.enabled&&c.autoCmliu!==false; document.getElementById('auto_joey_toggle').checked=c.enabled&&c.autoJoey!==false; document.getElementById('auto_ech_toggle').checked=c.enabled&&c.autoEch!==false; }catch(e){ console.error('[loadGlobalConfig]', e); } }
async function saveAutoConfig(){ await fetch('/api/auto_config',{method:'POST',body:JSON.stringify({enabled:document.getElementById('auto_update_toggle').checked, interval:document.getElementById('auto_update_interval').value, fuseThreshold:document.getElementById('fuse_threshold').value, fuseWebhook:document.getElementById('fuse_webhook').value, autoCmliu:document.getElementById('auto_cmliu_toggle').checked, autoJoey:document.getElementById('auto_joey_toggle').checked, autoEch:document.getElementById('auto_ech_toggle').checked})}); Swal.fire({icon:'success',title:'已保存',timer:1200,showConfirmButton:false}); setTimeout(()=>location.reload(),1300); }


async function migrateEncryptKeys() {
    if (!confirm('将加密所有账号的 API Key 到 KV？\n\n加密后密钥以密文存储，即使 KV 泄露也无法解密。\n仅需执行一次。')) return;
    const btn = event.target;
    const orig = btn.innerText;
    btn.innerText = '⏳ 迁移中...';
    btn.disabled = true;
    try {
        const r = await fetch('/api/migrate_encrypt_keys', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
            Swal.fire('✅ 迁移完成', '加密: ' + d.encrypted + ' | 已加密: ' + d.alreadyEncrypted + ' | 总计: ' + d.total, 'success');
        } else {
            Swal.fire('❌ 失败', d.msg, 'error');
        }
    } catch(e) {
        Swal.fire('❌ 错误', e.message, 'error');
    }
    btn.innerText = orig;
    btn.disabled = false;
}
window.migrateEncryptKeys = migrateEncryptKeys;

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
window.exportAccounts = exportAccounts;
window.importAccounts = importAccounts;
window.backupAll = backupAll;
window.restoreBackup = restoreBackup;
window.openAccountManage = openAccountManage;
window.confirmDeleteWorker = confirmDeleteWorker;
window.verifyAllCredentials = verifyAllCredentials;
