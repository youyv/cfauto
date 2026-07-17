/**
 * 版本号升级脚本
 * 用法: node bump-version.js [major|minor|patch]
 * 默认: patch (11.7.1 → 11.7.2)
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const pkgPath = path.join(ROOT, 'package.json');
const readmePath = path.join(ROOT, 'README.md');
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const indexPath = path.join(ROOT, 'src/index.ts');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const level = process.argv[2] || 'patch';
let newVersion;
if (level === 'major') newVersion = `${major + 1}.0.0`;
else if (level === 'minor') newVersion = `${major}.${minor + 1}.0`;
else newVersion = `${major}.${minor}.${patch + 1}`;

const oldVersion = pkg.version;
const oldTag = 'V' + oldVersion;
const newTag = 'V' + newVersion;
const today = new Date().toISOString().slice(0, 10);

console.log(`${oldTag} → ${newTag}`);

// 1. package.json
pkg.version = newVersion;
pkg.description = pkg.description.replace(oldTag, newTag);
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
console.log('✅ package.json');

// 2. README.md — 替换所有版本号引用
let readme = fs.readFileSync(readmePath, 'utf-8');
const countBefore = (readme.match(new RegExp(oldTag.replace(/\./g, '\\.'), 'g')) || []).length;
readme = readme.replaceAll(oldTag, newTag);
const countAfter = (readme.match(new RegExp(newTag.replace(/\./g, '\\.'), 'g')) || []).length;
fs.writeFileSync(readmePath, readme, 'utf-8');
console.log(`✅ README.md (${countAfter} occurrences)`);

// 3. CHANGELOG.md — 插入新版本条目
let clog = fs.readFileSync(changelogPath, 'utf-8');
const entry = `## ${newTag} (${today})

### 
`;
if (!clog.includes(`## ${newTag}`)) {
    clog = clog.replace('## ' + oldTag, entry + '## ' + oldTag);
    fs.writeFileSync(changelogPath, clog, 'utf-8');
    console.log('✅ CHANGELOG.md');
} else {
    console.log('⏭️ CHANGELOG.md already has ' + newTag);
}

// 4. src/index.ts — 注释中的版本号模板（由 FRONTEND_VERSION 自动替换）
// frontend/index.html — 由 {{VERSION}} 模板替换，build.js 处理

console.log(`\nDone. Run build.js to regenerate frontend-bundle.ts.`);
