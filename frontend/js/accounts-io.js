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
function pickJsonFile(maxBytes) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return resolve(null);
            if (maxBytes && file.size > maxBytes) {
                Swal.fire('文件过大', '备份超过 5 MiB，请保留元数据并按键拆分后重试。', 'error');
                return resolve(null);
            }
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
        const response = await fetch('/api/accounts/export');
        if (!response.ok || response.headers.get('x-reliability-protocol') !== '1') throw new Error('权威导出不可用；没有回退到旧 KV 导出');
        const data = await response.json();
        if (data.format !== 'cfauto.accounts' || data.version !== 2 || !Array.isArray(data.accounts) || !Array.isArray(data.keyIds)) throw new Error('导出文件格式不完整');
        downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'accounts-v2-' + today() + '.json');
        await Swal.fire('账号导出完成', '仅含账号配置和 v2 密文，导入需要保留对应 keyId 的旧密钥；不含密钥原值。这不是完整权威备份，不能用于数据切换。', 'success');
    } catch (e) { Swal.fire('导出失败', e.message, 'error'); }
}

let accountImportBusy = false;
async function importAccounts() {
    if (accountImportBusy) return;
    accountImportBusy = true;
    let pinned = false;
    try {
        if (!configProtocol || !configProtocol.isEnabled()) throw new Error('尚未加载权威账号修订，禁止调用旧导入路径');
        if (configProtocol.pending().some(item => item.domain === 'accounts')) throw new Error('存在待确认或冲突的账号保存；请先在待确认面板处理原请求');
        pinConfigView('accounts'); pinned = true;
        const picked = await pickJsonFile(100 * 1024);
        if (!picked) return;
        const file = picked.data;
        const value = { file: file };
        const records = Array.isArray(file) ? file : file && file.accounts;
        if (!Array.isArray(records) || !records.length) throw new Error('文件必须包含非空账号数组');
        if (!(file && file.format === 'cfauto.accounts')) {
            const unprefixed = records.some(account => account && ['apiToken', 'globalKey'].some(field => typeof account[field] === 'string' && account[field] !== '' && !/^v[0-9]+:/.test(account[field])));
            if (unprefixed) {
                const classification = await Swal.fire({ title: '明确旧凭据格式', text: '旧文件含无版本前缀的凭据。必须明确其来源，不会猜测或将解密失败当明文。请勿粘贴凭据。', input: 'select',
                    inputOptions: { plaintext: '已确认是明文（文件需受控保存）', encrypted: '已确认是旧加密密文（需保留旧密钥）' }, inputPlaceholder: '请选择已确认的格式',
                    inputValidator: selected => selected ? undefined : '请选择已确认的格式', showCancelButton: true, confirmButtonText: '使用所选格式', cancelButtonText: '取消' });
                if (!classification.isConfirmed) return;
                value.unprefixed = classification.value;
            }
        }
        const confirmed = await Swal.fire({ title: '确认导入账号配置', text: '仅按 accountId 合并，不按别名匹配。已有账号仅更新别名、邮件和凭据，保留现有 Worker 清单和其他元数据；新账号采用文件配置。整份验证失败则零写入，7 天凭据观察期禁止导入。请确认文件可信。', icon: 'warning', showCancelButton: true, confirmButtonText: '验证并导入', cancelButtonText: '取消' });
        if (!confirmed.isConfirmed) return;
        const result = await apiFetch('/api/accounts/import', { method: 'POST', body: JSON.stringify(value) });
        if (result.success !== true) throw new Error('缺少导入成功回执，请保留原请求并核对');
        await Swal.fire('导入已确认', '新增 ' + result.added + ' 个，按 ID 合并 ' + result.merged + ' 个，共 ' + result.total + ' 个。', 'success');
        await loadAccounts();
    } catch (e) {
        await Swal.fire('导入未确认', e.message + '；若请求响应丢失，请从待确认面板重试原始请求，不要重新选文件覆盖。', 'error');
    } finally {
        if (pinned) releaseConfigView('accounts');
        accountImportBusy = false;
    }
}

async function recoveryMode() {
    const response=await fetch('/api/reliability/recovery');
    if(!response.ok)throw new Error('无法确认备份恢复权威；已停止，不回退到旧 KV');
    const info=await response.json();
    if(!info||info.format!=='cfauto.recovery-workflow'||info.version!==1||!['legacy','authority'].includes(info.mode))throw new Error('备份恢复协议不完整；未读取或写入旧 KV');
    return info;
}
async function showAuthorityRecovery(info,operation) {
    if(!info.status||info.status.protocol!==1)throw new Error('权威状态不完整');
    const status=info.status;
    await Swal.fire({title:operation==='backup'?'完整权威备份':'受控权威恢复',icon:'info',confirmButtonText:'我了解，尚未执行',
        text:'当前代际：'+(status.generation||'尚未激活')+'；epoch：'+status.epoch+'；维护：'+(status.maintenance?'是':'否')+'。完整备份请使用独立维护 CLI archive-bundle-client.cjs；恢复先用 archive-bundle-upload.cjs 上传原归档，再经 maintenance-client.cjs 执行 generation_begin / generation_resume / generation_inspect / generation_activate。须独立认证、真实排空、完整备份、凭据与来源校验；上传不等于恢复。维护拒写不等于排空。尚未激活的实例必须先完成独立初始迁移，不能调用在线代际恢复。当前页面没有下载数据、发送恢复写入或收集维护密钥；旧 KV 备份不会覆盖 DO 权威。详见项目 docs/RELIABILITY_MAINTENANCE.md。'});
}

async function backupAll() {
    try {
        const mode=await recoveryMode();if(mode.mode==='authority'){await showAuthorityRecovery(mode,'backup');return;}
        await downloadEndpoint('/api/backup', 'worker-backup-' + today() + '.json', {
            title: '备份完成',
            text: '数据已下载（含加密密钥指纹，恢复时会校验）'
        });
    } catch (e) { Swal.fire('备份失败', e.message, 'error'); }
}

let restoreBusy = false;
function restorePreviewHtml(preview) {
    const c = preview.counts;
    const labels = { add: '新增', overwrite: '覆盖', skip: '保留', unsupported: '不支持', invalid: '无效' };
    const items = preview.items.map(item => '<li><code>' + safeHtml(item.key) + '</code>：' + labels[item.action] +
        (item.reason ? '（' + safeHtml(item.reason) + '）' : '') + '</li>').join('');
    return '<div class="restore-report"><p>新增 ' + c.add + ' / 覆盖 ' + c.overwrite + ' / 保留 ' + c.skip +
        ' / 不支持 ' + c.unsupported + ' / 无效 ' + c.invalid + '</p><p>' + safeHtml(preview.semantics) + '</p>' +
        '<p>密钥兼容性：' + ({ matched: '指纹匹配，内容仍须通过预检', mismatch: '不匹配，禁止恢复', 'legacy-checked': '旧备份无指纹，凭据检查失败见下表' }[preview.encryption] || '未知') + '</p>' +
        (preview.warning ? '<p>' + safeHtml(preview.warning) + '</p>' : '') +
        '<ul class="restore-items">' + items + '</ul>' + preview.errors.map(e => '<p>' + safeHtml(e) + '</p>').join('') + '</div>';
}
function restoreSnapshotLink(id) {
    if (!id) return '';
    return '<p>恢复前快照（保留 7 天）：<button type="button" class="restore-snapshot-link" data-act="downloadRestoreSnapshot" data-args="' + safeHtml(JSON.stringify([id])).replace(/"/g, '&quot;') +
        '">下载维护快照</button></p><p class="restore-id">快照 ID：' + safeHtml(id) + '</p>';
}
async function restoreBackup() {
    if (restoreBusy) return;
    restoreBusy = true;
    const button = document.querySelector('[data-act="restoreBackup"]');
    if (button) button.disabled = true;
    let snapshotId = null;
    try {
        const mode=await recoveryMode();if(mode.mode==='authority'){await showAuthorityRecovery(mode,'restore');return;}
        const picked = await pickJsonFile(5 * 1024 * 1024);
        if (!picked) return;
        const response = await fetch('/api/restore/preview', { method: 'POST', body: JSON.stringify(picked.data) });
        const checked = await response.json();
        if (!checked.preview) throw new Error(checked.msg || '预检失败');
        if (!response.ok || !checked.preview.valid) {
            await Swal.fire({ title: '预检未通过，尚未写入', html: restorePreviewHtml(checked.preview), icon: 'error' });
            return;
        }
        const confirmed = await Swal.fire({
            title: '确认恢复配置',
            html: '<p>文件：<b>' + safeHtml(picked.name) + '</b></p>' + restorePreviewHtml(checked.preview) +
                '<p>请先停止自动任务及其他编辑。执行时会重新校验并保存快照；KV 多键写入不是事务，不会自动回滚。</p><p>输入“恢复”继续。</p>',
            input: 'text', inputAttributes: { 'aria-label': '输入恢复以确认覆盖配置', autocomplete: 'off' },
            inputValidator: value => value === '恢复' ? undefined : '请输入“恢复”',
            icon: 'warning', showCancelButton: true, cancelButtonText: '取消', confirmButtonText: '确认恢复', confirmButtonColor: '#d33'
        });
        if (!confirmed.isConfirmed) return;
        snapshotId = crypto.randomUUID();
        // Non-sensitive ID only. Allows recovery after a lost response or tab reload; never store backup contents.
        sessionStorage.setItem('lastRestoreSnapshotId', snapshotId);
        const r = await apiFetch('/api/restore', { method: 'POST', headers: { 'X-Restore-Snapshot-ID': snapshotId }, body: JSON.stringify(picked.data) });
        snapshotId = r.snapshotId || null;
        const labels = { written: '写入已确认', unknown: '结果未知，可能已写入', notAttempted: '未执行' };
        const results = (r.results || []).map(item => '<li><code>' + safeHtml(item.key) + '</code>：' + labels[item.status] + '</li>').join('');
        await Swal.fire({ title: r.success ? '恢复完成' : '恢复部分失败，已停止',
            html: '<div class="restore-report"><p>已确认写入 ' + r.restored + ' 项。</p><p>' + safeHtml(r.msg || '') + '</p><ul class="restore-items">' + results + '</ul>' +
                restoreSnapshotLink(snapshotId) + '<p>' + safeHtml(r.warning || '') + '</p><p>维护恢复步骤见 README。请先保留报告和快照，再刷新页面查看最新配置（未保存草稿请另行处理）。</p></div>',
            icon: r.success ? 'success' : 'warning', confirmButtonText: '关闭报告'
        });
    } catch (e) {
        await Swal.fire({ title: '恢复未完成', html: '<div class="restore-report"><p>' + safeHtml(e.message) + '</p>' +
            (snapshotId ? '<p>请求未得到成功响应，不代表没有写入。不要直接重试整批；尝试下载快照并核对现值。</p>' + restoreSnapshotLink(snapshotId) : '<p>尚未发送恢复写入请求。</p>') + '</div>', icon: 'error' });
    } finally {
        restoreBusy = false;
        if (button) button.disabled = false;
    }
}
async function downloadRestoreSnapshot(snapshotId) {
    const id = snapshotId || sessionStorage.getItem('lastRestoreSnapshotId');
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return Swal.fire('暂无快照', '此标签页尚无恢复尝试。', 'info');
    try { const mode=await recoveryMode();if(mode.mode==='authority'){await showAuthorityRecovery(mode,'restore');return;}await downloadEndpoint('/api/restore/snapshot?id=' + encodeURIComponent(id), 'restore-snapshot-' + id + '.json'); }
    catch (e) { Swal.fire('快照暂不可用', e.message, 'warning'); }
}

registerActions({
    exportAccounts: exportAccounts,
    importAccounts: importAccounts,
    backupAll: backupAll,
    restoreBackup: restoreBackup,
    downloadRestoreSnapshot: downloadRestoreSnapshot
});
