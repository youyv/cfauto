// ===== DOM 缓存工具 =====
// 减少重复 document.getElementById 调用，提升可读性和微性能

const $cache = {};
function $(id) {
    return $cache[id] || ($cache[id] = document.getElementById(id));
}
// 清空缓存（动态添加/删除元素后调用）
function $clear(id) { delete $cache[id]; }
function $clearAll() { for (const k in $cache) delete $cache[k]; }

// @exports
window.$ = $;
window.$clear = $clear;
window.$clearAll = $clearAll;


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
        if (csrf) {
            init.headers = Object.assign({}, init.headers, { 'X-CSRF-Token': csrf });
        }
    }
    return _origFetch.call(this, url, init);
};

// 登出：删除服务端会话 + 清 cookie + 回登录页
async function logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) { console.error('[logout]', e); }
    location.reload();
}

// @exports
window.logout = logout;
