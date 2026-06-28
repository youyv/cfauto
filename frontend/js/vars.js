// ===== 变量管理 =====

function renderProxySelector(){
  const c=document.getElementById('ech_proxy_selector_container');
  c.innerHTML='';
  const sel=document.createElement('select');
  sel.id='ech_proxy_select';
  sel.className='w-full text-xs border rounded p-1 mb-1';
  sel.onchange=function(){ applyEchProxy(); };
  const defOpt=document.createElement('option');
  defOpt.value='';
  defOpt.textContent='-- Select ProxyIP --';
  sel.appendChild(defOpt);
  ECH_PROXIES.forEach(function(g){
    const grp=document.createElement('optgroup');
    grp.label=g.group;
    g.list.forEach(function(i){
      const o=document.createElement('option');
      o.value=i.split(' ')[0];
      o.textContent=i;
      grp.appendChild(o);
    });
    sel.appendChild(grp);
  });
  c.appendChild(sel);
}
function applyEchProxy(){ const v=document.getElementById('ech_proxy_select').value; if(v)addVarRow('ech','PROXYIP',v); }

// 使用 DOM API 构建变量行，避免 innerHTML 的 XSS 风险
function addVarRow(t,k,v,s){
  // Remove from deletedVars if this key was previously marked for deletion
  if(k && deletedVars[t]) { const idx = deletedVars[t].indexOf(k); if(idx !== -1) deletedVars[t].splice(idx, 1); }
  const c=document.getElementById('vars_'+t);
  const d=document.createElement('div');
  d.className='flex gap-1 items-center mb-1 var-row-'+t;

  const keyInput=document.createElement('input');
  keyInput.className='input-field w-1/4 key font-bold';
  keyInput.placeholder='Key';
  if(k) keyInput.value=k;
  d.appendChild(keyInput);

  const valInput=document.createElement('input');
  valInput.className='input-field w-2/4 val';
  valInput.placeholder='Val';
  if(v) valInput.value=v;
  d.appendChild(valInput);

  const secLabel=document.createElement('label');
  secLabel.className='text-[9px] flex items-center gap-0.5';
  const secChk=document.createElement('input');
  secChk.type='checkbox';
  secChk.className='secret-chk';
  secChk.title='标记为Secret变量';
  secChk.onchange=function(){ this.parentElement.nextElementSibling.value=this.checked?'1':''; };
  const secHidden=document.createElement('input');
  secHidden.type='hidden';
  secHidden.className='is-secret';
  d.appendChild(secHidden);if(s) { secChk.checked=true; secHidden.value='1'; }
  secLabel.appendChild(secChk);
  secLabel.appendChild(document.createTextNode('\uD83D\uDD12'));
  d.appendChild(secLabel);

  

  if(t==='cmliu'&&(k==='PROXYIP'||k==='DOH')){
    const pool=k==='DOH'
      ?["https://dns.jhb.ovh/joeyblog","https://doh.cmliussss.com/CMLiussss","cloudflare-ech.com"]
      :ECH_PROXIES.flatMap(g=>g.list);
    const sel=document.createElement('select');
    sel.className='w-4 border rounded text-[8px] bg-gray-50 cursor-pointer';
    sel.onchange=function(){ this.parentElement.querySelector('.val').value=this.value; };
    const defOpt=document.createElement('option');
    defOpt.text='\u25BC';
    sel.appendChild(defOpt);
    pool.forEach(function(u){
      const o=document.createElement('option');
      o.value=u.split(' ')[0];
      o.textContent=u;
      sel.appendChild(o);
    });
    d.appendChild(sel);
  }

  const delBtn=document.createElement('button');
  delBtn.className='text-gray-300 hover:text-red-500 px-1 font-bold';
  delBtn.textContent='\u00D7';
  delBtn.onclick=function(){ removeVarRow(this,t); };
  d.appendChild(delBtn);

  c.appendChild(d);
}
function removeVarRow(b,t){ const k=b.parentElement.querySelector('.key').value; if(k)deletedVars[t].push(k); b.parentElement.remove(); }

async function loadVars(t){ const c=document.getElementById(`vars_${t}`); c.textContent='loading...'; try{ const r=await fetch(`/api/settings?type=${t}`); const v=await r.json(); const m=new Map(); if(Array.isArray(v))v.forEach(x=>m.set(x.key,x.value)); TEMPLATES[t].defaultVars.forEach(k=>{ if(!m.has(k))m.set(k,k===TEMPLATES[t].uuidField?crypto.randomUUID():'') }); c.innerHTML=''; deletedVars[t]=[]; m.forEach((val,key)=>addVarRow(t,key,val)); }catch(e){ c.textContent='Load Error'; } }

function refreshUUID(t){ const k=TEMPLATES[t].uuidField; if(k)document.querySelectorAll(`.var-row-${t}`).forEach(r=>{ if(r.querySelector('.key').value===k){ const i=r.querySelector('.val'); i.value=crypto.randomUUID(); i.classList.add('bg-green-100'); setTimeout(()=>i.classList.remove('bg-green-100'),500); } }); }

// ===== 同步逻辑 =====
function selectSyncAccount(t) {
    const m = document.getElementById('sync_select_modal');
    const l = document.getElementById('sync_list');
    const v = accounts.filter(a => a[`workers_${t}`] && a[`workers_${t}`].length);
    l.innerHTML = '';
    v.forEach(a => {
        const b = document.createElement('button');
        b.className = "w-full text-left bg-slate-50 p-2 mb-1 text-xs border rounded hover:bg-blue-50";
        const strong=document.createElement('b'); strong.textContent=a.alias;
        b.appendChild(strong);
        b.appendChild(document.createTextNode(' -> '+a[`workers_${t}`][0]));
        b.onclick = () => doSync(a, t, a[`workers_${t}`][0]);
        l.appendChild(b);
    });
    m.classList.remove('hidden');
}

async function doSync(a, t, n) {
    document.getElementById('sync_select_modal').classList.add('hidden');
    if (!confirm('确认覆盖当前变量配置?')) return;
    const r = await fetch('/api/fetch_bindings', {
        method: 'POST',
        body: JSON.stringify({ accountId: a.accountId, email: a.email, globalKey: a.globalKey, workerName: n })
    });
    const d = await r.json();
    if (d.success) {
        const c = document.getElementById(`vars_${t}`);
        c.innerHTML = ''; deletedVars[t] = [];
        d.data.forEach(v => addVarRow(t, v.key, v.value));
        Swal.fire('同步成功', '变量已更新', 'success');
    } else { Swal.fire('同步失败', d.msg, 'error'); }
}

// ===== 版本检查 =====
async function previewDiff(t) {
    openWorkbench();
    wbLog('🔍 获取 ' + t + ' 版本差异...', 'text-blue-400');
    try {
        const r = await fetch('/api/diff?type=' + t);
        const d = await r.json();
        if (d.status === 'up-to-date') {
            wbLog('✅ ' + d.message + ' (' + d.localSha + ')', 'text-green-400');
        } else if (d.status === 'no_data') {
            wbLog('⚠️  ' + d.message, 'text-yellow-400');
        } else {
            wbLog('📋 ' + t + ' 版本对比: ' + d.localSha + ' → ' + d.remoteSha + ' (落后 ' + d.behindBy + ' 个提交)', 'text-white');
            if (d.commits && d.commits.length > 0) {
                wbLog('─── 上游变更记录 ───', 'text-slate-500');
                d.commits.forEach(function(cm) {
                    wbLog(cm.sha + ' | ' + cm.author + ' | ' + cm.message, 'text-slate-400');
                });
            }
        }
    } catch(e) { wbLog('❌ 差异获取失败: ' + e.message, 'text-red-500'); }
}

async function checkUpdate(t){
    const el=document.getElementById(`ver_${t}`);
    try{
        const r=await fetch(`/api/check_update?type=${t}`);
        const d=await r.json();

        if(!d.success) throw new Error(d.msg);

        const remoteDate = new Date(d.remote.date).toLocaleString([], {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
        let statusHtml = '';
        let localDateStr = '未部署';

        if (d.local && d.local.date) {
             localDateStr = new Date(d.local.date).toLocaleString([], {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
        }

        if(d.remote && (!d.local || d.remote.sha !== d.local.sha)) {
            statusHtml = `<div class="flex justify-between text-red-600 font-bold"><span>🚀 上游: ${remoteDate}</span><span class="animate-pulse">New!</span> <a href="#" onclick="previewDiff('${t}');return false" class="text-blue-500 underline font-normal">🔍差异</a></div>`;
        } else {
            statusHtml = `<div class="flex justify-between text-green-600"><span>✅ 上游: ${remoteDate}</span><span>Latest</span></div>`;
        }

        const localClass = (d.local && d.remote && d.local.sha === d.remote.sha) ? 'text-gray-500' : 'text-orange-500 font-bold';
        const localHtml = `<div class="flex justify-between ${localClass}"><span>💻 本地: ${localDateStr}</span><span>${d.mode==='fixed'?'🔒 Locked':''}</span></div>`;

        // safe: all template vars from trusted sources (DOM attrs/GitHub API/KV)
        el.innerHTML = statusHtml + localHtml;
    }catch(err){
        var reason = (err && err.message !== undefined) ? String(err.message) : (typeof err === 'string' ? err : 'Unknown');
        if (!reason) reason = '(empty)';
        if (reason.length > 50) reason = reason.substring(0, 50) + '...';
        el.textContent=''; var ws=document.createElement('span'); ws.className='text-red-400 text-[10px]'; ws.textContent='⚠️ '; el.appendChild(ws);
        el.appendChild(document.createTextNode(reason));
    }
}

async function checkDeployConfig(t){ try{ const r=await fetch('/api/deploy_config?type='+t); const c=await r.json(); deployConfigs[t]=c; const b=document.getElementById('badge_'+t); if(c.mode==='fixed'){ b.className='text-[9px] px-1.5 py-0.5 rounded text-white bg-orange-500 font-bold'; b.innerText='Locked'; }else{ b.className='text-[9px] px-1.5 py-0.5 rounded text-white bg-green-500'; b.innerText='Auto Update'; } }catch(e){ console.error('[checkDeployConfig]', t, e); } }

// @exports
window.renderProxySelector = renderProxySelector;
window.applyEchProxy = applyEchProxy;
window.addVarRow = addVarRow;
window.removeVarRow = removeVarRow;
window.loadVars = loadVars;
window.refreshUUID = refreshUUID;
window.checkUpdate = checkUpdate;
window.checkDeployConfig = checkDeployConfig;
window.selectSyncAccount = selectSyncAccount;
window.doSync = doSync;
window.previewDiff = previewDiff;
