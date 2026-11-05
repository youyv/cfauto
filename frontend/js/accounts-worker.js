// ===== Worker 管理弹窗 (子域名 & 删除) =====

let currentManageAccountId = null;
let manageReadId = 0;

async function openAccountManage(i) {
    const readId = ++manageReadId;
    const acc = state.accounts[i];
    if (!acc) return;
    if (!acc.globalKey && !acc.apiToken) return Swal.fire('无法管理', '该账号未配置凭据（Global API Key 或 API Token）或解密失败，请先编辑账号重新填写', 'error');

    const accountId = acc.accountId;
    currentManageAccountId = accountId;
    const table = $('manage_table');
    table.setAttribute('aria-busy', 'true');
    const tbody = $('manage_list_body');
    const loading = $('manage_loading');
    const subDisplay = $('manage_subdomain_display');

    setUiContent($('manage_modal_title'), 'folder-open', ' 管理账号: ' + acc.alias);
    subDisplay.innerText = '加载中...';
    openModal('account_manage_modal');
    table.classList.add('hidden');
    loading.classList.remove('hidden');
    loading.innerText = '正在加载 Workers 列表...';
    tbody.innerHTML = '';

    // 两个请求独立成败：子域名失败不应让 Worker 列表也不显示
    const [workersResult, subResult] = await Promise.allSettled([
        apiFetch('/api/all_workers', { method: 'POST', body: JSON.stringify({ accountId: acc.accountId }) }),
        apiFetch('/api/get_subdomain', { method: 'POST', body: JSON.stringify({ accountId: acc.accountId }) })
    ]);

    if (readId !== manageReadId || currentManageAccountId !== accountId) return;
    table.setAttribute('aria-busy', 'false');

    if (subResult.status === 'fulfilled' && subResult.value && subResult.value.success) {
        subDisplay.innerText = subResult.value.subdomain || '未设置';
    } else {
        const reason = subResult.status === 'rejected'
            ? (subResult.reason && subResult.reason.message)
            : (subResult.value && subResult.value.msg);
        subDisplay.innerText = reason || '查询失败';
    }

    loading.classList.add('hidden');
    if (workersResult.status === 'rejected') {
        loading.classList.remove('hidden');
        loading.innerText = '加载失败: ' + (workersResult.reason && workersResult.reason.message);
        return;
    }
    const d = workersResult.value;
    table.classList.remove('hidden');
    tbody.innerHTML = '';

    if (!d || !d.success) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4; td.className = 'text-center text-red-500 py-4';
        td.textContent = (d && d.msg) || '读取失败';
        tr.appendChild(td); tbody.appendChild(tr);
        return;
    }
    if (!d.workers || d.workers.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4; td.className = 'text-center py-4 text-gray-400';
        td.textContent = '无 Worker';
        tr.appendChild(td); tbody.appendChild(tr);
        return;
    }

    // 用 DOM API 构建行：避免 innerHTML 中拼 onclick（CSP 与转义双重风险）
    const managedNames = new Set(Object.keys(TEMPLATES).flatMap(t => acc['workers_' + t] || []));
    d.workers.forEach(w => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gray-50 border-b';

        const tdName = document.createElement('td');
        tdName.className = 'font-bold text-indigo-600';
        tdName.textContent = w.id;
        if (managedNames.has(w.id)) {
            const tag = document.createElement('span');
            tag.className = 'ml-1 text-[9px] bg-green-100 text-green-700 px-1 rounded';
            tag.textContent = '中控管理';
            tdName.appendChild(tag);
        }
        tr.appendChild(tdName);

        const tdCreated = document.createElement('td');
        tdCreated.textContent = w.created_on ? new Date(w.created_on).toLocaleDateString() : '-';
        tr.appendChild(tdCreated);

        const tdModified = document.createElement('td');
        tdModified.textContent = w.modified_on ? new Date(w.modified_on).toLocaleDateString() : '-';
        tr.appendChild(tdModified);

        const tdAct = document.createElement('td');
        tdAct.className = 'text-right';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'text-xs bg-red-100 text-red-600 px-2 py-1 rounded hover:bg-red-200';
        setUiContent(btn, 'trash-2', ' 删除');
        btn.addEventListener('click', () => {
            const index = state.accounts.findIndex(a => a.accountId === accountId);
            if (index < 0) { void Swal.fire('账号已变化', '原账号已不在清单中，请重新读取。', 'warning'); return; }
            void confirmDeleteWorker(w.id, index);
        });
        tdAct.appendChild(btn);
        tr.appendChild(tdAct);

        tbody.appendChild(tr);
    });
}

async function promptChangeSubdomain() {
    const acc = state.accounts.find(a => a.accountId === currentManageAccountId);
    if (!acc) return;
    const accountId = acc.accountId;
    const accountAlias = acc.alias || '';
    const currentSub = $('manage_subdomain_display').innerText;

    const { value: newSub } = await Swal.fire({
        title: '修改 Workers.dev 子域名',
        html:
            '<div class="text-left text-sm space-y-2">' +
            '<p>账号：' + safeHtml(accountAlias) + '（' + safeHtml(accountId) + '）</p>' +
            '<div class="bg-gray-50 p-2 rounded">当前: <b>' + safeHtml(currentSub) + '</b>.workers.dev</div>' +
            '<label for="swal_new_subdomain">新子域名前缀</label>' +
            '<input id="swal_new_subdomain" class="swal2-input" placeholder="输入新子域名前缀" style="margin:0;width:100%">' +
            '<div class="text-xs text-gray-400"><span data-ui-icon="triangle-alert">⚠️</span> 修改子域名可能需要数分钟生效，且会影响该账号下所有 Worker 的访问地址。</div>' +
            '</div>',
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: '确认修改',
        cancelButtonText: '取消',
        confirmButtonColor: '#4f46e5',
        preConfirm: () => {
            const val = ($('swal_new_subdomain').value || '').trim().toLowerCase();
            if (!val) { Swal.showValidationMessage('请输入新子域名'); return false; }
            // 与后端 SUBDOMAIN_RE 一致：小写字母数字连字符，1-63，不以连字符开头/结尾
            if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(val)) {
                Swal.showValidationMessage('仅允许小写字母、数字与连字符，长度 1-63，且不能以连字符开头或结尾');
                return false;
            }
            return val;
        }
    });

    if (!newSub) return;

    const confirm2 = await Swal.fire({
        title: '二次确认',
        html: '<p>账号：' + safeHtml(accountAlias) + '（' + safeHtml(accountId) + '）</p>确定将子域名从 <b>' + safeHtml(currentSub) + '</b> 改为 <b>' + safeHtml(newSub) + '</b> 吗？<br><span class="text-xs text-red-500">此操作会影响所有使用 workers.dev 域名的 Worker！</span>',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: '确认修改',
        cancelButtonText: '取消',
        confirmButtonColor: '#d33',
        input: 'text',
        inputLabel: '精确输入新子域名前缀确认',
        inputPlaceholder: newSub,
        inputAttributes: { autocomplete: 'off', spellcheck: 'false' },
        focusConfirm: false,
        showLoaderOnConfirm: true,
        allowOutsideClick: () => !Swal.isLoading(),
        allowEscapeKey: () => !Swal.isLoading(),
        preConfirm: async (value) => {
            if (value !== newSub) {
                Swal.showValidationMessage('请精确输入：' + safeHtml(newSub));
                return false;
            }
            try {
                const data = await apiFetch('/api/change_subdomain', {
                    method: 'POST',
                    body: JSON.stringify({ accountId, newSubdomain: newSub })
                });
                if (isAcceptedTask(data)) return data;
                if (!data.success) throw new Error(data.msg || '修改失败');
                return data;
            } catch (error) {
                Swal.showValidationMessage('修改失败：' + safeHtml(error.message || '未知错误'));
                return false;
            }
        }
    });
    if (!confirm2.isConfirmed || !confirm2.value) return;
    if (trackAcceptedTask(confirm2.value)) return;
    const updated = confirm2.value.subdomain || newSub;
    if (currentManageAccountId === accountId && state.accounts.some(a => a.accountId === accountId)) $('manage_subdomain_display').innerText = updated;
    Swal.fire('修改成功', '子域名已更新为: ' + updated + '.workers.dev', 'success');
}

async function confirmDeleteWorker(workerId, accIndex) {
    const acc = state.accounts[accIndex];
    if (!acc) return;
    // Freeze the target shown by this confirmation, even if account data refreshes.
    const accountId = acc.accountId;
    const result = await Swal.fire({
        title: '危险操作',
        html:
            '<p>账号：<b>' + safeHtml(acc.alias || '') + '</b>（' + safeHtml(accountId) + '）</p>' +
            '<p>确认要删除 Worker <b>' + safeHtml(workerId) + '</b> 吗？</p>' +
            '<p class="text-xs text-red-500 mt-2">若模板已无受管 Worker，相关部署配置、变量和收藏会重置；无剩余 Worker 的账号级变量覆盖也会清理。请先备份中控配置。</p>' +
            '<div class="mt-4 text-left bg-gray-50 p-2 rounded text-xs">' +
            '<label class="flex items-center space-x-2">' +
            '<input type="checkbox" id="del_kv_chk" class="form-checkbox text-red-600">' +
            '<span class="text-gray-700 font-bold">同时删除未被其他 Worker 共用的 KV</span>' +
            '</label>' +
            '<p class="text-gray-400 mt-1 pl-5">无法确认是否共用时保留 KV；建议先备份数据。</p>' +
            '<p class="text-red-500 mt-1 pl-5"><span data-ui-icon="triangle-alert">⚠️</span> 删除 KV 会一并丢失其中的优选节点等数据，不可恢复</p>' +
            '</div>',
        icon: 'warning',
        showCancelButton: true,
        input: 'text',
        inputLabel: '输入 Worker 名称确认删除',
        inputPlaceholder: workerId,
        inputAttributes: { autocomplete: 'off', spellcheck: 'false' },
        focusConfirm: false,
        confirmButtonText: '确认删除',
        confirmButtonColor: '#d33',
        showLoaderOnConfirm: true,
        allowOutsideClick: () => !Swal.isLoading(),
        preConfirm: async (confirmedName) => {
            if (confirmedName !== workerId) {
                Swal.showValidationMessage('名称必须完全一致，请输入：' + safeHtml(workerId));
                return false;
            }
            const deleteKv = $('del_kv_chk').checked;
            try {
                const data = await apiFetch('/api/delete_worker', {
                    method: 'POST',
                    body: JSON.stringify({ accountId: accountId, workerName: workerId, deleteKv: deleteKv })
                });
                if (isAcceptedTask(data)) return data;
                if (!data.success) throw new Error(data.msg || '删除失败');
                return data;
            } catch (error) {
                Swal.showValidationMessage('删除失败: ' + safeHtml((error && error.message) || '未知错误'));
                return false;
            }
        }
    });

    if (result.isConfirmed && result.value) {
        if (trackAcceptedTask(result.value)) return;
        const warn = result.value.kvWarnings;
        const labels = { deleted: '已删除', updated: '已更新', reset: '已重置', retained: '已保留', failed: '失败', unknown: '结果未知' };
        const outcomes = (result.value.results || []).map(item => item.resource + '：' + (labels[item.status] || item.status) + (item.detail ? '（' + item.detail + '）' : '')).join('\n');
        Swal.fire({ title: warn ? '已删除（有警告）' : '已删除', text: (warn || 'Worker 已删除；KV 仅按勾选选项及共享检查结果处理。') + (outcomes ? '\n' + outcomes : ''), icon: warn ? 'warning' : 'success' });
        await loadAccounts();
        const currentIndex = state.accounts.findIndex(a => a.accountId === accountId);
        if (currentManageAccountId === accountId && currentIndex >= 0) void openAccountManage(currentIndex);
    }
}

registerActions({
    promptChangeSubdomain: promptChangeSubdomain
});
