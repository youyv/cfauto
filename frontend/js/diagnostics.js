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
        renderKvUsage(d.__kv_usage);
        renderDeployDrift(d.__deploy_drift);
        wbLog('✅ 诊断完成', 'text-green-400');
    } catch (e) {
        console.error('[runDiagnostics]', e);
        wbLog('❌ 诊断失败: ' + e.message, 'text-red-500');
    }
}

/**
 * KV 占用概览。
 *
 * 这块是「KV 会不会被撑爆」唯一可见的窗口：孤儿键与部署日志是两类会随使用时长
 * 增长的数据，其余键数量固定。孤儿数 > 0 只是说明还没到 24h 回收窗口，不是错误。
 */
function renderKvUsage(u) {
    if (!u || typeof u !== 'object') return;
    wbLog('─── KV 占用 ───', 'text-slate-500');
    if (u.error) { wbLog('  统计失败: ' + u.error, 'text-red-400'); return; }
    wbLog('  总键数: ' + u.totalKeys + (u.listComplete === false ? ' （未列完，实际更多）' : ''),
        u.listComplete === false ? 'text-orange-400' : 'text-slate-400');
    wbLog('  会话 / 限流（带 TTL 自动过期）: ' + u.sessions + ' / ' + u.rateLimits, 'text-slate-400');
    const orphan = u.orphanAccountVars;
    const hasOrphan = typeof orphan === 'number' && orphan > 0;
    wbLog('  账号级变量覆盖: ' + u.accountVars + '（其中孤儿 ' + orphan + '）',
        hasOrphan ? 'text-orange-400' : 'text-slate-400');
    if (hasOrphan) wbLog('    ↳ 孤儿键会在下一次 24h 回收窗口自动删除', 'text-slate-500');
    const kb = (Number(u.journalBytes) || 0) / 1024;
    wbLog('  部署日志: ' + u.journalEntries + ' 条 / ' + kb.toFixed(1) + ' KB（保留 ' + u.journalRetentionDays + ' 天）',
        kb > 512 ? 'text-orange-400' : 'text-slate-400');
    wbLog('  上次自动回收: ' + u.lastGc, 'text-slate-400');
}

/**
 * 部署实况 —— 账本（KV 里的 currentSha/deployTime）与 Cloudflare 上脚本真实修改时间的对照。
 *
 * 「面板显示已更新、实际没更新」此前完全不可见：日志里只有一片 OK。这里把两类失真直接
 * 摆出来 —— drifted 是账本记录了部署时间、但脚本比那个时间还旧（写入没落地）；missing
 * 是账本里有、Cloudflare 上却找不到。
 */
function renderDeployDrift(dr) {
    if (!dr || typeof dr !== 'object') return;
    wbLog('─── 部署实况 ───', 'text-slate-500');
    if (dr.error) { wbLog('  检测失败: ' + dr.error, 'text-red-400'); return; }
    const drifted = dr.drifted || [];
    const missing = dr.missing || [];
    const unreadable = dr.unreadable || [];
    const clean = drifted.length === 0 && missing.length === 0;
    wbLog('  受管目标: ' + (dr.checked || 0) + ' 个' + (clean ? '（账本与实况一致）' : ''),
        clean ? 'text-green-300' : 'text-orange-400');
    drifted.forEach(function (l) { wbLog('  ⚠️ 未生效: ' + l, 'text-orange-400'); });
    missing.forEach(function (l) { wbLog('  ⚠️ 云端不存在: ' + l, 'text-orange-400'); });
    unreadable.forEach(function (u) { wbLog('  ⚠️ 无法核对: ' + u, 'text-orange-400'); });
    if (drifted.length > 0) wbLog('    ↳ 这些 Worker 的脚本比账本记录的部署时间还旧，说明那次写入没有真正落地', 'text-slate-500');
    if (missing.length > 0) wbLog('    ↳ 账本里还记着它们，但 Cloudflare 上已经没有这个脚本了', 'text-slate-500');
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

// ===== 故障诊断 / 一键报障 =====

/** Issue 目标仓库（fork 后请改成自己的仓库） */
const PROJECT_REPO = 'youyv/cfauto';

/**
 * 报告脱敏。
 *
 * 报告会被粘贴到公开的 GitHub Issue，必须先把能识别个人/账号的信息抹掉：
 * 邮箱、32 位 Account ID、UUID、Bearer/令牌类长串。宁可多抹，不可泄漏。
 */
function redactForReport(s) {
    return String(s == null ? '' : s)
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
        .replace(/\b[0-9a-fA-F]{32}\b/g, '***')
        .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '***')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1***')
        .replace(/((?:token|key|secret|code)\s*[=:]\s*)[^\s,"']{6,}/gi, '$1***');
}

/** 组装可直接粘贴的 Markdown 诊断报告 */
function buildDebugReport(title, detail, context) {
    const fence = String.fromCharCode(96, 96, 96);
    const out = [];
    out.push('### 错误概述');
    out.push('**' + redactForReport(title) + '**');
    out.push('');
    out.push('### 详细报错信息');
    out.push(fence);
    out.push(redactForReport(detail || '（无）'));
    out.push(fence);
    if (context && Object.keys(context).length > 0) {
        out.push('');
        out.push('### 操作上下文');
        out.push(fence + 'json');
        out.push(redactForReport(JSON.stringify(context, null, 2)));
        out.push(fence);
    }
    const logs = (typeof recentWbLogs !== 'undefined' && Array.isArray(recentWbLogs)) ? recentWbLogs.slice(-25) : [];
    if (logs.length > 0) {
        out.push('');
        out.push('### 最近工作台日志');
        out.push(fence);
        out.push(redactForReport(logs.join('\n')));
        out.push(fence);
    }
    out.push('');
    out.push('### 环境');
    out.push('- 版本: ' + (window.APP_VERSION || 'unknown'));
    out.push('- 时间: ' + new Date().toISOString());
    out.push('- 页面: ' + location.origin);
    out.push('');
    out.push('---');
    out.push('*由 CF Auto 中控诊断模块生成（已脱敏）*');
    return out.join('\n');
}

/** 复制一份已脱敏的系统诊断报告 */
async function copyDiagnosticReport() {
    openWorkbench();
    wbLog('📋 正在生成诊断报告...', 'text-blue-400');
    let diag = null;
    try { diag = await apiFetch('/api/diag'); }
    catch (e) { diag = { error: (e && e.message) || String(e) }; }
    const report = buildDebugReport('系统诊断报告', '用户主动导出的诊断信息', { diag: diag });
    await copyToClipboard(report, '📋 诊断报告已复制（已脱敏）');
    wbLog('✅ 诊断报告已复制到剪贴板', 'text-green-400');
}

/** 一键报障：预填 GitHub Issue，或只复制报告 */
function reportIssue() {
    const report = buildDebugReport('用户主动故障报障', '当前系统运行状态与近期工作台日志汇报', {});
    const issueUrl = 'https://github.com/' + PROJECT_REPO + '/issues/new'
        + '?title=' + encodeURIComponent('[Bug] 用户报障')
        + '&body=' + encodeURIComponent(report);
    Swal.fire({
        title: '🐛 故障报障',
        html: '<div class="text-left text-xs space-y-2">'
            + '<div class="text-gray-600">将打开 GitHub Issue 并预填诊断信息（账号 ID / 邮箱 / 令牌已脱敏）。</div>'
            + '<div class="text-gray-400">仓库: ' + safeHtml(PROJECT_REPO) + '</div>'
            + '</div>',
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: '🚀 打开 Issue',
        cancelButtonText: '📋 只复制报告'
    }).then(function (r) {
        if (r.isConfirmed) window.open(issueUrl, '_blank');
        else if (r.dismiss === Swal.DismissReason.cancel) copyToClipboard(report, '📋 报告已复制，可自行粘贴');
    });
}

registerActions({
    runDiagnostics: runDiagnostics,
    viewTemplateCode: viewTemplateCode,
    copyDiagnosticReport: copyDiagnosticReport,
    reportIssue: reportIssue
});
