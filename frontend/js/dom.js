// ===== DOM 缓存工具 =====
// 减少重复 document.getElementById 调用，提升可读性和微性能

const $cache = {};
function $(id) {
    return $cache[id] || ($cache[id] = document.getElementById(id));
}
// 清空缓存（动态添加/删除元素后调用）
function $clear(id) { delete $cache[id]; }
function $clearAll() { for (const k in $cache) delete $cache[k]; }
