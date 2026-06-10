// ===== 变量管理 =====

function renderProxySelector(){ const c=document.getElementById('ech_proxy_selector_container'); let h='<select id="ech_proxy_select" onchange="applyEchProxy()" class="w-full text-xs border rounded p-1 mb-1"><option value="">-- Select ProxyIP --</option>'; ECH_PROXIES.forEach(g=>{ h+=`<optgroup label="${g.group}">`; g.list.forEach(i=>h+=`<option value="${i.split(' ')[0]}">${i}</option>`); h+='</optgroup>'; }); c.innerHTML=h+'</select>'; }
function applyEchProxy(){ const v=document.getElementById('ech_proxy_select').value; if(v)addVarRow('ech','PROXYIP',v); }

function addVarRow(t,k='',v=''){ const c=document.getElementById(`vars_${t}`); const d=document.createElement('div'); d.className=`flex gap-1 items-center mb-1 var-row-${t}`; let h=''; if(t==='cmliu'&&(k==='PROXYIP'||k==='DOH')){ const options=k==='DOH'?["https://dns.jhb.ovh/joeyblog","https://doh.cmliussss.com/CMLiussss","cloudflare-ech.com"]:ECH_PROXIES.flatMap(g=>g.list); h=`<select onchange="this.previousElementSibling.value=this.value" class="w-4 border rounded text-[8px] bg-gray-50 cursor-pointer"><option>▼</option>${options.map(u=>`<option value="${u.split(' ')[0]}">${u}</option>`).join('')}</select>`; } d.innerHTML=`<input class="input-field w-1/3 key font-bold" placeholder="Key" value="${k}"><input class="input-field w-2/3 val" placeholder="Val" value="${v}">${h}<button onclick="removeVarRow(this,'${t}')" class="text-gray-300 hover:text-red-500 px-1 font-bold">×</button>`; c.appendChild(d); }
function removeVarRow(b,t){ const k=b.parentElement.querySelector('.key').value; if(k)deletedVars[t].push(k); b.parentElement.remove(); }

async function loadVars(t){ const c=document.getElementById(`vars_${t}`); c.innerHTML='<div class="text-center text-gray-300">...</div>'; try{ const r=await fetch(`/api/settings?type=${t}`); const v=await r.json(); const m=new Map(); if(Array.isArray(v))v.forEach(x=>m.set(x.key,x.value)); TEMPLATES[t].defaultVars.forEach(k=>{ if(!m.has(k))m.set(k,k===TEMPLATES[t].uuidField?crypto.randomUUID():'') }); c.innerHTML=''; deletedVars[t]=[]; m.forEach((val,key)=>addVarRow(t,key,val)); }catch(e){ c.innerHTML='Load Error'; } }

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
        b.innerHTML = `<b>${a.alias}</b> -> ${a[`workers_${t}`][0]}`;
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
async function checkUpdate(t){
    const el=document.getElementById(`ver_${t}`);
    try{
        const r=await fetch(`/api/check_update?type=${t}`);
        const d=await r.json();

        if(d.error) throw new Error(d.error);

        const remoteDate = new Date(d.remote.date).toLocaleString([], {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
        let statusHtml = '';
        let localDateStr = '未部署';

        if (d.local && d.local.date) {
             localDateStr = new Date(d.local.date).toLocaleString([], {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
        }

        if(d.remote && (!d.local || d.remote.sha !== d.local.sha)) {
            statusHtml = `<div class="flex justify-between text-red-600 font-bold"><span>🚀 上游: ${remoteDate}</span><span class="animate-pulse">New!</span></div>`;
        } else {
            statusHtml = `<div class="flex justify-between text-green-600"><span>✅ 上游: ${remoteDate}</span><span>Latest</span></div>`;
        }

        const localClass = (d.local && d.remote && d.local.sha === d.remote.sha) ? 'text-gray-500' : 'text-orange-500 font-bold';
        const localHtml = `<div class="flex justify-between ${localClass}"><span>💻 本地: ${localDateStr}</span><span>${d.mode==='fixed'?'🔒 Locked':''}</span></div>`;

        el.innerHTML = statusHtml + localHtml;
    }catch(err){
        el.innerHTML="<span class='text-red-400'>Check Fail</span>";
    }
}

async function checkDeployConfig(t){ try{ const r=await fetch(`/api/deploy_config?type=${t}`); const c=await r.json(); deployConfigs[t]=c; const b=document.getElementById(`badge_${t}`); if(c.mode==='fixed'){ b.className="text-[9px] px-1.5 py-0.5 rounded text-white bg-orange-500 font-bold"; b.innerText="🔒 Locked"; }else{ b.className="text-[9px] px-1.5 py-0.5 rounded text-white bg-green-500"; b.innerText="Auto Update"; } }catch(e){} }
