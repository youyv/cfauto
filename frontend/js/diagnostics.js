// ===== 系统诊断 & 源码查看 =====

/** 系统诊断：检查 KV 绑定与关键配置项存在性 */
async function runDiagnostics() {
    openWorkbench();
    wbLog('🩺 正在诊断系统配置...', 'text-blue-400');
    try {
        const d = await apiFetch('/api/diag');
        wbLog('─── 系统诊断结果 ───', 'text-white');
        wbLog('KV 绑定: ' + (d.__kv_bound ? '✅ 已绑定' : '❌ 未绑定'), d.__kv_bound ? 'text-green-300' : 'text-red-400');
        wbLog('ACCESS_CODE: ' + (d.__access_code_set ? '✅ 已设置' : '❌ 未设置'), d.__access_code_set ? 'text-green-300' : 'text-red-400');
        wbLog('GITHUB_TOKEN: ' + (d.__github_token_set ? '✅ 已设置' : '⚠️ 未设置（GitHub API 限额 60/小时）'), d.__github_token_set ? 'text-green-300' : 'text-orange-400');
        wbLog('ENCRYPTION_SECRET: ' + (d.__encryption_secret_set
            ? '✅ 已设置（改 ACCESS_CODE 不影响已存凭证）'
            : '⚠️ 未设置（密钥由 ACCESS_CODE 派生，改密码会导致所有 API Key 解密失败）'),
            d.__encryption_secret_set ? 'text-green-300' : 'text-orange-400');
        if (d.__encryption_fingerprint) {
            wbLog('加密密钥指纹: ' + d.__encryption_fingerprint + '（导出/备份文件会带上它用于校验）', 'text-slate-400');
        }
        wbLog('─── KV 键状态 ───', 'text-slate-500');
        Object.keys(d).forEach(function (k) {
            if (k.startsWith('__') || k === 'success') return;
            const v = String(d[k]);
            const cls = v === '(exists)' ? 'text-green-300' : (v === '(not set)' ? 'text-orange-400' : 'text-red-400');
            wbLog('  ' + k + ': ' + v, cls);
        });
        wbLog('✅ 诊断完成', 'text-green-400');
    } catch (e) {
        console.error('[runDiagnostics]', e);
        wbLog('❌ 诊断失败: ' + e.message, 'text-red-500');
    }
}

/** 查看上游模板源码摘要（行数 / 大小 / 前若干行） */
async function viewTemplateCode() {
    const opts = {};
    Object.keys(TEMPLATES).forEach(function (t) { opts[t] = (TEMPLATES[t].name || t); });
    const picked = await Swal.fire({
        title: '查看上游源码',
        input: 'select',
        inputOptions: opts,
        inputPlaceholder: '选择模板',
        showCancelButton: true,
        confirmButtonText: '拉取',
        cancelButtonText: '取消'
    });
    if (!picked.isConfirmed || !picked.value) return;
    const t = picked.value;

    openWorkbench();
    wbLog('📄 正在拉取 ' + t + ' 上游源码...', 'text-blue-400');
    try {
        const d = await apiFetch('/api/get_code?type=' + encodeURIComponent(t));
        if (!d.success || typeof d.code !== 'string') throw new Error(d.msg || '返回格式异常');
        const lines = d.code.split('\n');
        const kb = (d.code.length / 1024).toFixed(1);
        wbLog('─── ' + t + ' 源码摘要 ───', 'text-white');
        wbLog('总行数: ' + lines.length + ' | 大小: ' + kb + ' KB', 'text-slate-300');
        wbLog('--- 前 15 行 ---', 'text-slate-500');
        lines.slice(0, 15).forEach(function (ln, i) {
            wbLog(String(i + 1).padStart(3, ' ') + ' | ' + ln.slice(0, 160), 'text-slate-400');
        });
        wbLog('✅ 拉取完成（完整源码请到 GitHub 查看）', 'text-green-400');
    } catch (e) {
        console.error('[viewTemplateCode]', e);
        wbLog('❌ 源码拉取失败: ' + e.message, 'text-red-500');
    }
}

registerActions({
    runDiagnostics: runDiagnostics,
    viewTemplateCode: viewTemplateCode
});
