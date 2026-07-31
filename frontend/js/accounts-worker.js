// ===== Worker 管理弹窗 (子域名 & 删除) =====

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
// @exports
window.openAccountManage = openAccountManage;
window.confirmDeleteWorker = confirmDeleteWorker;
