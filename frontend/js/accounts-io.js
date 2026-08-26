// ===== 导入导出 & 备份恢复 =====

/** 触发浏览器下载（Blob URL 需在 click 之后再 revoke，否则部分浏览器会取消下载） */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 读取用户选择的单个 JSON 文件 */
function pickJsonFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return resolve(null);
            try {
                const text = await file.text();
                resolve({ name: file.name, data: JSON.parse(text) });
            } catch (e) {
                Swal.fire('文件解析失败', '不是合法的 JSON 文件: ' + e.message, 'error');
                resolve(null);
            }
        });
        input.click();
    });
}

/** 下载类接口：非 2xx 时上游返回的是 JSON 错误体，需要读出来提示而不是存成损坏文件 */
async function downloadEndpoint(url, filename, successMsg) {
    const r = await fetch(url);
    if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { const d = await r.json(); if (d && d.msg) msg = d.msg; } catch (e) { /* 非 JSON */ }
        throw new Error(msg);
    }
    downloadBlob(await r.blob(), filename);
    if (successMsg) Swal.fire(successMsg.title, successMsg.text, 'success');
}

const today = () => new Date().toISOString().slice(0, 10);

async function exportAccounts() {
    try {
        await downloadEndpoint('/api/accounts/export', 'accounts-' + today() + '.json', {
            title: '导出完成',
            text: '文件已下载。注意：API Key 为加密密文，只能导入回使用相同 ENCRYPTION_SECRET 的实例。'
        });
    } catch (e) { Swal.fire('导出失败', e.message, 'error'); }
}

async function importAccounts() {
    const picked = await pickJsonFile();
    if (!picked) return;
    try {
        const result = await apiFetch('/api/accounts/import', { method: 'POST', body: JSON.stringify(picked.data) });
        if (result.success) {
            const detail = '新增 ' + result.added + ' 个, 跳过/合并 ' + result.skipped + ' 个, 共 ' + result.total + ' 个账号';
            if (result.warning) {
                Swal.fire({ title: '导入完成（有警告）', html: safeHtml(detail) + '<br><br><span class="text-orange-600 text-xs">' + safeHtml(result.warning) + '</span>', icon: 'warning' });
            } else {
                Swal.fire('导入完成', detail, 'success');
            }
            await loadAccounts();
        } else { Swal.fire('导入失败', result.msg || '未知错误', 'error'); }
    } catch (e) { Swal.fire('导入失败', e.message, 'error'); }
}

async function backupAll() {
    try {
        await downloadEndpoint('/api/backup', 'worker-backup-' + today() + '.json', {
            title: '备份完成',
            text: '数据已下载（含加密密钥指纹，恢复时会校验）'
        });
    } catch (e) { Swal.fire('备份失败', e.message, 'error'); }
}

async function restoreBackup() {
    const picked = await pickJsonFile();
    if (!picked) return;
    const confirmed = await Swal.fire({
        title: '⚠️ 恢复数据',
        html: '将用 <b>' + safeHtml(picked.name) + '</b> 覆盖现有配置（账号、变量、部署记录、收藏）。<br><span class="text-xs text-gray-500">未出现在备份中的键保持不变。</span>',
        icon: 'warning',
        showCancelButton: true, confirmButtonText: '确认恢复', confirmButtonColor: '#d33'
    });
    if (!confirmed.isConfirmed) return;
    try {
        const r = await apiFetch('/api/restore', { method: 'POST', body: JSON.stringify(picked.data) });
        if (r.success) {
            let html = '已恢复 ' + r.restored + ' 项配置';
            if (r.rejected) html += '，拒绝 ' + r.rejected + ' 个非白名单键';
            if (r.warning) html += '<br><br><span class="text-orange-600 text-xs">' + safeHtml(r.warning) + '</span>';
            await Swal.fire({ title: '恢复完成', html, icon: r.warning ? 'warning' : 'success' });
            location.reload();
        } else { Swal.fire('恢复失败', r.msg || '未知错误', 'error'); }
    } catch (e) { Swal.fire('恢复失败', e.message, 'error'); }
}

registerActions({
    exportAccounts: exportAccounts,
    importAccounts: importAccounts,
    backupAll: backupAll,
    restoreBackup: restoreBackup
});
