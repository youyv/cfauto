// ===== 工作台 =====

/** 工作台日志上限：超出后丢弃最旧的行，避免长时间运行后 DOM 膨胀 */
const WB_MAX_LINES = 500;

/**
 * 工作台日志的文本环形缓冲。
 *
 * DOM 里的行会被上限裁掉，而「诊断报告」需要在事故发生后仍能取到最近的上下文 ——
 * 两者用途不同，因此单独保留一份纯文本历史（同样有上限）。
 */
const recentWbLogs = [];
const WB_RECENT_MAX = 200;

function openWorkbench() {
    openModal('workbench_modal');
}
function closeWorkbench() {
    closeModal('workbench_modal');
}
function wbLog(msg, colorClass) {
    recentWbLogs.push('[' + new Date().toLocaleTimeString() + '] ' + String(msg));
    if (recentWbLogs.length > WB_RECENT_MAX) recentWbLogs.shift();
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

// 未捕获的异步/运行错误也进工作台，否则「诊断报告」在最需要它的时候是空的。
// 只记录消息，不上报任何内容。
window.addEventListener('unhandledrejection', function (e) {
    const reason = e && e.reason;
    wbLog('❌ 未处理的异步错误: ' + ((reason && reason.message) || String(reason)), 'text-red-400');
});
window.addEventListener('error', function (e) {
    if (!e) return;
    wbLog('❌ 运行错误: ' + (e.message || e.type || 'unknown'), 'text-red-400');
});

registerActions({
    openWorkbench: openWorkbench,
    closeWorkbench: closeWorkbench
});
