/**
 * 构建产物验证 — 静态检查源码结构的完整性。
 * 用法: node verify.js
 *
 * 与旧版的关键区别：文件清单不再硬编码。
 *  - 后端文件：递归扫描 src/（排除自动生成的 frontend-bundle.ts）
 *  - 前端 JS：从 build.js 的 jsFiles 数组解析，与真实构建顺序同源
 * 这样新增/删除文件不会再出现「清单漏同步」这类假通过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const errors = [];
const warnings = [];

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** 递归列出目录下所有指定后缀的文件（返回相对 ROOT 的 posix 路径） */
function walk(dir, ext) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, ext));
        else if (entry.name.endsWith(ext)) out.push(rel(full));
    }
    return out;
}

// ===== 0. 从 build.js 解析前端 JS 清单（单一真相源）=====
const buildJs = fs.readFileSync(path.join(ROOT, 'build.js'), 'utf-8');
const jsListMatch = buildJs.match(/const jsFiles = \[([\s\S]*?)\]/);
if (!jsListMatch) {
    errors.push('build.js 中未找到 jsFiles 数组，无法推导前端文件清单');
}
const frontendJsFiles = jsListMatch
    ? jsListMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).map(f => 'frontend/js/' + f)
    : [];

const backendFiles = walk(path.join(ROOT, 'src'), '.ts').filter(f => !f.includes('frontend-bundle'));
const staticFiles = ['frontend/index.html', 'frontend/css/style.css', 'build.js', 'wrangler.toml', 'package.json', 'tsconfig.json'];
const expectedFiles = [...backendFiles, ...frontendJsFiles, ...staticFiles];

console.log('=== 1. File existence ===');
let allExist = true;
for (const f of expectedFiles) {
    if (!fs.existsSync(path.join(ROOT, f))) {
        console.log('  ❌ MISSING: ' + f);
        errors.push('Missing file: ' + f);
        allExist = false;
    }
}
if (allExist) console.log('  ✅ All ' + expectedFiles.length + ' files present (' + backendFiles.length + ' TS, ' + frontendJsFiles.length + ' frontend JS)');

// 反向检查：frontend/js 下存在但 build.js 未引用的文件（会被静默漏打包）
const actualJs = walk(path.join(ROOT, 'frontend/js'), '.js');
const orphanJs = actualJs.filter(f => !frontendJsFiles.includes(f));
if (orphanJs.length > 0) {
    console.log('  ❌ frontend/js 中存在未被 build.js 引用的文件: ' + orphanJs.join(', '));
    errors.push('Unreferenced frontend JS (will not be bundled): ' + orphanJs.join(', '));
} else {
    console.log('  ✅ frontend/js 全部文件都已在 build.js 的 jsFiles 中');
}

// ===== 2. 检查 TS import 路径 =====
console.log('\n=== 2. Import path validation ===');
for (const f of backendFiles) {
    const content = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    const imports = content.match(/from\s+['"](\.\.?\/[^'"]+)['"]/g);
    if (!imports) continue;
    for (const imp of imports) {
        const modulePath = imp.match(/from\s+['"]([^'"]+)['"]/)[1];
        if (modulePath.includes('frontend-bundle')) continue;  // 构建时生成
        const resolved = path.resolve(ROOT, path.dirname(f), modulePath);
        const found = [resolved + '.ts', resolved + '.tsx', resolved + '/index.ts'].some(c => fs.existsSync(c));
        if (!found) {
            console.log('  ❌ ' + f + ': import "' + modulePath + '" 未找到');
            errors.push('Unresolved import: ' + f + ' -> ' + modulePath);
        }
    }
}
console.log('  ✅ Import check complete');

// ===== 3. 前端 JS 语法校验（真解析，而非数反引号）=====
console.log('\n=== 3. Frontend JS syntax check ===');
const vm = require('vm');
for (const f of frontendJsFiles) {
    const content = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    try {
        new vm.Script(content, { filename: f });
    } catch (e) {
        console.log('  ❌ ' + f + ': ' + e.message);
        errors.push('Syntax error in ' + f + ': ' + e.message);
    }
}
// 拼接后整体再解析一次：单文件合法但拼接后可能出现重复的顶层 const 声明
const concatenated = frontendJsFiles.map(f => fs.readFileSync(path.join(ROOT, f), 'utf-8')).join('\n\n');
try {
    new vm.Script(concatenated, { filename: 'concatenated-frontend.js' });
    console.log('  ✅ 所有前端 JS 单独与拼接后均可解析');
} catch (e) {
    console.log('  ❌ 拼接后解析失败: ' + e.message);
    errors.push('Concatenated frontend JS syntax error: ' + e.message);
}

// ===== 4. HTML 结构与 data-act 完整性 =====
console.log('\n=== 4. HTML structure & action wiring ===');
const html = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf-8');

// 不应再有内联事件处理器（CSP 已去掉 script-src 'unsafe-inline'）
const inlineHandlers = html.match(/\son(click|change|input|submit|error|load)\s*=/g);
if (inlineHandlers) {
    console.log('  ❌ index.html 仍有 ' + inlineHandlers.length + ' 个内联事件处理器，CSP 会拦截');
    errors.push('Inline event handlers found in index.html: ' + inlineHandlers.length);
} else {
    console.log('  ✅ index.html 无内联事件处理器');
}

// 每个 data-act / data-act-change 都必须能在 registerActions 中找到
const declaredActions = new Set();
for (const m of concatenated.matchAll(/registerActions\(\{([\s\S]*?)\n\}\)/g)) {
    for (const k of m[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) declaredActions.add(k[1]);
}
const usedActions = new Set();
for (const m of html.matchAll(/data-act(?:-change)?="([^"]+)"/g)) usedActions.add(m[1]);
// 前端 JS 里动态生成的 data-act 也算使用
for (const m of concatenated.matchAll(/data-act(?:-change)?="([^"]+)"/g)) usedActions.add(m[1]);

const unregistered = [...usedActions].filter(a => !declaredActions.has(a));
if (unregistered.length > 0) {
    console.log('  ❌ 以下 data-act 未注册: ' + unregistered.join(', '));
    errors.push('Unregistered actions: ' + unregistered.join(', '));
} else {
    console.log('  ✅ 全部 ' + usedActions.size + ' 个 data-act 均已注册（共声明 ' + declaredActions.size + ' 个动作）');
}

// data-args 必须是合法 JSON
for (const m of html.matchAll(/data-args='([^']+)'/g)) {
    try { JSON.parse(m[1]); }
    catch (e) {
        console.log('  ❌ data-args 不是合法 JSON: ' + m[1]);
        errors.push('Invalid data-args JSON: ' + m[1]);
    }
}

// 关键 ID：从模板类型自动派生，避免新增模板时漏检
const templatesTs = fs.readFileSync(path.join(ROOT, 'src/config/templates.ts'), 'utf-8');
const templateTypes = [...templatesTs.matchAll(/^\s*'([a-z0-9_]+)':\s*\{/gm)].map(m => m[1]);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const criticalIds = [
    'account_body', 'account_form', 'batch_deploy_modal', 'yxip_modal',
    'history_modal', 'workbench_modal', 'starfield', 'workbench_log',
    ...templateTypes.flatMap(t => ['vars_' + t, 'ver_' + t, 'auto_' + t + '_toggle'])
];
const missingIds = criticalIds.filter(id => !htmlIds.has(id));
if (missingIds.length > 0) {
    console.log('  ❌ 缺少关键 HTML ID: ' + missingIds.join(', '));
    errors.push('Missing HTML IDs: ' + missingIds.join(', '));
} else {
    console.log('  ✅ 全部 ' + criticalIds.length + ' 个关键 ID 存在（模板类型: ' + templateTypes.join(', ') + '）');
}

// JS 中 $('x') 引用的 ID 应存在于 HTML 或由 JS 动态创建
const referencedIds = new Set([...concatenated.matchAll(/\$\('([a-z0-9_]+)'\)/g)].map(m => m[1]));
// JS 动态创建的 ID：el.id = 'x' 赋值，或写在 innerHTML / Swal html 模板里的 id="x"
const dynamicIds = new Set([
    ...[...concatenated.matchAll(/\.id\s*=\s*'([a-z0-9_]+)'/g)].map(m => m[1]),
    ...[...concatenated.matchAll(/id="([a-z0-9_]+)"/g)].map(m => m[1])
]);
// 模板插值构造的 ID（如 'vars_' + t）无法静态判定，按前缀放行
const dynamicPrefixes = ['vars_', 'ver_', 'badge_', 'btn_deploy_', 'btn_fix1101_', 'auto_', 'in_workers_', 'bd_chk_'];
const danglingIds = [...referencedIds].filter(id =>
    !htmlIds.has(id) && !dynamicIds.has(id) && !dynamicPrefixes.some(p => id.startsWith(p)));
if (danglingIds.length > 0) {
    console.log('  ❌ JS 引用了既不在 HTML 也不由 JS 创建的 ID: ' + danglingIds.join(', '));
    errors.push('Dangling element IDs: ' + danglingIds.join(', '));
} else {
    console.log('  ✅ JS 引用的 ' + referencedIds.size + ' 个元素 ID 均可解析');
}

// ===== 5. 后端路由注册完整性 =====
console.log('\n=== 5. API route coverage ===');
const routesTS = ['src/routes/register.ts', 'src/routes/crud.ts', 'src/routes/crud-backup.ts', 'src/routes/crud-diag.ts']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf-8')).join('\n');
const expectedRoutes = [
    'GET /api/accounts', 'POST /api/accounts',
    'GET /api/settings', 'POST /api/settings',
    'GET /api/deploy_config',
    'GET /api/favorites', 'POST /api/favorites',
    'GET /api/auto_config', 'POST /api/auto_config',
    'GET /api/check_update', 'GET /api/get_code',
    'POST /api/login',
    'POST /api/deploy', 'POST /api/batch_deploy',
    'POST /api/zones', 'POST /api/all_workers',
    'POST /api/delete_worker', 'POST /api/fetch_bindings',
    'POST /api/get_subdomain', 'POST /api/change_subdomain',
    'GET /api/stats', 'GET /api/diff',
    'POST /api/fix_1101',
    'GET /api/get_regions_data', 'POST /api/save_yxip',
    'GET /api/verify_credentials', 'GET /api/deploy/preview',
    'GET /api/diag', 'GET /api/deploy_journal',
    'GET /api/accounts/export', 'POST /api/accounts/import',
    'GET /api/backup', 'POST /api/restore',
    'GET /api/init_data'
];
const missingRoutes = expectedRoutes.filter(r => !routesTS.includes("'" + r + "'") && !routesTS.includes('"' + r + '"'));
if (missingRoutes.length > 0) {
    console.log('  ❌ 未注册的路由: ' + missingRoutes.join(', '));
    errors.push('Missing API routes: ' + missingRoutes.join(', '));
} else {
    console.log('  ✅ 全部 ' + expectedRoutes.length + ' 个 API 路由已注册');
}

// 前端调用的每个 /api/ 端点都必须存在（含 index.ts 的公开预路由）
const indexTS = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf-8');
const registeredPaths = new Set(expectedRoutes.map(r => r.split(' ')[1]));
for (const m of indexTS.matchAll(/pathname === '(\/[^']+)'/g)) registeredPaths.add(m[1]);
const calledPaths = new Set(
    [...concatenated.matchAll(/['"`](\/api\/[a-z0-9_\/]+)/gi)].map(m => m[1])
);
const unknownCalls = [...calledPaths].filter(p => !registeredPaths.has(p));
if (unknownCalls.length > 0) {
    console.log('  ❌ 前端调用了未注册的端点: ' + unknownCalls.join(', '));
    errors.push('Frontend calls unregistered endpoints: ' + unknownCalls.join(', '));
} else {
    console.log('  ✅ 前端调用的 ' + calledPaths.size + ' 个端点全部已注册');
}

// login 需同时在 register.ts 注册与 index.ts 预路由放行
if (!routesTS.includes('POST /api/login')) {
    errors.push('POST /api/login route not registered');
    console.log('  ❌ POST /api/login 未注册');
} else if (!indexTS.includes("url.pathname === '/api/login'")) {
    warnings.push('POST /api/login pre-route check missing in index.ts');
    console.log('  ⚠️  index.ts 缺少 /api/login 的公开预路由检查');
} else {
    console.log('  ✅ POST /api/login 已注册且在认证前放行');
}

// ===== 6. 静态资源与 CSP 一致性 =====
console.log('\n=== 6. Asset & CSP consistency ===');
const assetPaths = [...indexTS.matchAll(/pathname === '(\/(?:app\.(?:js|css)|vendor\/[^']+))'/g)].map(m => m[1]);
const htmlAssetRefs = [...indexTS.matchAll(/(?:src|href)="(\/(?:app\.(?:js|css)|vendor\/[^"?]+))/g)].map(m => m[1]);
const unservedAssets = htmlAssetRefs.filter(a => !assetPaths.includes(a));
if (unservedAssets.length > 0) {
    console.log('  ❌ HTML 引用了未提供的静态资源: ' + unservedAssets.join(', '));
    errors.push('Unserved assets referenced: ' + unservedAssets.join(', '));
} else {
    console.log('  ✅ HTML 引用的静态资源 (' + htmlAssetRefs.join(', ') + ') 均有对应路由');
}
// CSP 检查：先剥掉注释，否则说明性注释里的字面量会误报
const indexCode = indexTS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
if (/script-src[^;\n'"]*'unsafe-inline'/.test(indexCode)) {
    console.log('  ❌ 面板 CSP 仍包含 script-src \'unsafe-inline\'');
    errors.push("Panel CSP still allows script-src 'unsafe-inline'");
} else {
    console.log('  ✅ 面板 CSP 已去掉 script-src \'unsafe-inline\'');
}

// ===== 7. 导出/导入一致性 =====
console.log('\n=== 7. Export/import consistency ===');
const entryImports = [
    { file: 'middleware/auth', exports: ['requireAccessCode', 'requireCookie', 'checkCsrf', 'sessionKey'] },
    { file: 'lib/cloudflare-api', exports: ['jsonError'] },
    { file: 'routes/register', exports: ['getRoute'] },
    { file: 'cron', exports: ['handleCronJob'] },
    { file: 'config/templates', exports: ['TEMPLATES', 'ECH_PROXIES', 'KV_KEYS', 'MANIFEST'] },
    { file: 'config/login-html', exports: ['loginResponse'] },
    { file: 'lib/concurrency', exports: ['pooledMap', 'pooledMapSettled'] },
    { file: 'lib/validate', exports: ['normalizeVariables', 'normalizeAutoConfig', 'validateAccountsPayload'] }
];
for (const { file, exports: exp } of entryImports) {
    const filePath = path.join(ROOT, 'src', file + '.ts');
    if (!fs.existsSync(filePath)) {
        console.log('  ❌ src/' + file + '.ts 不存在');
        errors.push('Missing: src/' + file + '.ts');
        continue;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const e of exp) {
        const declared = new RegExp('export\\s+(const|function|async function|let|var|class|interface|type)\\s+' + e + '\\b').test(content)
            || new RegExp('export\\s*\\{[^}]*\\b' + e + '\\b[^}]*\\}').test(content);
        if (!declared) {
            console.log('  ❌ ' + file + '.ts 未导出 "' + e + '"');
            errors.push(file + '.ts missing export: ' + e);
        }
    }
}
console.log('  ✅ Export check complete');

// ===== 8. 反模式扫描 =====
console.log('\n=== 8. Anti-pattern scan ===');
// 直接 res.json() 而不判 res.ok 是本项目历史上最常见的静默失败源。
// 合法例外：调用点位于 try 块内且附近有 catch（解析错误消息体本身允许失败）。
const rawJsonCalls = [];
for (const f of backendFiles) {
    if (f.endsWith('cloudflare-api.ts')) continue;   // readApiJson 的实现处
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf-8').split('\n');
    lines.forEach((line, i) => {
        if (!/await\s+[\w.]*[rR]es\w*\.json\(\)/.test(line)) return;
        if (/readApi/.test(line)) return;
        // 在前后 5 行窗口内找 try…catch 兜底（含同行的 try{...}catch 与 .catch()）
        const window = lines.slice(Math.max(0, i - 5), i + 6).join('\n');
        if (/\btry\b[\s\S]*\bcatch\b/.test(window) || /\.catch\(/.test(window)) return;
        rawJsonCalls.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 80));
    });
}
if (rawJsonCalls.length > 0) {
    console.log('  ❌ 以下位置直接 await res.json() 且无 try/catch 兜底:');
    rawJsonCalls.forEach(l => console.log('       ' + l));
    errors.push('Unguarded res.json() calls: ' + rawJsonCalls.length);
} else {
    console.log('  ✅ 后端所有 res.json() 均经 readApiJson 或 try/catch 兜底');
}
// 裸 fetch（未走 fetchWithTimeout）会在上游挂起时耗尽 Worker CPU 预算。
// login-html.ts 里的是发给浏览器的前端代码，index.ts 无 fetch 调用，故两者排除。
const bareFetch = [];
for (const f of backendFiles) {
    if (f.endsWith('config/login-html.ts')) continue;      // 浏览器端脚本字符串
    if (f.endsWith('lib/cloudflare-api.ts')) continue;     // fetchWithTimeout 的实现处
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf-8').split('\n');
    lines.forEach((line, i) => {
        // 排除 `async fetch(request...)` 这样的 Worker handler 方法定义
        if (/async\s+fetch\s*\(/.test(line)) return;
        if (!/(?<![.\w'"])fetch\s*\(/.test(line)) return;
        if (/fetchWithTimeout/.test(line)) return;
        bareFetch.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 80));
    });
}
if (bareFetch.length > 0) {
    console.log('  ❌ 以下位置使用裸 fetch（应改用 fetchWithTimeout）:');
    bareFetch.forEach(l => console.log('       ' + l));
    errors.push('Bare fetch calls: ' + bareFetch.length);
} else {
    console.log('  ✅ 后端全部使用 fetchWithTimeout');
}
// 前端不应残留 window.xxx = <局部变量> 形式的值快照导出
const snapshotExports = [...concatenated.matchAll(/^window\.(accounts|editingIndex|deletedVars|deployConfigs|currentHistoryType)\s*=\s*\1\s*;/gm)];
if (snapshotExports.length > 0) {
    console.log('  ❌ 前端仍有值快照式导出（重新赋值后不会同步）: ' + snapshotExports.map(m => m[1]).join(', '));
    errors.push('Snapshot-style window exports: ' + snapshotExports.map(m => m[1]).join(', '));
} else {
    console.log('  ✅ 前端无值快照式 window 导出');
}

// ===== SUMMARY =====
console.log('\n' + '='.repeat(60));
console.log('VERIFICATION SUMMARY');
console.log('='.repeat(60));
console.log('  Errors:   ' + errors.length);
console.log('  Warnings: ' + warnings.length);

if (errors.length > 0) {
    console.log('\n❌ ERRORS:');
    errors.forEach(e => console.log('  - ' + e));
}
if (warnings.length > 0) {
    console.log('\n⚠️  WARNINGS:');
    warnings.forEach(w => console.log('  - ' + w));
}

if (errors.length === 0) {
    console.log('\n✅ All critical checks passed!');
}

process.exit(errors.length > 0 ? 1 : 0);
