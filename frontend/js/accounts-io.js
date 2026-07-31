// ===== 导入导出 & 备份恢复 =====

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
// @exports
window.exportAccounts = exportAccounts;
window.importAccounts = importAccounts;
window.backupAll = backupAll;
window.restoreBackup = restoreBackup;
