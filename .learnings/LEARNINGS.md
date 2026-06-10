# Learnings

> 自动捕获的开发经验，按 Pattern-Key 分组。定期审查并提升重要条目为项目记忆。

---

## [LRN-20260610-01] correction

**Status**: resolved
**Area**: frontend
**Pattern-Key**: frontend.js.concat.missing.init

### Summary
前端 JS 拆分为多文件后，`init()` 调用在拼接产物中丢失，导致页面加载但不渲染数据。

### Details
原始单文件 `worker.js` 末尾有 `applyTheme();\ninit();`。重构拆分 `frontend/js/*.js` 后，`build.js` 按顺序拼接文件，但 `init()` 定义在 `state.js`（第一个文件），调用却只在原始合并文件末尾——拆分后无文件负责调用。`starfield.js`（最后一个文件）只有 `applyTheme()`，导致 `init()` 从未执行、`loadAccounts()` 从未触发、页面显示"无数据"。

### Fix
在 `starfield.js` 末尾添加 `init();` 和注释 `// 应用入口（init 定义于 state.js，在所有 JS 文件拼接后调用）`。

### Metadata
- Source: user_feedback
- Related Files: frontend/js/starfield.js, frontend/js/state.js, build.js
- Recurrence-Count: 1

---

## [LRN-20260610-02] correction

**Status**: resolved
**Area**: backend
**Pattern-Key**: variable.shadowing.destructured.param

### Summary
`handleBatchDeploy` 中 `const kvName = TEMPLATES[template].kvBindingName` 遮蔽了解构参数 `kvName`（命名空间标题）。

### Details
函数签名 `{ template, workerName, kvName, ... } = reqData` 中 `kvName` 是 KV 命名空间标题。后面用 `const kvName = TEMPLATES[template].kvBindingName` 重新声明遮蔽了外层的 `kvName`。当前代码恰好在独立 `if` 块中不会造成功能 bug，但极易引入混淆。

### Fix
重命名为 `bindingName`：`const bindingName = TEMPLATES[template].kvBindingName`。

### Metadata
- Source: code_review
- Related Files: src/routes/deploy.ts, D:/下载/worker.js
- Recurrence-Count: 1

---

## [LRN-20260610-03] best_practice

**Status**: resolved
**Area**: backend
**Pattern-Key**: template.config.hardcoded.filter

### Summary
`defaultVars` 过滤逻辑硬编码 `'KV'/'C'`，应使用 `TEMPLATES[type].kvBindingName`。

### Details
`handleBatchDeploy` 回退分支中：
```js
defaultVars.forEach(key => {
    if (key !== 'KV' && key !== 'C' && key !== 'ADMIN' && key !== 'u') {
```
当模板 KV 绑定名变化时（如新增模板），硬编码过滤会遗漏。应改用 `TEMPLATES[template].kvBindingName` 和 `TEMPLATES[template].uuidField`。

### Fix
```js
const t = TEMPLATES[template];
if (key !== t.kvBindingName && key !== 'ADMIN' && key !== t.uuidField)
```

### Metadata
- Source: code_review
- Related Files: src/routes/deploy.ts, D:/下载/worker.js
- Recurrence-Count: 1

---

## [LRN-20260610-04] correction

**Status**: resolved
**Area**: backend
**Pattern-Key**: route.duplicate.login.handler

### Summary
`POST /api/login` 在两处注册：`src/index.ts` 内联 + `routes/index.ts` lazyRoutes。lazy 副本为死代码。

### Details
`index.ts` 的 `fetch()` 在认证检查前内联处理登录。同时 `routes/index.ts` 的 `lazyRoutes` 数组和 `getHandler` switch case 也注册了登录。请求被内联处理器拦截，lazy 路由永不触发。这会误导开发者修改错误的登录逻辑。

### Fix
从 `routes/index.ts` 删除 `case 'login'` switch case 和 `['POST', '/api/login', 'login']` lazy route 条目。更新 `verify.js` 增加对内联 handler 的专项检查。

### Metadata
- Source: code_review
- Related Files: src/index.ts, src/routes/index.ts, verify.js
- Recurrence-Count: 1

---

## [LRN-20260610-05] correction

**Status**: resolved
**Area**: backend
**Pattern-Key**: template.type.fields.incomplete

### Summary
向 TEMPLATES 添加行为字段时，`ech` 模板缺少 `yxipKey`/`yxipContentType`/`yxipBuildContent`，违反类型约束。

### Details
为 `cmliu` 和 `joey` 添加 `kvBindingName`/`yxipKey`/`yxipBuildContent` 后，`ech` 只补了 `kvBindingName: ''`，遗漏了三个 yxip 字段。TypeScript 严格模式下类型报错，且未来迭代所有模板的代码访问 `ech.yxipKey` 会得到 `undefined`。

### Fix
为 `ech` 补全占位字段：`yxipKey: ''`, `yxipContentType: 'text/plain'`, `yxipBuildContent: (raw) => raw`。

### Metadata
- Source: code_review
- Related Files: src/config/templates.ts
- Recurrence-Count: 1

---

## [LRN-20260610-06] best_practice

**Status**: resolved
**Area**: backend
**Pattern-Key**: array.property.assignment.side.effect

### Summary
`vars._echTokenEnabled = echTokenEnabled` 在数组上挂命名属性，产生隐式副作用。

### Details
`vars` 是 `Array<{key, value}>`。设置 `vars._echTokenEnabled` 不改变数组元素，但会污染对象。`JSON.stringify` 忽略命名属性，所以不会序列化到 API 请求体——后端通过独立参数 `echTokenEnabled` 接收。该赋值完全无效果，但暗示存在数据流。

### Fix
删除 `vars._echTokenEnabled = echTokenEnabled;` 行。

### Metadata
- Source: code_review
- Related Files: frontend/js/deploy.js
- Recurrence-Count: 1

---

## [LRN-20260610-07] best_practice

**Status**: resolved
**Area**: infra
**Pattern-Key**: build.pipeline.json.stringify.esbuild.template.literal

### Summary
构建管线 `JSON.stringify → TypeScript string → esbuild template literal → HTML injection` 转义链脆弱。修改前端 JS 后必须验证 `/api/diag` + 页面渲染。

### Details
`build.js` 流程：`fs.readFileSync(jsFile)` → `JSON.stringify(jsContent)` → 写入 `frontend-bundle.ts` → esbuild 输出 template literal → 运行时注入 HTML `<script>`。每层都有转义规则，任一层出错都会导致前端 JS 语法错误（静默失败——`catch(e){}`）。本次 bug（`init()` 缺失）不在此链条中，但突出显示了缺少前端 JS 运行时验证的风险。

### Metadata
- Source: debugging
- Related Files: build.js, src/frontend-bundle.ts, src/index.ts
- Recurrence-Count: 1

---
