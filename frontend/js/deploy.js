function collectDeployDraft(t, sha) {
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

    return { variables: vars, deletedVariables: [...(state.deletedVars[t] || [])], targetSha: sha || null, echTokenEnabled, echDisableWorkersDev };
}

// ===== 部署逻辑 =====

async function previewDeploy(t, sha) {
    openWorkbench();
    wbLog('🔍 预览部署 ' + t + '...', 'text-blue-400');
    try {
        const data = await apiFetch('/api/deploy/preview?type=' + encodeURIComponent(t), { method: 'POST', body: JSON.stringify(collectDeployDraft(t, sha)) });
        wbLog('📋 将影响 ' + data.accounts + ' 个账号, ' + data.workers + ' 个 Worker:', 'text-white');
        if (data.source) {
            wbLog('源码：' + data.source.repository + '/' + data.source.path + ' @ ' + data.source.ref + '；账本 SHA：' + (data.source.previousSha || '无'), 'text-slate-300');
            wbLog(data.source.note, 'text-orange-300');
        }
        const actions = { added: '新增', changed: '变更', removed: '移除绑定', unchanged: '保持', 'write-secret': '写入 Secret（原值不可比较）' };
        (data.targets || []).forEach(target => {
            wbLog(target.alias + ' -> [' + target.workerName + ']', 'text-white');
            wbLog('  源码：' + ({ changed: '将变更', unchanged: '相同', unknown: '无法核对' }[target.sourceAction] || '无法核对'), 'text-slate-300');
            if (target.status !== 'read') wbLog('⚠️ ' + target.reason, 'text-orange-300');
            (target.bindings || []).forEach(item => wbLog('  ' + item.name + ': ' + (actions[item.action] || item.action) + ' (' + (item.beforeType || '无') + ' → ' + (item.afterType || '无') + ')', 'text-slate-300'));
            if (target.clearedOverrides && target.clearedOverrides.length) wbLog('  将清除账号覆盖：' + target.clearedOverrides.join('、'), 'text-orange-300');
        });
        if (data.effect && t === 'ech') wbLog('ECH：Token 注入' + (data.effect.echTokenEnabled ? '开启' : '关闭') + '；workers.dev ' + (data.effect.disableWorkersDev ? '将关闭' : '不请求关闭'), 'text-slate-300');
        if (!data.workers) wbLog('无匹配的 Worker，请先配置账号', 'text-orange-300');
        if (data.note) wbLog(data.note, 'text-orange-300');
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
        if (status.textContent !== '(已开启 - Token 将注入)') status.textContent = '(已开启 - Token 将注入)';
        status.dataset.enabled = 'true';
        status.classList.add('font-bold');
    } else {
        input.disabled = true;
        input.classList.add('opacity-50', 'cursor-not-allowed');
        if (status.textContent !== '(关闭 - 不填入)') status.textContent = '(关闭 - 不填入)';
        status.dataset.enabled = 'false';
        status.classList.remove('font-bold');
    }
}

/** 部署中的模板集合 —— 防止同一模板并发部署（KV 读改写会互相覆盖） */
const _deploying = new Set();

async function deploy(t, sha) {
    if (_deploying.has(t)) return Swal.fire('提示', t + ' 正在部署中，请等待完成', 'info');
    const btn = $('btn_deploy_' + t);
    const restoreButton = beginButtonBusy(btn, ' 处理中...');
    _deploying.add(t);
    if (btn) setUiContent(btn, 'loader-circle', ' 部署中...');

    try {
        const draft = collectDeployDraft(t, sha);
        const vars = draft.variables;
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
            body: JSON.stringify(draft)
        });
        if (logs?.status === 'accepted' && trackAcceptedTask(logs)) return;
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
        restoreButton();
    }
}

const repairsInFlight = new Set();
async function fix1101(t) {
    if (repairsInFlight.has(t)) return;
    repairsInFlight.add(t);
    try { await confirmAndFix1101(t); }
    finally { repairsInFlight.delete(t); }
}
async function confirmAndFix1101(t) {
    let inventory;
    try { inventory = await apiFetch('/api/deploy/preview?type=' + encodeURIComponent(t)); }
    catch (error) { await Swal.fire('无法读取修复目标', error.message, 'error'); return; }
    if (!Array.isArray(inventory.targets) || !inventory.targets.length) { await Swal.fire('无修复目标', '请先配置目标 Worker。', 'info'); return; }
    const expectedTargets = inventory.targets.map(target => ({ accountId: target.accountId, workerName: target.workerName }));
    const targetList = '<ul class="text-left text-sm">' + inventory.targets.map(target => '<li>' + safeHtml(target.alias || '') + '（' + safeHtml(target.accountId) + '） / ' + safeHtml(target.workerName) + (target.subdomainRotationAllowed === false ? ' <span class="text-orange-600">保留中控账号子域名</span>' : '') + '</li>').join('') + '</ul>';
    const confirm = await Swal.fire({
        title: '一键修复 1101',
        html: targetList + '<div class="text-left text-sm"><p class="mb-2">将仅对上述目标执行（执行前重新核对清单）：</p><ol class="list-decimal pl-5 space-y-1"><li><span data-ui-icon="clipboard-list">📋</span> 记录变量绑定 + 自定义域名</li><li><span data-ui-icon="trash-2">🗑️</span> 删除 Worker</li><li><span data-ui-icon="rocket">🚀</span> 用相同名称重建</li><li><span data-ui-icon="refresh-cw">♻️</span> 尽力恢复变量与自定义域名（Secret 原值缺失时会在删除前中止，需先补齐；KV 命名空间不删除）</li><li><span data-ui-icon="globe">🌐</span> 重建成功后轮换普通账号子域名（每账号一次）；含中控等受保护资源的账号保留原子域名</li></ol><p class="mt-3 text-orange-600 font-bold"><span data-ui-icon="triangle-alert">⚠️</span> 子域名变更影响该账号下所有 Worker！</p><p class="mt-1 text-red-600 font-bold"><span data-ui-icon="triangle-alert">⚠️</span> 绑定或域名读取失败、Secret 原值缺失会在删除前中止修复</p></div>',
        icon: 'warning', showCancelButton: true,
        confirmButtonText: '执行修复', cancelButtonText: '取消',
        confirmButtonColor: '#f97316',
        input: 'text', inputLabel: '输入项目标识 ' + t + ' 确认删除并重建',
        inputPlaceholder: t, focusConfirm: false,
        inputAttributes: { autocomplete: 'off', spellcheck: 'false' },
        inputValidator: value => value === t ? undefined : '请输入完全一致的项目标识：' + t
    });
    if (!confirm.isConfirmed) return;
    const btn = $('btn_fix1101_' + t);
    const restoreButton = beginButtonBusy(btn, ' 处理中...');
    if (btn) setUiContent(btn, 'loader-circle', ' 修复中...');
    openWorkbench();
    wbLog('🔧 正在修复 ' + t + ' 的 1101...', 'text-orange-400');
    try {
        const logs = await apiFetch('/api/fix_1101', { method: 'POST', body: JSON.stringify({ type: t, expectedTargets, preserveProtectedSubdomains: true }) });
        if (logs?.status === 'accepted' && trackAcceptedTask(logs)) return;
        if (!Array.isArray(logs)) throw new Error('返回格式异常');
        logs.forEach(l => {
            const color = l.success ? 'text-green-300' : 'text-red-400';
            wbLog('[' + (l.success ? '✅' : '❌') + '] ' + l.name, color);
            if (l.msg) l.msg.split(' → ').forEach(s => wbLog('   ' + s, 'text-slate-400'));
        });
        setTimeout(() => { checkUpdate(t); checkDeployConfig(t); }, 1000);
    } catch (e) { console.error('[fix1101]', e); wbLog('❌ 修复请求失败: ' + e.message, 'text-red-500'); }
    finally { restoreButton(); }
}

// ===== 批量部署 =====
let _lastFailedBatch = null;
let _batchRunning = false;

async function collectBatchDraft() {
    const template = $('bd_template').value;
    const workerName = ($('bd_name').value || '').trim();
    const kvName = ($('bd_kv_name').value || '').trim();
    const enableKV = $('bd_enable_kv').checked;
    const useSavedVars = $('bd_use_saved_vars').checked;
    const targetAccounts = Array.from(document.querySelectorAll('.bd-acc-chk:checked')).map(c => c.value);
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(workerName)) throw new Error('Worker 名称仅允许小写字母、数字、连字符与下划线，长度 1-63，且以字母或数字开头');
    if (enableKV && !kvName) throw new Error('开启 KV 绑定时必须填写 KV 名称');
    if (!targetAccounts.length) throw new Error('至少选择一个账号');
    const config = {};
    const uuidField = (TEMPLATES[template] || {}).uuidField;
    if (template === 'cmliu') config.ADMIN = $('bd_admin_pass').value;
    if (uuidField && $('bd_uuid').value) config[uuidField] = $('bd_uuid').value;
    // Freeze every field before awaiting saved variables; a slow read must not mix two drafts.
    const draft = { template, workerName, kvName, config, targetAccounts, enableKV, useSavedVars,
        customDomainPrefix: ($('bd_domain_prefix').value || '').trim(),
        disableWorkersDev: $('bd_disable_workers_dev').checked, savedVars: null };
    if (useSavedVars) {
        const fetched = await apiFetch('/api/settings?type=' + encodeURIComponent(template));
        if (!Array.isArray(fetched)) throw new Error('已保存变量读取异常；已中止，未改用空配置部署');
        if (fetched.length) {
            draft.savedVars = fetched.map(v => ({ ...v }));
            Object.entries(config).forEach(([key, value]) => {
                if (!value) return;
                const existing = draft.savedVars.find(v => v.key === key);
                if (existing) existing.value = value;
                else draft.savedVars.push({ key, value });
            });
        }
    }
    return draft;
}

let _batchPreviewRunning = false;
async function previewBatchDeploy() {
    if (_batchPreviewRunning || _batchRunning) return;
    _batchPreviewRunning = true;
    const restore = beginButtonBusy($('btn_preview_batch'), ' 读取差异...');
    try {
        const draft = await collectBatchDraft();
        const data = await apiFetch('/api/deploy/preview?type=' + encodeURIComponent(draft.template), {
            method: 'POST', body: JSON.stringify({ batch: draft })
        });
        if (!data.success || !Array.isArray(data.targets)) throw new Error(data.msg || '预览返回格式异常');
        const lines = ['目标账号：' + data.accounts + '；源码：' + (data.source?.status === 'read' ? '已读取' : '无法确认')];
        const actions = { added: '新增', changed: '变更', removed: '移除', unchanged: '保持', 'write-secret': '写入 Secret（原值不可比较）' };
        data.targets.forEach(target => {
            lines.push(target.alias + ' / ' + target.workerName);
            if (target.status !== 'read') { lines.push('⚠️ ' + target.reason); return; }
            lines.push('Worker：' + (target.workerAction === 'create' ? '新建' : '覆盖现有 Worker') + '；KV：' + ({ disabled: '不绑定', reuse: '复用', create: '新建' }[target.kvAction] || '未知'));
            lines.push('源码：' + (actions[target.sourceAction] || '无法确认'));
            (target.bindings || []).forEach(item => lines.push('  ' + item.name + '：' + (actions[item.action] || item.action)));
            if (target.domain) lines.push('域名：' + target.domain);
            if (target.disableWorkersDev) lines.push('将请求关闭 workers.dev');
        });
        if (data.unresolved?.length) lines.push('⚠️ 未找到账号：' + data.unresolved.join('、'));
        lines.push(data.note || '预览不锁定后续部署');
        await Swal.fire({ title: '批量部署差异预览', text: lines.join('\n'), icon: 'info', confirmButtonText: '返回编辑',
            didOpen: () => { const content = Swal.getHtmlContainer(); if (content) { content.style.whiteSpace = 'pre-wrap'; content.style.textAlign = 'left'; } } });
    } catch (error) { await Swal.fire('预览失败', error.message, 'error'); }
    finally { restore(); _batchPreviewRunning = false; }
}

async function doBatchDeploy() {
    if (_batchRunning || _batchPreviewRunning) return Swal.fire('提示', '批量操作正在进行中', 'info');
    _batchRunning = true;
    const btn = $('btn_do_batch');
    const restore = beginButtonBusy(btn, ' 准备中...');
    try {
        const draft = await collectBatchDraft();
        const { template: t, workerName: name, kvName, enableKV, useSavedVars, config, savedVars } = draft;
        openWorkbench();
        setUiContent(btn, 'rocket', ' 部署中...');
        wbLog('✨ 开始批量部署...', 'text-yellow-400');
        const logs = await apiFetch('/api/batch_deploy', { method: 'POST', body: JSON.stringify(draft) });
        if (logs?.status === 'accepted' && trackAcceptedTask(logs)) return;
        if (!Array.isArray(logs)) throw new Error('返回格式异常');

        logs.forEach(l => {
            if (l.success && l.msg && l.msg.startsWith('✅')) wbLog('✅ ' + l.name + ': ' + l.msg.replace('✅ ', ''), 'text-white');
            else wbLog('[' + (l.success ? 'OK' : 'ERR') + '] ' + l.name + ': ' + l.msg, l.success ? '' : 'text-red-400');
        });

        const failedItems = logs.filter(l => !l.success);
        _lastFailedBatch = failedItems.length > 0 ? {
            failedItems, template: t, workerName: name, kvName, enableKV, useSavedVars, config,
            customDomainPrefix: draft.customDomainPrefix,
            disableWorkersDev: draft.disableWorkersDev,
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
                confirmButtonText: '<span data-ui-icon="refresh-cw">🔄</span> 重试失败项',
                cancelButtonText: '关闭',
                confirmButtonColor: '#f97316'
            });
            if (r.isConfirmed) retryFailedBatch();
        } else {
            const warningCount = logs.filter(l => String(l.msg || '').includes('⚠️')).length;
            Swal.fire(warningCount ? '部署完成（有警告）' : '完成', warningCount ? '脚本部署完成，但 ' + warningCount + ' 个目标有后续配置警告，请核对工作台详情。' : '全部 ' + logs.length + ' 个目标部署成功', warningCount ? 'warning' : 'success');
        }
    } catch (e) {
        console.error('[doBatchDeploy]', e);
        Swal.fire('错误', '部署失败: ' + e.message, 'error');
        wbLog('❌ Error: ' + e.message, 'text-red-500');
    } finally {
        _batchRunning = false;
        restore();
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
                (/^req_[a-f0-9]{24}$/.test(entry.taskId || '') ? ' | ' + entry.taskId : '') +
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
        const hasCred = !!(a.globalKey || a.apiToken);
        chk.disabled = !hasCred;
        const label = document.createElement('label');
        label.setAttribute('for', chk.id);
        label.textContent = a.alias + (hasCred ? '' : '（凭据缺失）');
        if (!hasCred) label.className = 'text-gray-400';
        div.appendChild(chk); div.appendChild(label);
        list.appendChild(div);
    });
    $('bd_uuid').value = crypto.randomUUID();
    toggleBatchInputs();
    openModal('batch_deploy_modal');
}

function toggleBatchInputs() {
    updateSelectIcon($('bd_template'));
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
    previewBatchDeploy: previewBatchDeploy,
    toggleBatchInputs: toggleBatchInputs,
    toggleEchToken: toggleEchToken,
    showDeployJournal: showDeployJournal
});
