// ===== 账号管理 =====

function renderTable() {
    const tb = document.getElementById('account_body');
    if (accounts.length === 0) { tb.innerHTML = '<tr><td colspan="6" class="text-center text-gray-300 py-4">无数据</td></tr>'; return; }
    const sortedAccounts = [...accounts].sort((a, b) => b.stats.total - a.stats.total);
    tb.innerHTML = sortedAccounts.map((a) => {
        const originalIndex = accounts.findIndex(acc => acc.alias === a.alias);
        const count = (a.workers_cmliu||[]).length + (a.workers_joey||[]).length + (a.workers_ech||[]).length;
        const percent = ((a.stats.total / a.stats.max) * 100).toFixed(1);
        let barColor = 'bg-green-500'; if (percent > 80) barColor = 'bg-orange-500'; if (percent >= 100) barColor = 'bg-red-600';
        const zoneBadge = a.defaultZoneName ? `<span class="bg-purple-100 text-purple-600 text-[10px] px-1 rounded">${a.defaultZoneName}</span>` : '<span class="text-gray-300">-</span>';
        return `<tr class="hover:bg-gray-50 border-b">
            <td class="font-medium">${a.alias}</td>
            <td>${zoneBadge}</td>
            <td><span class="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">${count} 个</span></td>
            <td>${a.stats.total}</td>
            <td><div class="flex items-center gap-2"><div class="w-12 bg-gray-200 rounded-full h-1.5 overflow-hidden"><div class="${barColor} h-1.5" style="width: ${Math.min(percent, 100)}%"></div></div><span class="text-[10px]">${percent}%</span></div></td>
            <td class="text-right">
                <button onclick="openAccountManage(${originalIndex})" class="text-purple-600 mr-2 text-xs font-bold hover:bg-purple-50 px-1 rounded">📂 管理</button>
                <button onclick="editAccount(${originalIndex})" class="text-blue-500 mr-2 text-xs">✎</button>
                <button onclick="delAccount(${originalIndex})" class="text-red-500 text-xs">×</button>
            </td>
        </tr>`;
    }).join('');
}

async function loadAccounts() { try { const r = await fetch('/api/accounts'); accounts = await r.json(); accounts.forEach(a => a.stats = a.stats || {total:0,max:100000}); renderTable(); } catch(e){} }

async function saveAccount() {
    const o={
        alias:document.getElementById('in_alias').value,
        accountId:document.getElementById('in_id').value,
        email:document.getElementById('in_email').value,
        globalKey:document.getElementById('in_gkey').value,
        defaultZoneName:document.getElementById('in_zone_name').value,
        defaultZoneId:document.getElementById('in_zone_id').value,
        stats:(editingIndex>=0 && accounts[editingIndex]) ? (accounts[editingIndex].stats || {total:0,max:100000}) : {total:0,max:100000}
    };
    ['cmliu','joey','ech'].forEach(t=>o['workers_'+t]=document.getElementById('in_workers_'+t).value.split(/,|，/).map(s=>s.trim()).filter(s=>s));
    if(editingIndex>=0)accounts[editingIndex]=o; else accounts.push(o);
    await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)});
    renderTable();
    document.getElementById('account_form').classList.add('hidden');
}

function editAccount(i){
    editingIndex=i; const a=accounts[i];
    document.getElementById('in_alias').value=a.alias;
    document.getElementById('in_id').value=a.accountId;
    document.getElementById('in_email').value=a.email||"";
    document.getElementById('in_gkey').value=a.globalKey||"";
    document.getElementById('in_zone_name').value=a.defaultZoneName||"";
    document.getElementById('in_zone_id').value=a.defaultZoneId||"";

    const select = document.getElementById('in_zone_select');
    if(a.defaultZoneName) { select.innerHTML = `<option value="${a.defaultZoneId}" data-name="${a.defaultZoneName}" selected>${a.defaultZoneName}</option>`; } else { select.innerHTML = '<option value="">(请点击读取)</option>'; }

    ['cmliu','joey','ech'].forEach(t=>document.getElementById('in_workers_'+t).value=(a['workers_'+t]||[]).join(','));
    document.getElementById('account_form').classList.remove('hidden');
}

async function delAccount(i){ if(confirm('删除账号配置？')){ accounts.splice(i,1); await fetch('/api/accounts',{method:'POST',body:JSON.stringify(accounts)}); renderTable(); } }
function resetFormForAdd(){ editingIndex=-1; document.querySelectorAll('#account_form input').forEach(i=>i.value=''); document.getElementById('in_zone_select').innerHTML='<option value="">(请先填写API信息后点击读取)</option>'; document.getElementById('account_form').classList.remove('hidden'); }
function cancelEdit(){ document.getElementById('account_form').classList.add('hidden'); }
async function deleteFromEdit(){ if(editingIndex>=0)delAccount(editingIndex); cancelEdit(); }

async function loadStats(){ const b=document.getElementById('btn_stats'); b.disabled=true; try{ const r=await fetch('/api/stats'); const d=await r.json(); accounts.forEach(a=>{ const s=d.find(x=>x.alias===a.alias); a.stats=s&&!s.error?s:{total:0,max:100000}; }); renderTable(); }catch(e){} b.disabled=false; }

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
            body: JSON.stringify({ accountId: id, email: email, globalKey: key })
        });
        const d = await res.json();
        if (d.success) {
            select.innerHTML = '<option value="">-- 请选择预设域名 --</option>' +
                d.zones.map(z => `<option value="${z.id}" data-name="${z.name}">${z.name}</option>`).join('');
        } else {
            select.innerHTML = '<option>读取失败</option>';
            Swal.fire('错误', d.msg, 'error');
        }
    } catch(e) { select.innerHTML = '<option>网络错误</option>'; }
}

function updateZoneInfo() {
    const sel = document.getElementById('in_zone_select');
    if(sel.selectedIndex > 0) {
        document.getElementById('in_zone_id').value = sel.value;
        document.getElementById('in_zone_name').value = sel.options[sel.selectedIndex].dataset.name;
    }
}

// ===== 账号管理弹窗 =====
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
                body: JSON.stringify({ accountId: acc.accountId, email: acc.email, globalKey: acc.globalKey })
            }),
            fetch('/api/get_subdomain', {
                method: 'POST',
                body: JSON.stringify({ accountId: acc.accountId, email: acc.email, globalKey: acc.globalKey })
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
                        <td class="font-bold text-indigo-600">${w.id}</td>
                        <td>${new Date(w.created_on).toLocaleDateString()}</td>
                        <td>${new Date(w.modified_on).toLocaleDateString()}</td>
                        <td class="text-right">
                            <button onclick="confirmDeleteWorker('${acc.alias}', '${w.id}', ${i})" class="text-xs bg-red-100 text-red-600 px-2 py-1 rounded hover:bg-red-200">🗑️ 删除</button>
                        </td>
                    </tr>
                `).join('');
            }
        } else {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center text-red-500 py-4">${d.msg}</td></tr>`;
            table.classList.remove('hidden');
        }
    } catch(e) { loading.innerText = "网络错误"; }
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
            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(val) && val.length > 1 || val.length < 1) {
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
            body: JSON.stringify({ accountId: acc.accountId, email: acc.email, globalKey: acc.globalKey, newSubdomain: newSub })
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
          <p>确认要删除 <b>${workerId}</b> 吗？</p>
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
                    email: acc.email,
                    globalKey: acc.globalKey,
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
async function loadGlobalConfig(){ try{ const r=await fetch('/api/auto_config'); const c=await r.json(); document.getElementById('auto_update_toggle').checked=!!c.enabled; document.getElementById('auto_update_interval').value=c.interval||30; document.getElementById('fuse_threshold').value=c.fuseThreshold||0; }catch(e){} }
async function saveAutoConfig(){ await fetch('/api/auto_config',{method:'POST',body:JSON.stringify({enabled:document.getElementById('auto_update_toggle').checked, interval:document.getElementById('auto_update_interval').value, fuseThreshold:document.getElementById('fuse_threshold').value})}); alert('已保存配置'); }
