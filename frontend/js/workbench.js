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
        panel.style.transform = 'none';
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const panel = document.getElementById('workbench_panel');
        panel.style.left = Math.max(0, startLeft + e.clientX - startX) + 'px';
        panel.style.top = Math.max(0, startTop + e.clientY - startY) + 'px';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });
})();
