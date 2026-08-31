// ===== 版本历史 & 收藏 =====

async function openVersionHistory(type) {
    state.currentHistoryType = type;
    await refreshHistory();
}

// 请求序号：并发时只接受最后一次请求的结果，防止慢响应覆盖快响应
let _historyReqId = 0;

async function refreshHistory() {
    const type = state.currentHistoryType;
    if (!type) return;
    const myReqId = ++_historyReqId;
    const limitRaw = parseInt($('history_limit_input').value, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 10;
    const hList = $('history_list');

    openModal('history_modal');
    $('fav_panel_view').classList.add('hidden');
    $('history_panel_view').classList.remove('hidden');

    hList.innerHTML = '<div class="text-center text-gray-400 text-xs py-4">加载中...</div>';

    try {
        const [histResult, favResult] = await Promise.allSettled([
            apiFetch('/api/check_update?type=' + encodeURIComponent(type) + '&mode=history&limit=' + limit),
            apiFetch('/api/favorites?type=' + encodeURIComponent(type))
        ]);

        // 竞态守卫：已有更新的请求发出，本次结果作废（防止慢响应覆盖快响应显示错类型）
        if (myReqId !== _historyReqId) return;

        state.favData = (favResult.status === 'fulfilled' && Array.isArray(favResult.value)) ? favResult.value : [];

        hList.innerHTML = '';
        const latestBtn = document.createElement('div');
        latestBtn.className = 'bg-green-50 hover:bg-green-100 p-2 rounded border border-green-200 cursor-pointer transition mb-2';
        const latestInner = document.createElement('div');
        latestInner.className = 'flex justify-between items-center';
        const latestLabel = document.createElement('span');
        latestLabel.className = 'font-bold text-green-700 text-xs';
        latestLabel.textContent = '⚡ Always Latest (部署最新)';
        latestInner.appendChild(latestLabel);
        latestBtn.appendChild(latestInner);
        latestBtn.addEventListener('click', () => { closeModal('history_modal'); deploy(type, 'latest'); });
        hList.appendChild(latestBtn);

        if (histResult.status === 'rejected') {
            const tip = document.createElement('div');
            tip.className = 'text-xs text-red-500 py-2';
            tip.textContent = '历史获取失败: ' + (histResult.reason && histResult.reason.message);
            hList.appendChild(tip);
            return;
        }

        const histData = histResult.value;
        if (histData && Array.isArray(histData.history) && histData.history.length) {
            histData.history.forEach(commit => {
                const item = {
                    sha: commit.sha,
                    date: commit.commit && commit.commit.committer && commit.commit.committer.date,
                    message: commit.commit && commit.commit.message
                };
                const isFav = !!state.favData.find(f => f.sha === item.sha);
                renderHistoryItem(type, item, hList, false, isFav);
            });
        } else {
            // 显式反馈：GitHub 拉取失败或无记录，避免"只有 Latest 按钮"的误导
            const tip = document.createElement('div');
            tip.className = 'text-xs text-orange-500 py-2';
            tip.textContent = (histData && histData.success === false)
                ? ('历史获取失败: ' + (histData.msg || '未知错误'))
                : '暂无历史版本记录';
            hList.appendChild(tip);
        }
        if (favResult.status === 'rejected') {
            const tip = document.createElement('div');
            tip.className = 'text-[10px] text-orange-400 py-1';
            tip.textContent = '（收藏列表加载失败，星标状态可能不准确）';
            hList.appendChild(tip);
        }
    } catch (e) {
        if (myReqId !== _historyReqId) return;
        console.error('[refreshHistory]', e);
        hList.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'text-red-400 text-xs';
        err.textContent = '网络错误: ' + e.message;
        hList.appendChild(err);
    }
}

function openFavoritesPanel() {
    $('history_panel_view').classList.add('hidden');
    const panel = $('fav_panel_view');
    const list = $('fav_full_list');
    panel.classList.remove('hidden');
    panel.classList.add('flex');
    list.innerHTML = '';

    if (state.favData && state.favData.length > 0) {
        state.favData.forEach(item => {
            renderHistoryItem(state.currentHistoryType, item, list, true, true);
        });
    } else {
        list.innerHTML = '<div class="text-center text-gray-400 text-xs py-4">暂无收藏</div>';
    }
}

function closeFavoritesPanel() {
    const panel = $('fav_panel_view');
    panel.classList.add('hidden');
    panel.classList.remove('flex');
    $('history_panel_view').classList.remove('hidden');
}

function renderHistoryItem(type, item, container, isFavSection, isFavInHist) {
    if (!item || !item.sha) return;
    const shortSha = String(item.sha).substring(0, 7);
    const date = item.date ? new Date(item.date).toLocaleString() : '未知时间';
    const cfg = state.deployConfigs[type];
    const isCurrent = !!(cfg && cfg.currentSha === item.sha);
    const isFav = isFavSection || isFavInHist;

    const el = document.createElement('div');
    el.className = 'group relative p-2 rounded border transition mb-1 flex gap-2 ' +
        (isCurrent ? 'bg-orange-50 border-orange-300' : 'bg-white border-gray-100 hover:border-blue-200');

    const starBtn = document.createElement('button');
    starBtn.className = 'text-sm focus:outline-none ' + (isFav ? 'text-orange-400' : 'text-gray-300 hover:text-orange-400');
    starBtn.textContent = isFav ? '★' : '☆';
    starBtn.title = isFav ? '取消收藏' : '收藏此版本';
    starBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(type, item, isFav);
    });

    const content = document.createElement('div');
    content.className = 'flex-1 cursor-pointer overflow-hidden';

    const head = document.createElement('div');
    head.className = 'flex justify-between items-center mb-0.5';
    const shaTag = document.createElement('span');
    shaTag.className = 'font-mono text-[10px] bg-slate-100 px-1 rounded text-slate-600';
    shaTag.textContent = shortSha;
    head.appendChild(shaTag);
    if (isCurrent) {
        const cur = document.createElement('span');
        cur.className = 'text-[9px] bg-orange-200 text-orange-800 px-1 rounded ml-1';
        cur.textContent = '当前';
        head.appendChild(cur);
    }
    const dateEl = document.createElement('span');
    dateEl.className = 'text-[9px] text-gray-400';
    dateEl.textContent = date;
    head.appendChild(dateEl);
    content.appendChild(head);

    const msg = document.createElement('div');
    msg.className = 'text-[10px] text-gray-700 truncate';
    msg.textContent = item.message || '(无提交信息)';
    msg.title = item.message || '';
    content.appendChild(msg);

    content.addEventListener('click', async () => {
        const r = await Swal.fire({
            title: '回滚/锁定到 ' + shortSha + '？',
            text: '将以该版本部署，并把该模板切换为固定版本 (Locked) 模式',
            icon: 'warning', showCancelButton: true, confirmButtonText: '确认部署'
        });
        if (!r.isConfirmed) return;
        closeModal('history_modal');
        deploy(type, item.sha);
    });

    el.appendChild(starBtn);
    el.appendChild(content);
    container.appendChild(el);
}

async function toggleFavorite(type, item, isRemove) {
    try {
        await apiFetch('/api/favorites?type=' + encodeURIComponent(type), {
            method: 'POST',
            body: JSON.stringify({ action: isRemove ? 'remove' : 'add', item: item })
        });
        const d = await apiFetch('/api/favorites?type=' + encodeURIComponent(type));
        state.favData = Array.isArray(d) ? d : [];
        if (!$('fav_panel_view').classList.contains('hidden')) {
            openFavoritesPanel();
        } else {
            await refreshHistory();
        }
    } catch (e) {
        console.error('[toggleFavorite]', e);
        if (typeof Swal !== 'undefined') Swal.fire('收藏操作失败', e.message, 'error');
    }
}

registerActions({
    openVersionHistory: openVersionHistory,
    refreshHistory: refreshHistory,
    openFavoritesPanel: openFavoritesPanel,
    closeFavoritesPanel: closeFavoritesPanel
});
