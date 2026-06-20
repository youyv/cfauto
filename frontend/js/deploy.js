// ===== 部署逻辑 =====


async function previewDeploy(t) {
    const vars = []; document.querySelectorAll('.var-row-' + t).forEach(r => { const k = r.querySelector('.key').value; const v = r.querySelector('.val').value; const secret = r.querySelector('.is-secret').value === '1'; if(k) vars.push({key: k, value: v, secret: secret}); });
    openWorkbench();
    wbLog('🔍 预览部署 ' + t + '...', 'text-blue-400');
    try {
        const res = await fetch('/api/deploy/preview?type=' + t);
        const data = await res.json();
        wbLog('📋 将影响 ' + data.accounts + ' 个账号, ' + data.workers + ' 个 Worker:', 'text-white');
        if (data.details) data.details.forEach(d => wbLog('   ' + d, 'text-slate-400'));
        wbLog('✅ 预览完成，确认无误后可执行实际部署', 'text-green-400');
    } catch(e) { wbLog('❌ 预览失败: ' + e.message, 'text-red-500'); }
}

function toggleEchToken() {
    const enabled = document.getElementById('ech_token_enabled').checked;
    const input = document.getElementById('ech_token_input');
    const status = document.getElementById('ech_token_status');
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

async function deploy(t, sha='') {
   const btn = document.getElementById('btn_deploy_' + t); const ot = btn.innerText; btn.innerText = '⏳ 部署中...'; btn.disabled = true;
   const vars = []; document.querySelectorAll('.var-row-' + t).forEach(r => { const k = r.querySelector('.key').value; const v = r.querySelector('.val').value; const isSecret = r.querySelector('.is-secret').value === '1'; if(k) vars.push({key: k, value: v, secret: isSecret || undefined}); });

   let echTokenEnabled = false;
   let echDisableWorkersDev = false;
   if (t === 'ech') {
       const tokenEnabled = document.getElementById('ech_token_enabled').checked;
       const tokenVal = document.getElementById('ech_token_input').value.trim();
       echTokenEnabled = tokenEnabled && !!tokenVal;
       if (tokenVal) {
           const idx = vars.findIndex(v => v.key === 'TOKEN');
           if (idx !== -1) vars[idx].value = tokenVal;
           else vars.push({ key: 'TOKEN', value: tokenVal });
       }
       echDisableWorkersDev = document.getElementById('ech_disable_workers_dev').checked;
   }

   await fetch('/api/settings?type=' + t, {method: 'POST', body: JSON.stringify(vars)});
   openWorkbench();
   wbLog('⚡ Deploying ' + t + '...', 'text-yellow-400');
   try {
       const res = await fetch('/api/deploy?type=' + t, { method: 'POST', body: JSON.stringify({ variables: vars, deletedVariables: deletedVars[t], targetSha: sha, echTokenEnabled: echTokenEnabled, echDisableWorkersDev: echDisableWorkersDev }) });
       const logs = await res.json();
       logs.forEach(l => wbLog('[' + (l.success ? 'OK' : 'ERR') + '] ' + l.name + ': ' + l.msg, l.success ? '' : 'text-red-400'));
       deletedVars[t] = [];
       setTimeout(() => { checkUpdate(t); checkDeployConfig(t); }, 1000);
   } catch(e) { wbLog('Error: ' + e.message, 'text-red-500'); }
   btn.innerText = ot; btn.disabled = false;
}

async function fix1101(t) {
    const confirm = await Swal.fire({
        title: '🔧 一键修复 1101',
        html: '<div class="text-left text-sm"><p class="mb-2">将对所有账号执行：</p><ol class="list-decimal pl-5 space-y-1"><li>📋 记录变量绑定 + 自定义域名</li><li>🗑️ 删除 Worker</li><li>🌐 随机修改子域名</li><li>🚀 用相同名称重建</li><li>♻️ 恢复所有变量值 + 自定义域名</li></ol><p class="mt-3 text-orange-600 font-bold">⚠️ 子域名变更影响该账号下所有 Worker！</p></div>',
        icon: 'warning', showCancelButton: true,
        confirmButtonText: '执行修复', cancelButtonText: '取消',
        confirmButtonColor: '#f97316'
    });
    if (!confirm.isConfirmed) return;
    const btn = document.getElementById('btn_fix1101_' + t); const ot = btn.innerText; btn.innerText = '⏳ 修复中...'; btn.disabled = true;
    openWorkbench();
    wbLog('🔧 正在修复 ' + t + ' 的 1101...', 'text-orange-400');
    try {
        const res = await fetch('/api/fix_1101', { method: 'POST', body: JSON.stringify({ type: t }) });
        const logs = await res.json();
        logs.forEach(l => {
            const color = l.success ? 'text-green-300' : 'text-red-400';
            wbLog('[' + (l.success ? '✅' : '❌') + '] ' + l.name, color);
            if (l.msg) l.msg.split(' | ').forEach(s => wbLog('   ' + s, 'text-slate-400'));
        });
        setTimeout(() => { checkUpdate(t); checkDeployConfig(t); }, 1000);
    } catch(e) { wbLog('Error: ' + e.message, 'text-red-500'); }
    btn.innerText = ot; btn.disabled = false;
}

// ===== 批量部署 =====
let _lastFailedBatch = null;
async function doBatchDeploy() {
    const btn = document.getElementById('btn_do_batch');
    const t = document.getElementById('bd_template').value;
    const name = document.getElementById('bd_name').value;
    const kvName = document.getElementById('bd_kv_name').value;
    const enableKV = document.getElementById('bd_enable_kv').checked;
    const useSavedVars = document.getElementById('bd_use_saved_vars').checked;

    if (!name) return Swal.fire('提示', 'Worker名称必填', 'warning');
    if (enableKV && !kvName) return Swal.fire('提示', '开启 KV 绑定时必须填写 KV 名称', 'warning');

    btn.disabled = true;
    btn.innerText = "⏳ 准备中...";
    openWorkbench();
    wbLog('✨ 开始批量部署...', 'text-yellow-400');

    try {
       btn.innerText = "🚀 部署中...";
       const chks = document.querySelectorAll('.bd-acc-chk:checked');
       if(chks.length===0) throw new Error("至少选择一个账号");
       const targetAccounts = Array.from(chks).map(c => c.value);
       const config = {};
       if (t === 'cmliu') {
            config.admin = document.getElementById('bd_admin_pass').value;
            config.uuid = document.getElementById('bd_uuid').value;
       } else {
            config.uuid = document.getElementById('bd_uuid').value;
       }

        let savedVars = null;
        if (useSavedVars) {
            wbLog('📦 读取已保存变量 (VARS_' + t + ')...', 'text-blue-300');
            try {
                const vr = await fetch(`/api/settings?type=${t}`);
                savedVars = await vr.json();
                if (Array.isArray(savedVars) && savedVars.length > 0) {
                    wbLog(`✅ 读取到 ${savedVars.length} 个变量`, 'text-green-300');
                    Object.entries(config).forEach(([k, v]) => {
                        if (v) {
                            const idx = savedVars.findIndex(sv => sv.key === k);
                            if (idx !== -1) savedVars[idx].value = v;
                            else savedVars.push({ key: k, value: v });
                        }
                    });
                } else { savedVars = null; }
            } catch(e) { savedVars = null; }
        }

        const res = await fetch('/api/batch_deploy', {
             method: 'POST',
             body: JSON.stringify({
                 template: t,
                 workerName: name,
                 kvName: kvName,
                 config: config,
                 targetAccounts: targetAccounts,
                 disableWorkersDev: document.getElementById('bd_disable_workers_dev').checked,
                 customDomainPrefix: document.getElementById('bd_domain_prefix').value,
                 enableKV: enableKV,
                 savedVars: savedVars
             })
         });
        const logs = await res.json();
         logs.forEach(l => {
             if (l.success && l.msg.startsWith('✅')) wbLog(`✅ ${l.msg.replace('✅ ', '')}`, 'text-white');
             else wbLog(`[${l.success ? 'OK' : 'ERR'}] ${l.name}: ${l.msg}`, l.success ? '' : 'text-red-400');
         });

         const failedItems = logs.filter(l => !l.success);
         _lastFailedBatch = failedItems.length > 0 ? {
      failedItems, template: t, workerName: name, kvName, enableKV, useSavedVars, config,
      customDomainPrefix: document.getElementById('bd_domain_prefix').value,
      disableWorkersDev: document.getElementById('bd_disable_workers_dev').checked,
      savedVars: savedVars
    } : null;
         document.getElementById('batch_deploy_modal').classList.add('hidden');
         await loadAccounts();
         if (_lastFailedBatch) {
             Swal.fire({ title: '完成', html: '成功: ' + (logs.length - failedItems.length) + ' / 失败: ' + failedItems.length + '<br><button onclick="retryFailedBatch()" class="swal2-confirm swal2-styled" style="background-color:#f97316">🔄 重试失败项</button>', icon: 'warning', showConfirmButton: false });
         } else {
             Swal.fire('完成', '操作完成，请查看工作台', 'success');
         }

     } catch(e) {
         Swal.fire('错误', '部署失败: ' + e.message, 'error');
         wbLog(`❌ Error: ${e.message}`, 'text-red-500');
     }
    btn.disabled = false;
    btn.innerText = "🚀 开始部署";
}

function openBatchDeployModal() {
    const m = document.getElementById('batch_deploy_modal');
    const list = document.getElementById('bd_account_list');
    list.innerHTML = '';
    accounts.forEach(a => {
        const div = document.createElement('div');
        div.className = "flex items-center gap-1";
        div.innerHTML = `<input type="checkbox" value="${a.alias}" class="bd-acc-chk" id="chk_${a.alias}"><label for="chk_${a.alias}">${a.alias}</label>`;
        list.appendChild(div);
    });
    document.getElementById('bd_uuid').value = crypto.randomUUID();
    toggleBatchInputs();
    m.classList.remove('hidden');
}

function toggleBatchInputs() {
    const t = document.getElementById('bd_template').value;
    document.getElementById('bd_config_cmliu').classList.toggle('hidden', t !== 'cmliu');
    document.getElementById('bd_config_joey').classList.toggle('hidden', t !== 'joey');
    const kvCheck = document.getElementById('bd_enable_kv');
    if (t === 'joey') kvCheck.checked = false; else kvCheck.checked = true;
}

function retryFailedBatch() {
    if (!_lastFailedBatch) return Swal.fire('提示', '没有失败的部署记录', 'info');
    Swal.close();
    const { failedItems, template, workerName, kvName, enableKV, useSavedVars, config,
            customDomainPrefix, disableWorkersDev, savedVars } = _lastFailedBatch;
    const failedAliases = failedItems.map(f => f.name.split(' ->')[0]);
    // Re-check only the failed accounts AND restore form fields
    document.querySelectorAll('.bd-acc-chk').forEach(c => { c.checked = failedAliases.includes(c.value); });
    // 恢复表单字段，避免用户重新填写
    document.getElementById('bd_template').value = template || 'cmliu';
    document.getElementById('bd_name').value = workerName || '';
    document.getElementById('bd_kv_name').value = kvName || '';
    document.getElementById('bd_enable_kv').checked = !!enableKV;
    document.getElementById('bd_use_saved_vars').checked = !!useSavedVars;
    document.getElementById('bd_domain_prefix').value = customDomainPrefix || '';
    document.getElementById('bd_disable_workers_dev').checked = !!disableWorkersDev;
    if (template === 'cmliu' && config && config.admin) document.getElementById('bd_admin_pass').value = config.admin;
    if (config && config.uuid) document.getElementById('bd_uuid').value = config.uuid;
    toggleBatchInputs();
    document.getElementById('batch_deploy_modal').classList.remove('hidden');
    _lastFailedBatch = null;
}
