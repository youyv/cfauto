/**
 * 版本号升级脚本
 * 用法: node bump-version.js [major|minor|patch]
 * 默认: patch (12.0.0 → 12.0.1)
 *
 * 只改「版本号真相源」与文档中的显式版本引用：
 *   - package.json 的 version（build.js 由此派生 FRONTEND_VERSION 与 {{VERSION}}）
 *   - README.md 的标题与版本状态行
 *   - CHANGELOG.md 插入新条目骨架
 * frontend/index.html 用 {{VERSION}} 占位符，src/index.ts 用 FRONTEND_VERSION，
 * 两者都由 build.js 在构建时注入，无需在此改动。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const pkgPath = path.join(ROOT, 'package.json');
const readmePath = path.join(ROOT, 'README.md');
const changelogPath = path.join(ROOT, 'CHANGELOG.md');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const level = process.argv[2] || 'patch';
if (!['major', 'minor', 'patch'].includes(level)) {
    console.error('用法: node bump-version.js [major|minor|patch]');
    process.exit(1);
}

let newVersion;
if (level === 'major') newVersion = `${major + 1}.0.0`;
else if (level === 'minor') newVersion = `${major}.${minor + 1}.0`;
else newVersion = `${major}.${minor}.${patch + 1}`;

const oldVersion = pkg.version;
const oldTag = 'V' + oldVersion;
const newTag = 'V' + newVersion;
const today = new Date().toISOString().slice(0, 10);

console.log(`${oldTag} → ${newTag}`);

// 1. package.json（唯一的版本真相源）
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
console.log('✅ package.json');

// 2. README.md — 只替换标题与版本状态行的版本号，避免误改历史说明中的版本引用
let readme = fs.readFileSync(readmePath, 'utf-8');
const before = readme;
readme = readme
    .replace(/^(# .*?\()V\d+\.\d+\.\d+(\))/m, `$1${newTag}$2`)
    .replace(/^(> \*\*版本状态\*\*: )V\d+\.\d+\.\d+/m, `$1${newTag}`);
if (readme === before) {
    console.log('⚠️  README.md 未找到可替换的版本号位置（标题 / 版本状态行），请手动检查');
} else {
    fs.writeFileSync(readmePath, readme, 'utf-8');
    console.log('✅ README.md');
}

// 3. CHANGELOG.md — 在最新条目之前插入新版本骨架
let clog = fs.readFileSync(changelogPath, 'utf-8');
if (clog.includes(`## ${newTag}`)) {
    console.log(`⏭️  CHANGELOG.md 已有 ${newTag}`);
} else if (!clog.includes(`## ${oldTag}`)) {
    console.log(`⚠️  CHANGELOG.md 未找到 ## ${oldTag}，请手动添加新条目`);
} else {
    clog = clog.replace(`## ${oldTag}`, `## ${newTag} (${today})\n\n### \n\n## ${oldTag}`);
    fs.writeFileSync(changelogPath, clog, 'utf-8');
    console.log('✅ CHANGELOG.md（已插入空骨架，请填写变更内容）');
}

console.log(`\n下一步: 填写 CHANGELOG，然后运行 npm run check 重新构建并校验。`);
