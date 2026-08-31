// ===== 部署逻辑 =====

async function previewDeploy(t) {
    openWorkbench();
    wbLog('🔍 预览部署 ' + t + '...', 'text-blue-400');
    try {
        const data = await apiFetch('/api/deploy/preview?type=' + encodeURIComponent(t));
        wbLog('📋 将影响 ' + data.accounts + ' 个账号, ' + data.workers + ' 个 Worker:', 'text-white');
        if (Array.isArray(data.details) && data.details.length) data.details.forEach(d => wbLog('   ' + d, 'text-slate-400'));
        else wbLog('   (无匹配的 Worker，请先在账号中配置)', 'text-orange-400');
        if (data.warning) wbLog('⚠️ ' + data.warning, 'text-orange-400');
        wbLog('✅ 预览完成，确认无误后可执行实际部署', 'text-green-400');
    } catch (e) { console.error('[previewDeploy]', e); wbLog('❌ 预览失败: ' + e.message, 'text-red-500'); }
}

function toggleEchToken() {
    const enabled = $('ech_token_enabled').checked;
    const input = $('ech_token_input');
    const status = $('ech_token_status');
    if (enabled) {
        input.disabled = false;
        input.classList.remove('opacity-50', 'cursor-not-allowed');
        status.textContent = '(已开启 - Token 将注入)';
        status.className = 'text-green-600 text-[10px] font-bold';
    } else {
        input.disabled = true;
        input.classList.add('opacity-50', 'cursor-not-allowed');
        status.textContent = '(关闭 - 不填入)';
        status.className = 'text-gray-400 text-[10px]';
    }
}

/** 部署中的模板集合 —— 防止同一模板并发部署（KV 读改写会互相覆盖） */
const _deploying = new Set();

async function deploy(t, sha) {
    if (_deploying.has(t)) return Swal.fire('提示', t + ' 正在部署中，请等待完成', 'info');
    const btn = $('btn_deploy_' + t);
    const ot = btn ? btn.innerText : '';
    _deploying.add(t);
    if (btn) { btn.innerText = '⏳ 部署中...'; btn.disabled = true; }

    try {
        const vars = collectVars(t);

        let echTokenEnabled = false;
        let echDisableWorkersDev = false;
        if (t === 'ech') {
            const tokenEnabled = $('ech_token_enabled').checked;
            const tokenVal = ($('ech_token_input').value || '').trim();
            echTokenEnabled = tokenEnabled && !!tokenVal;
            if (tokenVal) {
                const idx = vars.findIndex(v => v.key === 'TOKEN');
                if (idx !== -1) vars[idx].value = tokenVal;
                else vars.push({ key: 'TOKEN', value: tokenVal });
            }
            echDisableWorkersDev = $('ech_disable_workers_dev').checked;
        }

        openWorkbench();
        // 变量保存失败不阻断部署，但必须告知用户（变量仍随本次请求生效）
        try {
            await apiFetch('/api/settings?type=' + encodeURIComponent(t), { method: 'POST', body: JSON.stringify(vars) });
        } catch (e) {
            wbLog('⚠️ 变量保存失败: ' + e.message + '（变量仍随本次部署生效）', 'text-orange-400');
        }

        wbLog('⚡ Deploying ' + t + (sha && sha !== 'latest' ? ' @ ' + String(sha).substring(0, 7) : ' @ latest') + '...', 'text-yellow-400');
        const logs = await apiFetch('/api/deploy?type=' + encodeURIComponent(t), {
            method: 'POST',
            body: JSON.stringify({
                variables: vars,
                deletedVariables: state.deletedVars[t] || [],
                targetSha: sha || null,
                echTokenEnabled: echTokenEnabled,
                echDisableWorkersDev: echDisableWorkersDev
            })
        });
        if (!Array.isArray(logs)) throw new Error('返回格式异常');
        logs.forEach(l => wbLog('[' + (l.success ? 'OK' : 'ERR') + '] ' + l.name + ': ' + l.msg, l.success ? '' : 'text-red-400'));

        const failed = logs.filter(l => !l.success).length;
        if (failed === 0) {
            wbLog('✅ 全部成功（' + logs.length + ' 个目标）', 'text-green-400');
            state.deletedVars[t] = [];
        } else {
            wbLog('⚠️ ' + failed + '/' + logs.length + ' 个目标失败 — 版本号未推进，cron 会自动重试失败目标', 'text-orange-400');
        }
        setTimeout(() => { checkUpdate(t); checkDeployConfig(t); }, 1000);
    } catch (e) {
        console.error('[deploy]', e);
        wbLog('❌ 部署请求失败: ' + e.message, 'text-red-500');
    } finally {
        _deploying.delete(t);
        if (btn) { btn.innerText = ot; btn.disabled = false; }
    }
}

async function fix1101(t) {
    const confirm = await Swal.fire({
        title: '🔧 一键修复 1101',
        html: '<div class="text-left text-sm"><p class="mb-2">将对所有账号执行：</p><ol class="list-decimal pl-5 space-y-1"><li>📋 记录变量绑定 + 自定义域名</li><li>🗑️ 删除 Worker</li><li>🚀 用相同名称重建</li><li>♻️ 恢复所有变量值 + 自定义域名</li><li>🌐 重建成功后轮换子域名（每账号一次）</li></ol><p class="mt-3 text-orange-600 font-bold">⚠️ 子域名变更影响该账号下所有 Worker！</p><p class="mt-1 text-red-600 font-bold">⚠️ 绑定读取失败会中止该 Worker 的修复（保护既有 KV/secret）</p></div>',
        icon: 'warning', showCancelButton: true,
        confirmButtonText: '执行修复', cancelButtonText: '取消',
        confirmButtonColor: '#f97316'
    });
    if (!confirm.isConfirmed) return;
    const btn = $('btn_fix1101_' + t);
    const ot = btn ? btn.innerText : '';
    if (btn) { btn.innerText = '⏳ 修复中...'; btn.disabled = true; }
    openWorkbench();
    wbLog('🔧 正在修复 ' + t + ' 的 1101...', 'text-orange-400');
    try {
        const logs = await apiFetch('/api/fix_1101', { method: 'POST', body: JSON.stringify({ type: t }) });
        if (!Array.isArray(logs)) throw new Error('返回格式异常');
        logs.forEach(l => {
            const color = l.success ? 'text-green-300' : 'text-red-400';
            wbLog('[' + (l.success ? '✅' : '❌') + '] ' + l.name, color);
            if (l.msg) l.msg.split(' → ').forEach(s => wbLog('   ' + s, 'text-slate-400'));
        });
        setTimeout(() => { checkUpdate(t); checkDeployConfig(t); }, 1000);
    } catch (e) { console.error('[fix1101]', e); wbLog('❌ 修复请求失败: ' + e.message, 'text-red-500'); }
    if (btn) { btn.innerText = ot; btn.disabled = false; }
}

// ===== 批量部署 =====
let _lastFailedBatch = null;
let _batchRunning = false;

async function doBatchDeploy() {
    if (_batchRunning) return Swal.fire('提示', '批量部署正在进行中', 'info');
    const btn = $('btn_do_batch');
    const t = $('bd_template').value;
    const name = ($('bd_name').value || '').trim();
    const kvName = ($('bd_kv_name').value || '').trim();
    const enableKV = $('bd_enable_kv').checked;
    const useSavedVars = $('bd_use_saved_vars').checked;

    if (!name) return Swal.fire('提示', 'Worker 名称必填', 'warning');
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
        return Swal.fire('提示', 'Worker 名称仅允许小写字母、数字、连字符与下划线，长度 1-63，且不以连字符开头', 'warning');
    }
    if (enableKV && !kvName) return Swal.fire('提示', '开启 KV 绑定时必须填写 KV 名称', 'warning');
    const chks = document.querySelectorAll('.bd-acc-chk:checked');
    if (chks.length === 0) return Swal.fire('提示', '至少选择一个账号', 'warning');

    _batchRunning = true;
    btn.disabled = true;
    btn.innerText = '⏳ 准备中...';
    openWorkbench();
    wbLog('✨ 开始批量部署...', 'text-yellow-400');

    try {
        btn.innerText = '🚀 部署中...';
        const targetAccounts = Array.from(chks).map(c => c.value);
        const config = {};
        const uuidVal = $('bd_uuid').value;
        const uuidField = (TEMPLATES[t] || {}).uuidField;
        if (t === 'cmliu') config.ADMIN = $('bd_admin_pass').value;
        if (uuidField && uuidVal) config[uuidField] = uuidVal;

        let savedVars = null;
        if (useSavedVars) {
            wbLog('📦 读取已保存变量 (VARS_' + t + ')...', 'text-blue-300');
            try {
                const fetched = await apiFetch('/api/settings?type=' + encodeURIComponent(t));
                if (Array.isArray(fetched) && fetched.length > 0) {
                    savedVars = fetched;
                    wbLog('✅ 读取到 ' + savedVars.length + ' 个变量', 'text-green-300');
                    Object.entries(config).forEach(([k, v]) => {
                        if (!v) return;
                        const idx = savedVars.findIndex(sv => sv.key === k);
                        if (idx !== -1) savedVars[idx].value = v;
                        else savedVars.push({ key: k, value: v });
                    });
                } else {
                    wbLog('ℹ️ 无已保存变量，将使用模板默认结构', 'text-slate-400');
                }
            } catch (e) {
                console.error('[doBatchDeploy:savedVars]', e);
                wbLog('⚠️ 变量读取失败: ' + e.message + '，改用模板默认结构', 'text-orange-400');
            }
        }

        const logs = await apiFetch('/api/batch_deploy', {
            method: 'POST',
            body: JSON.stringify({
                template: t,
                workerName: name,
                kvName: kvName,
                config: config,
                targetAccounts: targetAccounts,
                disableWorkersDev: $('bd_disable_workers_dev').checked,
                customDomainPrefix: ($('bd_domain_prefix').value || '').trim(),
                enableKV: enableKV,
                savedVars: savedVars
            })
        });
        if (!Array.isArray(logs)) throw new Error('返回格式异常');

        logs.forEach(l => {
            if (l.success && l.msg && l.msg.startsWith('✅')) wbLog('✅ ' + l.name + ': ' + l.msg.replace('✅ ', ''), 'text-white');
            else wbLog('[' + (l.success ? 'OK' : 'ERR') + '] ' + l.name + ': ' + l.msg, l.success ? '' : 'text-red-400');
        });

        const failedItems = logs.filter(l => !l.success);
        _lastFailedBatch = failedItems.length > 0 ? {
            failedItems, template: t, workerName: name, kvName, enableKV, useSavedVars, config,
            customDomainPrefix: ($('bd_domain_prefix').value || '').trim(),
            disableWorkersDev: $('bd_disable_workers_dev').checked,
            savedVars: savedVars
        } : null;

        closeModal('batch_deploy_modal');
        await loadAccounts();

        if (_lastFailedBatch) {
            const r = await Swal.fire({
                title: '部分失败',
                text: '成功: ' + (logs.length - failedItems.length) + ' / 失败: ' + failedItems.length,
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: '🔄 重试失败项',
                cancelButtonText: '关闭',
                confirmButtonColor: '#f97316'
            });
            if (r.isConfirmed) retryFailedBatch();
        } else {
            Swal.fire('完成', '全部 ' + logs.length + ' 个目标部署成功', 'success');
        }
    } catch (e) {
        console.error('[doBatchDeploy]', e);
        Swal.fire('错误', '部署失败: ' + e.message, 'error');
        wbLog('❌ Error: ' + e.message, 'text-red-500');
    } finally {
        _batchRunning = false;
        btn.disabled = false;
        btn.innerText = '🚀 开始部署';
    }
}

async function showDeployJournal() {
    openWorkbench();
    wbLog('📋 加载部署日志...', 'text-blue-400');
    try {
        const journal = await apiFetch('/api/deploy_journal');
        if (!Array.isArray(journal) || journal.length === 0) {
            wbLog('📭 暂无部署记录', 'text-slate-400');
            return;
        }
        wbLog('─── 最近 ' + journal.length + ' 次部署 ───', 'text-white');
        journal.forEach(function (entry) {
            const time = new Date(entry.time).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            const shaShort = (entry.sha || '????').substring(0, 7);
            const allOk = entry.accounts === entry.total;
            wbLog(
                time + ' | ' + entry.type +
                ' | ' + shaShort +
                ' | ' + entry.accounts + '/' + entry.total + ' OK' +
                (entry.summary ? ' | ' + entry.summary : ''),
                allOk ? 'text-slate-400' : 'text-orange-400'
            );
            if (entry.failed && entry.failed.length) {
                wbLog('    ❌ 失败: ' + entry.failed.join(', '), 'text-red-400');
            }
        });
    } catch (e) { console.error('[showDeployJournal]', e); wbLog('❌ 日志加载失败: ' + e.message, 'text-red-500'); }
}

function openBatchDeployModal() {
    const list = $('bd_account_list');
    list.innerHTML = '';
    if (state.accounts.length === 0) {
        const tip = document.createElement('div');
        tip.className = 'col-span-2 text-xs text-orange-500';
        tip.textContent = '请先添加至少一个账号';
        list.appendChild(tip);
    }
    state.accounts.forEach((a, i) => {
        const div = document.createElement('div');
        div.className = 'flex items-center gap-1';
        const chk = document.createElement('input');
        chk.type = 'checkbox'; chk.value = a.alias; chk.className = 'bd-acc-chk';
        chk.id = 'bd_chk_' + i;
        chk.disabled = !a.globalKey;
        const label = document.createElement('label');
        label.setAttribute('for', chk.id);
        label.textContent = a.alias + (a.globalKey ? '' : '（密钥缺失）');
        if (!a.globalKey) label.className = 'text-gray-400';
        div.appendChild(chk); div.appendChild(label);
        list.appendChild(div);
    });
    $('bd_uuid').value = crypto.randomUUID();
    toggleBatchInputs();
    openModal('batch_deploy_modal');
}

function toggleBatchInputs() {
    const t = $('bd_template').value;
    $('bd_config_cmliu').classList.toggle('hidden', t !== 'cmliu');
    // UUID 输入对所有有 uuidField 的模板都有意义（cmliu 的 UUID 也走这里）
    const uuidField = (TEMPLATES[t] || {}).uuidField;
    $('bd_config_joey').classList.toggle('hidden', !uuidField);
    // 模板没有 KV 绑定名时禁用 KV 选项，避免创建一个绑不上的命名空间
    const kvCheck = $('bd_enable_kv');
    const supportsKv = !!(TEMPLATES[t] && TEMPLATES[t].kvBindingName);
    kvCheck.disabled = !supportsKv;
    if (!supportsKv) kvCheck.checked = false;
    else kvCheck.checked = t !== 'joey';
}

function retryFailedBatch() {
    if (!_lastFailedBatch) return Swal.fire('提示', '没有失败的部署记录', 'info');
    const { failedItems, template, workerName, kvName, enableKV, useSavedVars, config,
        customDomainPrefix, disableWorkersDev } = _lastFailedBatch;
    // 恢复表单字段，避免用户重新填写
    $('bd_template').value = template || 'cmliu';
    $('bd_name').value = workerName || '';
    $('bd_kv_name').value = kvName || '';
    $('bd_enable_kv').checked = !!enableKV;
    $('bd_use_saved_vars').checked = !!useSavedVars;
    $('bd_domain_prefix').value = customDomainPrefix || '';
    $('bd_disable_workers_dev').checked = !!disableWorkersDev;
    if (template === 'cmliu' && config && config.ADMIN) $('bd_admin_pass').value = config.ADMIN;
    if (config) {
        const uuidField = (TEMPLATES[template] || {}).uuidField;
        const uuidVal = uuidField ? config[uuidField] : '';
        if (uuidVal) $('bd_uuid').value = uuidVal;
    }
    toggleBatchInputs();
    openModal('batch_deploy_modal');
    // 只勾选失败的账号（在 modal 打开、列表重建之后）
    const failedAliases = failedItems.map(f => String(f.name).split(' ->')[0].trim());
    document.querySelectorAll('.bd-acc-chk').forEach(c => { c.checked = failedAliases.includes(c.value); });
    _lastFailedBatch = null;
}

// retryFailedBatch 不注册为 action：它只由 doBatchDeploy 的失败确认弹窗直接调用，
// HTML 里没有对应的 data-act 元素。注册一个永远不会被派发的动作只会让 verify.js
// 的「action ↔ data-act」双向检查失去意义。
registerActions({
    deploy: deploy,
    fix1101: fix1101,
    previewDeploy: previewDeploy,
    openBatchDeployModal: openBatchDeployModal,
    doBatchDeploy: doBatchDeploy,
    toggleBatchInputs: toggleBatchInputs,
    toggleEchToken: toggleEchToken,
    showDeployJournal: showDeployJournal
});
