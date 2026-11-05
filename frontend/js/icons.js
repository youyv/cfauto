// ===== 本地 Lucide 图标（形状与映射由 build.js 从 vendor/lucide 注入） =====
// 静态标记保留隐藏源文字；按钮正文不再按符号扫描，用户文字始终原样保留。
// 仅装饰静态标记与操作按钮，不扫描日志、输入、源码或账号/提交信息。
function decorateUiIcons(root) {
    const selector = 'button, [data-ui-icon]';
    const targets = [];
    if (root.nodeType === 1 && root.matches(selector)) targets.push(root);
    if (root.querySelectorAll) targets.push(...root.querySelectorAll(selector));
    for (const target of targets) {
        if (target.closest('svg, .ui-icon-source')) continue;
        if (target.hasAttribute('data-ui-icon')) {
            mountUiIcon(target, target.getAttribute('data-ui-icon'));
        }
        if (target.matches('button')) ensureButtonDescription(target);
    }
}

const UI_ICON_LABELS = {
    toggleTheme: '切换主题', logout: '退出登录', openWorkbench: '打开工作台',
    toggleTaskPanel: '展开或收起任务列表', closeTaskPanel: '收起任务列表',
    showTaskCatalog: '刷新任务列表并重新连接', moreTasks: '读取下一页任务',
    saveAutoConfig: '保存自动任务配置', deleteFromEdit: '删除账号', cancelEdit: '取消编辑',
    closeModal: '关闭窗口', closeWorkbench: '关闭工作台',
    openBatchDeployModal: '打开批量部署面板', openYxipGuarded: '打开反代落地配置',
    loadStats: '刷新所有账号的用量统计', resetFormForAdd: '添加新的 Cloudflare 账号',
    saveAccount: '保存当前账号配置', fetchZonesForAccount: '读取当前账号的域名列表',
    openVersionHistory: '查看版本历史与收藏', addVarRow: '添加一行变量',
    selectSyncAccount: '选择账号并同步 Worker 变量', refreshUUID: '重新生成 UUID',
    previewDeploy: '预览本次部署影响的账号与 Worker', deploy: '部署当前项目配置',
    fix1101: '修复 Worker 1101 错误', doBatchDeploy: '执行批量部署',
    doYxipDeploy: '部署所选反代落地节点', promptChangeSubdomain: '修改账号的 Workers 子域名',
    openFavoritesPanel: '查看收藏的版本', closeFavoritesPanel: '返回版本历史',
    clearWorkbenchLog: '清空工作台显示的日志', regenBatchUuid: '重新生成批量部署 UUID',
    exportAccounts: '导出账号配置，不包含其他中控设置', importAccounts: '从文件导入并合并账号配置',
    backupAll: '下载账号与中控配置备份', restoreBackup: '恢复备份并覆盖对应配置',
    selectAllAccounts: '选择全部账号', deselectAllAccounts: '取消全部账号选择',
    batchDeleteAccounts: '删除选中的账号配置', clearSearch: '清空账号搜索条件',
    saveUpstream: '保存上游仓库的文件路径与分支设置', loadUpstream: '重新读取上游配置'
};

function mountUiIcon(span, name) {
    if (span.querySelector('svg') || !Object.hasOwn(UI_ICON_PATHS, name)) return;
    const source = span.textContent;
    span.classList.add('ui-icon');
    span.setAttribute('data-ui-icon', name);
    span.setAttribute('aria-hidden', 'true');
    if (source === '★') span.classList.add('ui-icon-filled');
    if (source === '🔴') span.classList.add('ui-icon-cmliu');
    if (source === '🔵') span.classList.add('ui-icon-joey');
    if (source === '🟢') span.classList.add('ui-icon-ech');
    // Only trusted, build-time vendored SVG geometry enters innerHTML; never user data.
    span.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + UI_ICON_PATHS[name] + '</svg>';
    const original = document.createElement('span');
    original.className = 'ui-icon-source';
    original.textContent = source;
    span.appendChild(original);
}

let uiIconObserver;
function initUiIcons() {
    if (uiIconObserver) return;
    decorateUiIcons(document.body);
    document.querySelectorAll('select[data-select-icons]').forEach(updateSelectIcon);
    document.addEventListener('change', event => {
        if (event.target.matches('select[data-select-icons]')) updateSelectIcon(event.target);
    });
    uiIconObserver = new MutationObserver(records => {
        const roots = new Set();
        for (const record of records) {
            const parent = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (parent && parent.closest('[data-ui-icon], svg, .ui-icon-source')) continue;
            const button = parent && parent.closest('button');
            if (button) roots.add(button);
            for (const node of record.addedNodes || []) if (node.nodeType === 1) roots.add(node);
        }
        roots.forEach(root => { if (root.isConnected) decorateUiIcons(root); });
    });
    uiIconObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
}

/** Explicit icon names only. text is always a text node, never HTML or symbol markup. */
function setUiContent(element, name, text, options = {}) {
    element.replaceChildren();
    if (name && Object.hasOwn(UI_ICON_PATHS, name)) {
        const icon = document.createElement('span');
        icon.setAttribute('data-ui-icon', name);
        if (options.filled) icon.classList.add('ui-icon-filled');
        if (['cmliu', 'joey', 'ech'].includes(options.tone)) icon.classList.add('ui-icon-' + options.tone);
        mountUiIcon(icon, name);
        element.appendChild(icon);
    }
    element.appendChild(document.createTextNode(text));
    if (options.label) element.setAttribute('aria-label', options.label);
    if (element.matches('button')) ensureButtonDescription(element);
}

/** Preserve actual nodes (including SVG/listeners), not lossy text or untrusted HTML snapshots. */
function beginButtonBusy(button, text) {
    if (!button) return () => {};
    const nodes = [...button.childNodes];
    const disabled = button.disabled;
    const busy = button.getAttribute('aria-busy');
    let restored = false;
    setUiContent(button, 'loader-circle', text);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    return () => {
        if (restored) return;
        restored = true;
        button.replaceChildren(...nodes);
        button.disabled = disabled;
        if (busy === null) button.removeAttribute('aria-busy');
        else button.setAttribute('aria-busy', busy);
        ensureButtonDescription(button);
    };
}

// Explicit prefix helper for status headings: the remaining text may contain user data.
function setUiIconText(element, symbol, text) {
    element.textContent = '';
    if (symbol && UI_ICON_MAP[symbol]) {
        const icon = document.createElement('span');
        icon.setAttribute('data-ui-icon', UI_ICON_MAP[symbol]);
        icon.textContent = symbol;
        mountUiIcon(icon, UI_ICON_MAP[symbol]);
        element.appendChild(icon);
    }
    element.appendChild(document.createTextNode(text));
}

/** Native title provides delayed hover help, without clipping inside tables or drawers.
 * Preserve explicit descriptions; generated ones follow changing button text.
 */
const generatedButtonTitles = new WeakMap();
function ensureButtonDescription(button) {
    const content = button.cloneNode(true);
    content.querySelectorAll('[data-ui-icon], [aria-hidden="true"], svg, .ui-icon-source').forEach(node => node.remove());
    const text = content.textContent.trim();
    const explicitTitle = button.title && button.title !== generatedButtonTitles.get(button);
    const description = explicitTitle ? button.title
        : UI_ICON_LABELS[button.getAttribute('data-act')] || button.getAttribute('aria-label') || text;
    if (!explicitTitle && description) {
        button.title = description;
        generatedButtonTitles.set(button, description);
    }
    if (!text && description) button.setAttribute('aria-label', description);
}

// Native option elements must be text-only. Decorate the select, not its popup rows.
function updateSelectIcon(select) {
    const option = select.selectedOptions[0];
    const name = option && option.getAttribute('data-option-icon');
    if (name && UI_ICON_PATHS[name]) select.setAttribute('data-input-icon', name);
    else select.removeAttribute('data-input-icon');
    const tone = option && option.getAttribute('data-option-tone');
    if (name && UI_ICON_PATHS[name] && ['cmliu', 'joey', 'ech'].includes(tone)) select.setAttribute('data-icon-tone', tone);
    else select.removeAttribute('data-icon-tone');
}
