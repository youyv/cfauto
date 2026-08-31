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
function closeModal(id) {
    const el = $(id);
    if (el) el.classList.add('hidden');
}
function openModal(id) {
    const el = $(id);
    if (el) el.classList.remove('hidden');
}
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
        const headers = Object.assign({}, init.headers);
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
async function apiFetch(url, init) {
    const r = await fetch(url, init);
    const text = await r.text();
    let data = null;
    if (text) {
        try { data = JSON.parse(text); }
        catch (e) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            throw new Error('服务端返回的不是合法 JSON');
        }
    }
    if (!r.ok) {
        const msg = (data && (data.msg || data.error)) || ('HTTP ' + r.status);
        throw new Error(msg);
    }
    return data;
}

// 登出：删除服务端会话 + 清 cookie + 回登录页
async function logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) { console.error('[logout]', e); }
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
