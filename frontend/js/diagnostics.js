// ===== 系统诊断 & 源码查看 =====

/** 系统诊断：检查 KV 绑定与关键配置项存在性 */
async function runDiagnostics() {
    openWorkbench();
    wbLog('🩺 正在诊断系统配置...', 'text-blue-400');
    try {
        const d = await apiFetch('/api/diag');
        wbLog('─── 系统诊断结果 ───', 'text-white');
        if (d.__authority?.kind === 'durable_object') {
            wbLog('配置权威：Durable Object；代际 '+d.__authority.generation+' / epoch '+d.__authority.epoch, 'text-green-300');
            wbLog('配置域 '+d.__authority.domains+'；运行记录修订 '+d.__authority.runtimeRevision+'；会话KV不是业务权威。', 'text-slate-400');
            wbLog('旧密钥、旧代际、旧KV及备份全部保留；GC仅审计，不自动删除。', 'text-slate-400');
            wbLog('GITHUB_TOKEN：'+(d.__github_token_set?'已设置':'未设置（匿名限额）'), 'text-slate-400');
            renderDeployDrift(d.__deploy_drift);
            wbLog('权威诊断读取完成；元数据检查不能替代源码/绑定验收。', 'text-blue-300');
            return;
        }
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
    const clean = drifted.length === 0 && missing.length === 0 && unreadable.length === 0 && dr.evidence !== 'metadata_only';
    wbLog('  受管目标: ' + (dr.checked || 0) + ' 个' + (clean ? '（账本与实况一致）' : ''),
        clean ? 'text-green-300' : 'text-orange-400');
    drifted.forEach(function (l) { wbLog('  ⚠️ 可能存在时间戳漂移: ' + l, 'text-orange-400'); });
    missing.forEach(function (l) { wbLog('  ⚠️ 云端不存在: ' + l, 'text-orange-400'); });
    unreadable.forEach(function (u) { wbLog('  ⚠️ 无法核对: ' + u, 'text-orange-400'); });
    if (drifted.length > 0) wbLog('    ↳ 这些 Worker 的脚本比账本记录的部署时间还旧，只能提示可能存在漂移，尚不能据此判定源码/绑定未生效', 'text-slate-500');
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
// This is a conservative public-report filter, not a sanitizer for arbitrary source code.
const REPORT_SENSITIVE_KEY = /(?:token|key|secret|password|authorization|cookie|code|webhook)$/i;
function redactReportContext(value, ancestors = new Set()) {
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) return '[Circular]';
    ancestors.add(value);
    const result = Array.isArray(value) ? [] : Object.create(null);
    const secretVariable = value.secret === true || value.type === 'secret_text';
    Object.keys(value).forEach(key => {
        result[key] = REPORT_SENSITIVE_KEY.test(key) || (secretVariable && /^(?:value|text)$/i.test(key))
            ? '***' : redactReportContext(value[key], ancestors);
    });
    ancestors.delete(value);
    return result;
}
function redactForReport(s) {
    return String(s == null ? '' : s)
        // Quoted JSON/assignment values may contain spaces, escapes and short secrets.
        .replace(/((?:["'][\w-]*(?:token|key|secret|password|authorization|cookie|code|webhook)["']|\b[\w-]*(?:token|key|secret|password|authorization|cookie|code|webhook))\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '$1"***"')
        .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1***')
        .replace(/(\b[\w-]*(?:token|key|secret|password|authorization|cookie|code|webhook)\s*[=:]\s*)[^\s,;"'&}]+/gi, '$1***')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
        .replace(/\b[0-9a-fA-F]{32}\b/g, '***')
        .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '***');
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
        out.push(redactForReport(JSON.stringify(redactReportContext(context), null, 2)));
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
    if (typeof recentRequestTraces !== 'undefined' && recentRequestTraces.length) {
        out.push('### 最近请求追踪（不是可恢复任务）');
        out.push(fence + 'json');
        out.push(JSON.stringify(recentRequestTraces, null, 2));
        out.push(fence);
    }
    out.push('### 环境');
    out.push('- 版本: ' + (window.APP_VERSION || 'unknown'));
    const build = window.APP_BUILD_INFO;
    if (build) {
        out.push('- 构建: ' + build.buildId);
        out.push('- 提交: ' + (build.shortCommit || '未知') + '（' + (build.dirty === true ? '含未提交修改' : build.dirty === false ? '工作区干净' : 'Git 状态未知') + '）');
        out.push('- 来源输入指纹: ' + build.sourceSha256);
    } else out.push('- 构建: 未知（旧构建未提供来源信息）');
    out.push('- 此信息不代表已推送或已部署，线上状态需单独核验。');
    out.push('- 时间: ' + new Date().toISOString());
    out.push('- 页面: ' + location.origin);
    out.push('');
    out.push('---');
    out.push('*由 CF Auto 中控诊断模块生成（已自动脱敏，请在公开提交前人工复核）*');
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
    await copyToClipboard(report, '诊断报告已复制（已脱敏）');
    wbLog('✅ 诊断报告已复制到剪贴板', 'text-green-400');
}

/** 一键报障：预填 GitHub Issue，或只复制报告 */
function reportIssue() {
    const report = buildDebugReport('用户主动故障报障', '当前系统运行状态与近期工作台日志汇报', {});
    const issueUrl = 'https://github.com/' + PROJECT_REPO + '/issues/new'
        + '?title=' + encodeURIComponent('[Bug] 用户报障')
        + '&body=' + encodeURIComponent(report);
    Swal.fire({
        title: '故障报障',
        html: '<div class="text-left text-xs space-y-2">'
            + '<div class="text-gray-600">将打开 GitHub Issue 并预填诊断信息。已执行自动脱敏，未标记的敏感文本可能无法识别，请在公开提交前人工复核。</div>'
            + '<div class="text-gray-400">仓库: ' + safeHtml(PROJECT_REPO) + '</div>'
            + '</div>',
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: '<span data-ui-icon="rocket">🚀</span> 打开 Issue',
        cancelButtonText: '<span data-ui-icon="clipboard-list">📋</span> 只复制报告'
    }).then(function (r) {
        if (r.isConfirmed) window.open(issueUrl, '_blank');
        else if (r.dismiss === Swal.DismissReason.cancel) copyToClipboard(report, '报告已复制，可自行粘贴');
    });
}

registerActions({
    runDiagnostics: runDiagnostics,
    viewTemplateCode: viewTemplateCode,
    copyDiagnosticReport: copyDiagnosticReport,
    reportIssue: reportIssue
});
