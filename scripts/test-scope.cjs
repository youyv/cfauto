/* One explicit suite inventory for local development and release evidence.
 * File counts are derived from the inventory, never a historical numerical floor. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const GROUPS = Object.freeze(['core', 'frontend', 'operations', 'reliability']);
const FULL_COMMAND = Object.freeze(['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=4']);
const GENERATED_TEST_PATH = 'test/fixtures/reliability/.wrangler';
const RUNTIME_CHECKPOINTS = Object.freeze([
    'admission_recovery', 'queue_unknown_barriers', 'credential_import_revocation',
    'authority_activation_atomicity', 'public_authority_ingress', 'initial_archive_replay',
    'shared_source_rpc_replay', 'large_source_nine_account_replay', 'cas_policy_final_replay'
]);
const fail = code => { throw new Error(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function validationFiles(root, directory) {
    const files = [];
    function walk(relative) {
        const full = path.join(root, relative), stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) fail('TEST_SCOPE_UNSAFE_INPUT');
        // Only Wrangler's generated local fixture state is excluded. All real
        // fixtures, helpers, e2e sources and scripts stay bound into the evidence.
        if (relative === GENERATED_TEST_PATH && stat.isDirectory()) return;
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(full).sort()) {
                if (name === 'node_modules') fail('TEST_SCOPE_UNSAFE_INPUT');
                walk(relative + '/' + name);
            }
        } else if (stat.isFile()) files.push(relative);
        else fail('TEST_SCOPE_UNSAFE_INPUT');
    }
    walk(directory);
    return files;
}
function readTestSuites(root) {
    const file = path.join(root, 'test/suites.json');
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fail('TEST_SCOPE_UNSAFE_MANIFEST');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.schema !== 1 || !manifest.groups || Object.keys(manifest.groups).sort().join() !== GROUPS.join()) fail('TEST_SCOPE_INVALID_MANIFEST');
    const expected = [];
    for (const group of GROUPS) {
        const files = manifest.groups[group];
        if (!Array.isArray(files) || !files.length) fail('TEST_SCOPE_EMPTY_GROUP');
        for (const file of files) {
            if (typeof file !== 'string' || !/^test\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.ts$/.test(file)) fail('TEST_SCOPE_INVALID_PATH');
            expected.push(file);
        }
    }
    if (new Set(expected).size !== expected.length) fail('TEST_SCOPE_DUPLICATE_SUITE');
    const discovered = validationFiles(root, 'test').filter(file => file.endsWith('.test.ts')).sort();
    expected.sort();
    if (JSON.stringify(expected) !== JSON.stringify(discovered)) fail('TEST_SCOPE_DISCOVERY_MISMATCH');
    return { schema: 1, groups: manifest.groups, files: discovered };
}
function collectTestScope(root) {
    const scope = readTestSuites(root);
    const files = [...validationFiles(root, 'scripts'), ...validationFiles(root, 'test'),
        'vitest.config.ts', 'playwright.config.cjs', 'playwright.cross-browser.config.cjs', 'verify.js'];
    const inputs = [...new Set(files)].sort().map(file => {
        const stat = fs.lstatSync(path.join(root, file));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) fail('TEST_SCOPE_UNSAFE_INPUT');
        const bytes = fs.readFileSync(path.join(root, file));
        return { file, bytes: bytes.length, sha256: sha(bytes) };
    });
    return { ...scope, inputs };
}
function assertFullTestOutput(stdout, expectedFiles) {
    const lines = stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
    const fileLines = lines.filter(line => /^\s*Test Files\s+/.test(line));
    const testLines = lines.filter(line => /^\s*Tests\s+/.test(line));
    if (fileLines.length !== 1 || testLines.length !== 1) fail('TEST_SCOPE_FULL_OUTPUT_INVALID');
    const f = fileLines[0].match(/^\s*Test Files\s+(\d+) passed \((\d+)\)\s*$/);
    const t = testLines[0].match(/^\s*Tests\s+(\d+) passed \((\d+)\)\s*$/);
    if (!Number.isSafeInteger(expectedFiles) || expectedFiles < 1 || !f || !t ||
        Number(f[1]) !== expectedFiles || f[1] !== f[2] || !Number.isSafeInteger(Number(t[1])) || Number(t[1]) < expectedFiles || t[1] !== t[2]) fail('TEST_SCOPE_FULL_OUTPUT_INVALID');
    return { files: Number(f[1]), tests: Number(t[1]) };
}
function assertRuntimeOutput(stdout) {
    const lines = stdout.split(/\r?\n/);
    const counts = lines.filter(line => line.startsWith('ACTUAL_LOCAL_PROCESS_RESTARTS '));
    const checkpoints = lines.filter(line => line.startsWith('RUNTIME_CHECKPOINTS '));
    if (counts.length !== 1 || checkpoints.length !== 1) fail('TEST_SCOPE_RUNTIME_INCOMPLETE');
    const count = counts[0].match(/^ACTUAL_LOCAL_PROCESS_RESTARTS ([1-9]\d*)$/);
    if (!count) fail('TEST_SCOPE_RUNTIME_INCOMPLETE');
    const realLocalProcessRestarts = Number(count[1]);
    let observed;
    try { observed = JSON.parse(checkpoints[0].slice('RUNTIME_CHECKPOINTS '.length)); } catch { fail('TEST_SCOPE_RUNTIME_INCOMPLETE'); }
    if (!Number.isSafeInteger(realLocalProcessRestarts) || realLocalProcessRestarts < 1 || !Array.isArray(observed) ||
        JSON.stringify(observed.map(item => item?.id)) !== JSON.stringify(RUNTIME_CHECKPOINTS)) fail('TEST_SCOPE_RUNTIME_INCOMPLETE');
    let previous = 1;
    for (const item of observed) {
        if (!item || Object.keys(item).sort().join() !== 'id,restarts' || !Number.isSafeInteger(item.restarts) || item.restarts < previous || item.restarts > realLocalProcessRestarts) fail('TEST_SCOPE_RUNTIME_INCOMPLETE');
        previous = item.restarts;
    }
    if (previous !== realLocalProcessRestarts) fail('TEST_SCOPE_RUNTIME_INCOMPLETE');
    return { realLocalProcessRestarts, checkpoints: observed };
}
module.exports = { GROUPS, FULL_COMMAND, RUNTIME_CHECKPOINTS, GENERATED_TEST_PATH, validationFiles, readTestSuites, collectTestScope, assertFullTestOutput, assertRuntimeOutput };
if (require.main === module) {
    try {
        const [command, group, ...extra] = process.argv.slice(2), root = path.resolve(__dirname, '..');
        if (command !== 'run' || extra.length || !GROUPS.includes(group)) fail('USAGE_NODE_TEST_SCOPE_RUN_CORE_FRONTEND_OPERATIONS_OR_RELIABILITY');
        const scope = readTestSuites(root);
        const child = require('node:child_process').spawn(process.execPath, [...FULL_COMMAND, ...scope.groups[group]], {
            cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, BROWSER: 'none', WRANGLER_SEND_METRICS: 'false' }
        });
        child.on('error', () => { console.error('TEST_GROUP_SPAWN_FAILED'); process.exitCode = 1; });
        child.on('close', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
