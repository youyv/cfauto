// ===== 工作台 =====

/** 工作台日志上限：超出后丢弃最旧的行，避免长时间运行后 DOM 膨胀 */
const WB_MAX_LINES = 500;

function openWorkbench() {
    openModal('workbench_modal');
}
function closeWorkbench() {
    closeModal('workbench_modal');
}
function wbLog(msg, colorClass) {
    const log = $('workbench_log');
    if (!log) return;
    const div = document.createElement('div');
    if (colorClass) div.className = colorClass;
    div.textContent = msg;
    log.appendChild(div);
    while (log.childElementCount > WB_MAX_LINES) log.removeChild(log.firstElementChild);
    log.scrollTop = log.scrollHeight;
}

// 工作台拖动（仅垂直，水平保持 translateX 居中）
(function initDrag() {
    let isDragging = false, startY, startTop;
    document.addEventListener('mousedown', e => {
        const drag = $('workbench_drag');
        if (!drag || !drag.contains(e.target) || e.target.tagName === 'BUTTON') return;
        const panel = $('workbench_panel');
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        // 仅覆盖 translateY，保留 translateX(-50%) 水平居中
        panel.style.transform = 'translateX(-50%)';
        panel.style.top = rect.top + 'px';
        startY = e.clientY;
        startTop = rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const panel = $('workbench_panel');
        const panelH = panel.offsetHeight;
        const newTop = Math.max(0, Math.min(startTop + e.clientY - startY, window.innerHeight - panelH));
        panel.style.top = newTop + 'px';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });
})();

// @exports
window.openWorkbench = openWorkbench;
window.wbLog = wbLog;

registerActions({
    openWorkbench: openWorkbench,
    closeWorkbench: closeWorkbench
});
