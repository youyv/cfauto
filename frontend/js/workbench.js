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
    renderWorkbenchMessage(div, String(msg));
    log.appendChild(div);
    while (log.childElementCount > WB_MAX_LINES) log.removeChild(log.firstElementChild);
    log.scrollTop = log.scrollHeight;
}

/** Decorate only a known leading status symbol, never scan account names or log payloads.
 * setUiIconText retains the source symbol in a hidden text node; report buffers stay raw.
 */
function renderWorkbenchMessage(element, message) {
    const indent = message.match(/^\s*/)[0];
    const body = message.slice(indent.length);
    const symbol = Object.keys(UI_ICON_MAP).sort((a, b) => b.length - a.length)
        .find(key => body.startsWith(key));
    if (!symbol) {
        element.textContent = message;
        return;
    }
    setUiIconText(element, symbol, body.slice(symbol.length));
    if (indent) element.insertBefore(document.createTextNode(indent), element.firstChild);
}

// 工作台自由拖动：鼠标、触屏、触控笔共用 Pointer Events。
(function initDrag() {
    let dragState = null;
    function positionPanel(panel, left, top) {
        // 保持窗口在视口内；即使窗口比视口高，也让标题栏可触达。
        panel.style.left = Math.max(0, Math.min(left, window.innerWidth - panel.offsetWidth)) + 'px';
        panel.style.top = Math.max(0, Math.min(top, window.innerHeight - panel.offsetHeight)) + 'px';
    }
    function endDrag(event) {
        if (!dragState || (event.pointerId !== undefined && event.pointerId !== dragState.pointerId)) return;
        const { handle, pointerId } = dragState;
        dragState = null;
        handle.classList.remove('is-dragging');
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    }
    document.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.isPrimary === false || dragState) return;
        const handle = $('workbench_drag');
        const panel = $('workbench_panel');
        if (!handle || !panel || !handle.contains(e.target)) return;
        // SVG / span 等按钮后代也必须排除，避免点图标时误拖动。
        if (e.target.closest('button, a, input, select, textarea, [data-act]')) return;
        const rect = panel.getBoundingClientRect();
        panel.style.transform = 'none';
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        dragState = { panel, handle, pointerId: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('is-dragging');
        e.preventDefault();
    });
    document.addEventListener('pointermove', e => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;
        const d = dragState;
        positionPanel(d.panel, d.left + e.clientX - d.x, d.top + e.clientY - d.y);
    });
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    document.addEventListener('lostpointercapture', endDrag);
    window.addEventListener('blur', endDrag);
    window.addEventListener('resize', () => {
        endDrag({});
        const panel = $('workbench_panel');
        if (!panel || !panel.offsetWidth || panel.style.transform !== 'none') return;
        const rect = panel.getBoundingClientRect();
        positionPanel(panel, rect.left, rect.top);
    });
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
