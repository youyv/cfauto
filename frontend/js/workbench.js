// ===== 工作台 =====

function openWorkbench() {
    document.getElementById('workbench_modal').classList.remove('hidden');
}
function closeWorkbench() {
    document.getElementById('workbench_modal').classList.add('hidden');
}
function wbLog(msg, colorClass) {
    const log = document.getElementById('workbench_log');
    const div = document.createElement('div');
    if (colorClass) div.className = colorClass;
    div.textContent = msg;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

// 工作台拖动
(function initDrag() {
    let isDragging = false, startX, startY, startLeft, startTop;
    document.addEventListener('mousedown', e => {
        const drag = document.getElementById('workbench_drag');
        if (!drag || !drag.contains(e.target) || e.target.tagName === 'BUTTON') return;
        const panel = document.getElementById('workbench_panel');
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        // 仅覆盖 translateY，保留 translateX(-50%) 水平居中
        panel.style.transform = 'translateX(-50%)';
        panel.style.top = rect.top + 'px';
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const panel = document.getElementById('workbench_panel');
        const panelW = panel.offsetWidth;
        const panelH = panel.offsetHeight;
        // 水平方向不再移动（保持 translateX 居中），仅约束垂直方向
        const newTop = Math.max(0, Math.min(startTop + e.clientY - startY, window.innerHeight - panelH));
        panel.style.top = newTop + 'px';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });
})();

// @exports
window.openWorkbench = openWorkbench;
window.closeWorkbench = closeWorkbench;
window.wbLog = wbLog;
