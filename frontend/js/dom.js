// ===== DOM 工具 + 事件委托 + CSRF =====

/**
 * $(id) — document.getElementById 的薄封装。
 *
 * 此前这里有一层 $cache 对象缓存元素引用：省下的时间可忽略，却要求每次 DOM 重建后手动
 * 调 $clear/$clearAll，漏调就会拿到已脱离文档的僵尸节点（renderTable / loadVars 都会重建
 * 子树）。改为直接查询，浏览器内部本身就有 id 索引。
 */
function $(id) {
    return document.getElementById(id);
}

// ===== 事件委托 =====
// HTML 里不再写内联 onclick 属性，改为 data-act 属性 + 可选的 data-args（JSON 数组）。
// 好处：① CSP 可以去掉 script-src 'unsafe-inline'；② 前端拆成外部文件后
// 内联处理器依赖的全局函数不会失效；③ 参数以 JSON 传递，不存在字符串拼接注入。
const ACTIONS = Object.create(null);

/** 注册一个可被 data-act 调用的动作 */
function registerActions(map) {
    for (const name in map) ACTIONS[name] = map[name];
}

/** 解析 data-args（JSON 数组），非法则视为无参 */
function parseActionArgs(el) {
    const raw = el.getAttribute('data-args');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
        console.error('[actions] data-args 不是合法 JSON:', raw, e);
        return [];
    }
}

function runAction(name, el, event) {
    const fn = ACTIONS[name];
    if (typeof fn !== 'function') {
        console.error('[actions] 未注册的动作:', name);
        return;
    }
    try {
        const result = fn.apply(null, parseActionArgs(el));
        if (result && typeof result.catch === 'function') {
            result.catch(e => {
                console.error('[actions] ' + name + ' 异步失败:', e);
                if (typeof Swal !== 'undefined') Swal.fire('操作失败', (e && e.message) || String(e), 'error');
            });
        }
    } catch (e) {
        console.error('[actions] ' + name + ' 失败:', e);
        if (typeof Swal !== 'undefined') Swal.fire('操作失败', (e && e.message) || String(e), 'error');
    }
}

document.addEventListener('click', function (e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    e.preventDefault();
    runAction(el.getAttribute('data-act'), el, e);
});

document.addEventListener('change', function (e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-act-change]') : null;
    if (!el) return;
    runAction(el.getAttribute('data-act-change'), el, e);
});

// ===== 通用动作 =====
// Modal dialogs are stacked; the floating workbench intentionally stays nonmodal.
const modalStack = [];
let modalInertState = [];

function dialogFocusables(el) {
    return Array.from(el.querySelectorAll('a[href], button, input, select, textarea, [tabindex], summary'))
        .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]')
            && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
}
function focusDialog(el) {
    // The first control is the close/cancel button, never a destructive confirm.
    const target = dialogFocusables(el)[0] || el;
    target.focus({ preventScroll: true });
}
function topModal() {
    return modalStack.length ? modalStack[modalStack.length - 1].el : null;
}
function hasSweetAlertDialog() {
    return typeof Swal !== 'undefined' && Swal.isVisible() && !Swal.getPopup().classList.contains('swal2-toast');
}
function refreshModalInert() {
    // Restore exactly the original inert values, including pre-existing inert UI.
    modalInertState.forEach(([el, inert]) => { el.inert = inert; });
    modalInertState = [];
    const top = topModal();
    if (!top) return;
    Array.from(document.body.children).forEach(el => {
        // SweetAlert owns its own focus trap; never make its portal inert.
        if (el === top || el.contains(top) || el.classList.contains('swal2-container')
            || ['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName)) return;
        modalInertState.push([el, el.inert]);
        el.inert = true;
    });
}
function closeModal(id) {
    const el = $(id);
    if (!el) return;
    const index = modalStack.findIndex(entry => entry.el === el);
    const wasTop = el === topModal();
    const entry = index >= 0 ? modalStack.splice(index, 1)[0] : null;
    el.classList.add('hidden');
    if (entry) el.style.zIndex = entry.zIndex;
    refreshModalInert();
    if (!wasTop || hasSweetAlertDialog()) return;
    const opener = entry.opener;
    const top = topModal();
    if (opener && opener.isConnected && !opener.matches(':disabled') && !opener.closest('[inert]')
        && opener.getClientRects().length && getComputedStyle(opener).visibility !== 'hidden'
        && (!top || top.contains(opener))) {
        opener.focus({ preventScroll: true });
    } else if (top) {
        focusDialog(top);
    } else {
        // Account rows can be re-rendered or removed while a dialog is open.
        const fallback = $('theme_btn');
        if (fallback) fallback.focus({ preventScroll: true });
    }
}
function openModal(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('hidden');
    if (el.getAttribute('role') !== 'dialog') return;
    const index = modalStack.findIndex(entry => entry.el === el);
    // Reopening the same dialog must not replace its original return target.
    const entry = index >= 0 ? modalStack.splice(index, 1)[0]
        : { el, opener: document.activeElement, zIndex: el.style.zIndex };
    modalStack.push(entry);
    modalStack.forEach((item, i) => { item.el.style.zIndex = String(60 + i); });
    refreshModalInert();
    if (!hasSweetAlertDialog()) focusDialog(el);
}
document.addEventListener('keydown', e => {
    const top = topModal();
    if (!top || hasSweetAlertDialog() || e.isComposing) return;
    // Let local search handling consume the first Escape before closing its dialog.
    if (e.key === 'Escape' && e.target.matches('[data-escape-clear]') && e.target.value) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeModal(top.id);
    } else if (e.key === 'Tab') {
        const nodes = dialogFocusables(top);
        const first = nodes[0] || top, last = nodes[nodes.length - 1] || top;
        if (!nodes.length || !top.contains(document.activeElement) || document.activeElement === top
            || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
        }
    }
}, true);
document.addEventListener('focusin', e => {
    const top = topModal();
    if (top && !hasSweetAlertDialog() && !top.contains(e.target)) focusDialog(top);
});
function clearWorkbenchLog() {
    const log = $('workbench_log');
    if (log) log.textContent = '';
}
function regenBatchUuid() {
    const el = $('bd_uuid');
    if (el) el.value = crypto.randomUUID();
}

// ===== CSRF 安全 =====
// 从非 HttpOnly 的 __Host-csrf cookie 读取 token（登录时由服务端下发，与会话绑定）
function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)__Host-csrf=([^;]*)/);
    return m ? m[1] : '';
}
// 全局拦截 fetch：写请求自动附带 X-CSRF-Token 头（服务端 checkCsrf 校验）
const _origFetch = window.fetch;
window.fetch = function (url, init) {
    init = init || {};
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const csrf = getCsrfToken();
        const headers = init.headers && typeof init.headers.entries === 'function' ? Object.fromEntries(init.headers.entries()) : Array.isArray(init.headers) ? Object.fromEntries(init.headers) : Object.assign({}, init.headers);
        if (csrf) headers['X-CSRF-Token'] = csrf;
        // 请求体是 JSON 字符串时补 Content-Type（此前全靠服务端宽松解析）
        if (typeof init.body === 'string' && !headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
        }
        init.headers = headers;
    }
    return _origFetch.call(this, url, init);
};

/**
 * 统一的 JSON 请求助手：检查 r.ok、解析 JSON、失败时抛出带服务端消息的 Error。
 * 消除各处重复的 `if(!r.ok) throw new Error('HTTP '+r.status)` 并让后端的
 * `{success:false,msg}` 真正传达到用户面前。
 */
const recentRequestTraces = [];
const configProtocol = typeof frontendModules !== 'undefined' && frontendModules.createConfigProtocol
    ? frontendModules.createConfigProtocol({ newKey: () => crypto.randomUUID(), baseUrl: () => location.href }) : null;
const taskProtocol = typeof frontendModules !== 'undefined' && frontendModules.createTaskProtocol
    ? frontendModules.createTaskProtocol({newKey: () => crypto.randomUUID(), baseUrl: () => location.href, enabled: () => !!configProtocol?.isEnabled()}) : null;
function acceptConfigView(domain, value) { if (configProtocol) configProtocol.accept(domain, value); }
function pinConfigView(domain) { if (configProtocol) configProtocol.pin(domain); }
function releaseConfigView(domain) { if (configProtocol) configProtocol.release(domain); }
async function apiFetch(url, init) {
    try {
    const prepared = configProtocol ? configProtocol.prepare(url, init) : { init, ticket: null };
    const taskPrepared = taskProtocol ? taskProtocol.prepare(url, prepared.init) : {init: prepared.init, ticket: null};
    init = taskPrepared.init;
    const r = await fetch(url, init);
    const requestId = r.headers.get('X-Request-ID');
    if (/^req_[a-f0-9]{24}$/.test(requestId || '')) {
        // No query, request body, credentials or caller-controlled IDs in diagnostics.
        recentRequestTraces.push({ id: requestId, method: (init && init.method) || 'GET', path: new URL(url, location.href).pathname, status: r.status });
        if (recentRequestTraces.length > 25) recentRequestTraces.shift();
    }
    const text = await r.text();
    let data = null;
    if (text) {
        try { data = JSON.parse(text); }
        catch (e) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            throw new Error('服务端返回的不是合法 JSON');
        }
    }
    if (taskProtocol) taskProtocol.finish(taskPrepared.ticket, r.status, data);
    if (configProtocol) {
        configProtocol.finish(prepared.ticket, r.status, data);
        if (r.ok && !prepared.ticket) configProtocol.observe(url, data, r.headers);
    }
    if (!r.ok) {
        const msg = (data && (data.msg || data.error)) || ('HTTP ' + r.status);
        const error = new Error(redactForReport(msg));
        error.status = r.status;
        if (/^req_[a-f0-9]{24}$/.test(requestId || '')) error.message += ' [请求 ' + requestId + ']';
        throw error;
    }
    return data;
    } finally { renderPendingConfigSaves(); if (typeof renderPendingTaskSubmissions === 'function') renderPendingTaskSubmissions(); }
}

// ===== 时间 =====
/** 相对时间：把 ISO 时间串转成「3 分钟前」这类可读文本；解析失败时原样返回 */
function timeAgo(input) {
    if (!input) return '';
    const t = new Date(input).getTime();
    if (!Number.isFinite(t)) return String(input);
    const sec = Math.floor((Date.now() - t) / 1000);
    if (sec < 0) return new Date(t).toLocaleString();
    if (sec < 60) return '刚刚';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
    if (sec < 2592000) return Math.floor(sec / 86400) + ' 天前';
    return new Date(t).toLocaleDateString();
}

// ===== 剪贴板 =====
// 诊断报告、订阅链接这类文本需要「一键复制」；clipboard API 在 http 或旧浏览器不可用，
// 因此保留 textarea + execCommand 的回落路径。
function fallbackCopy(text, successMsg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (typeof Swal !== 'undefined') {
        if (ok) Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: successMsg, showConfirmButton: false, timer: 2000 });
        else Swal.fire('复制失败', '请手动选择文本复制', 'error');
    }
    return ok;
}

function copyToClipboard(text, successMsg = '已复制到剪贴板') {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(function () {
            if (typeof Swal !== 'undefined') Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: successMsg, showConfirmButton: false, timer: 2000 });
            return true;
        }).catch(function () { return fallbackCopy(text, successMsg); });
    }
    return Promise.resolve(fallbackCopy(text, successMsg));
}

// 登出：删除服务端会话 + 清 cookie + 回登录页
async function logout() {
    if (!await configDrafts.confirmDiscard()) return;
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) { console.error('[logout]', e); }
    configDrafts.allowUnload = true; // 已确认放弃，避免再弹一次原生离开提示。
    location.reload();
}

// 所有前端模块被 build.js 拼接进同一个脚本作用域，跨文件直接同名调用即可。
// 此前每个文件尾部都有一段 `window.xxx = xxx` 的「导出」，但全项目没有任何一处读
// `window.xxx`（只有 window.fetch / innerWidth / matchMedia 这些平台属性被读），
// 纯属冗余，已全部删除。verify.js 会拦住这种写法回归。
//
// openModal 也不再注册为 action：HTML 里没有引用它的 data-act 元素，
// 各处都是直接调用 openModal('xxx_modal')。
registerActions({
    logout: logout,
    closeModal: closeModal,
    clearWorkbenchLog: clearWorkbenchLog,
    regenBatchUuid: regenBatchUuid
});
/** Pending saves expose domain names only, never frozen bodies or credentials. */
function renderPendingConfigSaves() {
    const panel = $('config_pending_panel');
    if (!panel || !configProtocol) return;
    const pending = configProtocol.pending();
    panel.hidden = pending.length === 0;
    panel.replaceChildren();
    if (!pending.length) return;
    const title = document.createElement('strong'); title.textContent = '有配置保存尚待确认'; panel.appendChild(title);
    pending.forEach(item => {
        const row = document.createElement('div'); row.className = 'flex items-center gap-2 mt-1';
        const label = document.createElement('span'); label.textContent = item.domain + (item.conflict ? '：版本冲突，请明确重新读取并合并；草稿保留。' : '：可重试原保存意图，当前新草稿不会被自动提交。'); row.appendChild(label);
        if (!item.conflict) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'border rounded px-2 py-1'; button.textContent = '重试原保存';
            button.addEventListener('click', async () => {
                button.disabled = true;
                try { const retry = configProtocol.retry(item.domain); await apiFetch(retry.url, retry.init); await Swal.fire('原保存已确认', '仅确认了之前的意图；未覆盖当前表单草稿。继续编辑前请核对或重新读取。', 'success'); }
                catch (e) { await Swal.fire('尚未确认', e.message, 'warning'); }
                finally { renderPendingConfigSaves(); }
            }); row.appendChild(button);
        }
        panel.appendChild(row);
    });
}
