// ===== 版本历史 & 收藏 =====


async function openVersionHistory(type){ currentHistoryType=type; refreshHistory(); }

// 请求序号：并发时只接受最后一次请求的结果，防止慢响应覆盖快响应
let _historyReqId = 0;

async function refreshHistory() {
    const type = currentHistoryType; if(!type) return;
    const myReqId = ++_historyReqId;
    const limit = document.getElementById('history_limit_input').value || 10;
    const modal=document.getElementById('history_modal');const hList=document.getElementById('history_list');

    modal.classList.remove('hidden');
    document.getElementById('fav_panel_view').classList.add('hidden');
    document.getElementById('history_panel_view').classList.remove('hidden');

    hList.innerHTML='<div class="text-center text-gray-400 text-xs py-4">加载中...</div>';

    try{
      const[histRes,favRes]=await Promise.all([fetch(`/api/check_update?type=${type}&mode=history&limit=${limit}`),fetch(`/api/favorites?type=${type}`)]);
      const histData=await histRes.json();const favData=await favRes.json();

      // 竞态守卫：已有更新的请求发出，本次结果作废（防止慢响应覆盖快响应显示错类型）
      if (myReqId !== _historyReqId) return;

      window.currentFavData = Array.isArray(favData) ? favData : [];

      hList.innerHTML='';
      const latestBtn=document.createElement('div');
      latestBtn.className="bg-green-50 hover:bg-green-100 p-2 rounded border border-green-200 cursor-pointer transition mb-2";
      latestBtn.innerHTML=`<div class="flex justify-between items-center"><span class="font-bold text-green-700 text-xs">⚡ Always Latest (部署最新)</span></div>`;
      latestBtn.onclick=()=>{modal.classList.add('hidden');deploy(type,'latest');};
      hList.appendChild(latestBtn);

      if(histData.history && histData.history.length){
          histData.history.forEach(commit=>{
              const item={sha:commit.sha,date:commit.commit.committer.date,message:commit.commit.message};
              const isFav=window.currentFavData.find(f=>f.sha===item.sha);
              renderHistoryItem(type,item,hList,false,isFav);
          });
      } else {
          // 显式反馈：GitHub 拉取失败或无记录，避免"只有 Latest 按钮"的误导
          const tip=document.createElement('div');
          tip.className='text-xs text-orange-500 py-2';
          tip.textContent = histData.success === false
              ? ('历史获取失败: ' + (histData.msg || '未知错误'))
              : '暂无历史版本记录';
          hList.appendChild(tip);
      }
    }catch(e){
      if (myReqId !== _historyReqId) return;
      console.error('[refreshHistory]',e);
      hList.innerHTML='<div class="text-red-400 text-xs">网络错误: ' + safeHtml(e.message) + '</div>';
    }
}

function openFavoritesPanel() {
    document.getElementById('history_panel_view').classList.add('hidden');
    const panel = document.getElementById('fav_panel_view');
    const list = document.getElementById('fav_full_list');
    panel.classList.remove('hidden');
    panel.classList.add('flex');
    list.innerHTML = '';

    if(window.currentFavData && window.currentFavData.length > 0) {
        window.currentFavData.forEach(item => {
            renderHistoryItem(currentHistoryType, item, list, true, true);
        });
    } else {
        list.innerHTML = '<div class="text-center text-gray-400 text-xs py-4">暂无收藏</div>';
    }
}

function closeFavoritesPanel() {
    document.getElementById('fav_panel_view').classList.add('hidden');
    document.getElementById('fav_panel_view').classList.remove('flex');
    document.getElementById('history_panel_view').classList.remove('hidden');
}

function renderHistoryItem(type,item,container,isFavSection,isFavInHist){
    const shortSha=item.sha.substring(0,7);
    const date=new Date(item.date).toLocaleString();
    const isCurrent=deployConfigs[type]&&deployConfigs[type].currentSha===item.sha;
    const el=document.createElement('div');
    el.className=`group relative p-2 rounded border transition mb-1 flex gap-2 ${isCurrent?'bg-orange-50 border-orange-300':'bg-white border-gray-100 hover:border-blue-200'}`;

    const starBtn=document.createElement('button');
    starBtn.className=`text-sm focus:outline-none ${(isFavSection||isFavInHist)?'text-orange-400':'text-gray-300 hover:text-orange-400'}`;
    starBtn.innerHTML=(isFavSection||isFavInHist)?'★':'☆';
    starBtn.onclick=(e)=>{
        e.stopPropagation();
        toggleFavorite(type,item,(isFavSection||isFavInHist));
    };

    const content=document.createElement('div');
    content.className="flex-1 cursor-pointer overflow-hidden";
    content.innerHTML=`<div class="flex justify-between items-center mb-0.5"><span class="font-mono text-[10px] bg-slate-100 px-1 rounded text-slate-600">${safeHtml(shortSha)}</span><span class="text-[9px] text-gray-400">${safeHtml(date)}</span></div><div class="text-[10px] text-gray-700 truncate">${safeHtml(item.message)}</div>`;
    content.onclick=()=>{if(confirm(`确认回滚/锁定到版本 [${shortSha}]？`)){document.getElementById('history_modal').classList.add('hidden');deploy(type,item.sha);}};

    el.appendChild(starBtn);el.appendChild(content);container.appendChild(el);
}

async function toggleFavorite(type,item,isRemove){
    try {
        const w = await fetch(`/api/favorites?type=${type}`,{method:'POST',body:JSON.stringify({action:isRemove?'remove':'add',item:item})});
        if(!w.ok) throw new Error('HTTP ' + w.status);
        const r = await fetch(`/api/favorites?type=${type}`);
        if(!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        window.currentFavData = Array.isArray(d) ? d : [];
        if(!document.getElementById('fav_panel_view').classList.contains('hidden')) {
            openFavoritesPanel();
        } else {
            refreshHistory();
        }
    } catch(e) {
        console.error('[toggleFavorite]', e);
        if (typeof Swal !== 'undefined') Swal.fire('收藏操作失败', e.message, 'error');
    }
}

// @exports
window.openVersionHistory = openVersionHistory;
window.refreshHistory = refreshHistory;
window.toggleFavorite = toggleFavorite;
window.openFavoritesPanel = openFavoritesPanel;
window.closeFavoritesPanel = closeFavoritesPanel;
