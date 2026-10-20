// Build-time public provenance only. Never read Secrets, local Wrangler config or remotes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function readGitState(root, run = args => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024
})) {
    let commit = null;
    try {
        const canonical = p => { const s = fs.realpathSync(p); return process.platform === 'win32' ? s.toLowerCase() : s; };
        // A source archive nested inside another checkout must not inherit its HEAD.
        if (canonical(run(['rev-parse', '--show-toplevel']).trim()) !== canonical(root)) return { commit, dirty: null };
        const head = run(['rev-parse', '--verify', 'HEAD']).trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return { commit, dirty: null };
        commit = head.toLowerCase();
        const status = run(['status', '--porcelain=v1', '--untracked-files=normal']);
        return { commit, dirty: status.trim().length > 0 };
    } catch (_) { return { commit, dirty: null }; }
}

function hashInputs(inputs) {
    const hash = crypto.createHash('sha256');
    for (const input of [...inputs].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
        const bytes = Buffer.from(input.content);
        // Length prefixes bind both filenames and content without separator ambiguities.
        hash.update(JSON.stringify([input.path, bytes.length]) + '\n');
        hash.update(bytes);
    }
    return hash.digest('hex');
}

function collectSourceInputs(root) {
    const inputs = [];
    function add(rel) {
        const full = path.join(root, rel);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error('Build inputs must not be symbolic links');
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(full).sort()) {
                if (name.startsWith('.') || name === 'node_modules') continue;
                add(rel + '/' + name);
            }
        } else if (stat.isFile() && rel !== 'src/frontend-bundle.ts' && /(?:\.(?:ts|js|cjs|json|css|html|svg)$|\/LICENSE$|^pnpm-lock\.yaml$)/.test(rel)) {
            inputs.push({ path: rel, content: fs.readFileSync(full) });
        }
    }
    // Deliberate allowlist; no .env, deployment files, backup outputs, Git metadata or credentials.
    for (const rel of ['src', 'frontend', 'build.js', 'scripts/build-info.cjs', 'scripts/frontend-modules.cjs', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tailwind.config.cjs']) add(rel);
    return inputs;
}

function createBuildInfo(version, git, sourceSha256) {
    const shortCommit = git.commit ? git.commit.slice(0, 8) : null;
    const suffix = git.dirty === true ? '-dirty' : git.dirty === false ? '' : '-unverified';
    return { schemaVersion: 1, version, commit: git.commit, shortCommit, dirty: git.dirty,
        sourceSha256, buildId: version + '.' + (shortCommit || 'unknown') + suffix + '.' + sourceSha256.slice(0, 12) };
}
function collectBuildInfo(root, version) {
    return createBuildInfo(version, readGitState(root), hashInputs(collectSourceInputs(root)));
}
function buildStateLabel(info) {
    return info.dirty === true ? '含未提交修改' : info.dirty === false ? '工作区干净' : 'Git 状态未知';
}
function renderBuildInfo(html, info) {
    const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const values = { VERSION: info.version, BUILD_LABEL: (info.shortCommit || '提交未知') + ' · ' + buildStateLabel(info),
        BUILD_ID: info.buildId, BUILD_SOURCE: info.sourceSha256, BUILD_STATE: buildStateLabel(info) };
    return html.replace(/\{\{(VERSION|BUILD_LABEL|BUILD_ID|BUILD_SOURCE|BUILD_STATE)\}\}/g, (_, key) => escape(values[key]));
}
function createManifest(build, assetVersion, workerBytes) {
    return { schemaVersion: 1, build, assetVersion, worker: { file: 'worker.js', bytes: workerBytes.length, sha256: sha256(workerBytes) } };
}
function manifestErrors(manifest, build, assetVersion, workerBytes) {
    const expected = createManifest(build, assetVersion, workerBytes);
    return JSON.stringify(manifest) === JSON.stringify(expected) ? [] : ['构建清单与实际 Worker / 前端资源不一致，请重新构建'];
}
function releaseVersionErrors(version, readme, changelog) {
    const errors = [];
    const title = readme.match(/^# .*?\(V([^\s)]+)\)/m);
    const status = readme.match(/^> \*\*版本状态\*\*: V([^\s]+)(?:\s|$)/m);
    const release = changelog.match(/^## V([^\s]+)(?:\s|$)/m);
    if (!title || title[1] !== version) errors.push('README 标题版本与 package.json 不一致');
    if (!status || status[1] !== version) errors.push('README 版本状态与 package.json 不一致');
    if (!release || release[1] !== version) errors.push('CHANGELOG 最新发布条目与 package.json 不一致');
    return errors;
}
module.exports = { readGitState, hashInputs, collectSourceInputs, createBuildInfo, collectBuildInfo, buildStateLabel, renderBuildInfo, createManifest, manifestErrors, releaseVersionErrors };
