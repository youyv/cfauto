/* One local check pipeline. Each gate runs once; optional real DO restart tests
 * are separate from everyday checks. Never deploys or installs dependencies. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const { privateDirectory } = require('./maintenance-client.cjs');
const { privateSave, canonical, hash } = require('./cutover-window.cjs');
const { collectSourceInputs } = require('./build-info.cjs');
const { collectToolGateInputs } = require('./production-tool-gates.cjs');
const { FULL_COMMAND, assertFullTestOutput, assertRuntimeOutput } = require('./test-scope.cjs');
const COMMANDS = Object.freeze({ build: ['build.js'], type: ['node_modules/typescript/bin/tsc', '--noEmit'],
    verify: ['verify.js'], full: FULL_COMMAND, runtime: ['scripts/test-reliability-runtime.cjs'] });
const fail = code => { throw new Error(code); };
function parseOptions(args) {
    const options = { runtime: false, evidence: undefined };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--runtime' && !options.runtime) options.runtime = true;
        else if (args[i] === '--evidence' && !options.evidence && args[i + 1] && !args[i + 1].startsWith('--')) options.evidence = args[++i];
        else fail('USAGE_NODE_CHECK_OPTIONAL_RUNTIME_AND_EVIDENCE_DIRECTORY');
    }
    return options;
}
async function evidenceDirectory(root, requested) {
    if (!requested) return undefined;
    const base = path.join(root, '.wrangler');
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    const directory = path.resolve(root, requested), parent = await fs.realpath(path.dirname(directory));
    const relative = path.relative(await fs.realpath(base), parent);
    if (directory === base || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('CHECK_EVIDENCE_PATH_ESCAPE');
    return privateDirectory(directory); // Existing evidence is never overwritten.
}
async function runProcess({ root, directory, kind, args, inputsSha256 }) {
    const name = 'candidate-' + kind, startedAt = new Date().toISOString(), helperPid = process.pid;
    const save = async (suffix, value) => { if (directory) await privateSave(directory, name + suffix, value); };
    await save('.start.json', { name, args, cwd: root, startedAt, helperPid, inputsSha256 });
    const stdout = [], stderr = [];
    let total = 0;
    const result = await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CI: 'true', BROWSER: 'none', WRANGLER_SEND_METRICS: 'false' } });
        const childSaved = Number.isSafeInteger(child.pid) ? save('.child.json', { pid: child.pid, helperPid, startedAt }) : Promise.resolve();
        childSaved.catch(() => {});
        let spawnError = false;
        child.on('error', () => { spawnError = true; });
        child.stdout.on('data', chunk => { total += chunk.length; stdout.push(chunk); process.stdout.write(chunk); });
        child.stderr.on('data', chunk => { total += chunk.length; stderr.push(chunk); process.stderr.write(chunk); });
        child.on('close', async (code, signal) => {
            try {
                await childSaved;
                const endedAt = new Date().toISOString();
                await save('.stdout.log', Buffer.concat(stdout));
                await save('.stderr.log', Buffer.concat(stderr));
                await save('.end.json', { name, pid: child.pid ?? null, helperPid, code, signal, startedAt, endedAt, inputsSha256 });
                if (spawnError) fail('CHECK_SPAWN_FAILED');
                if (total > 32 * 1024 * 1024) fail('CHECK_OUTPUT_TOO_LARGE');
                resolve({ code, signal, name, startedAt, endedAt, stdout: Buffer.concat(stdout).toString('utf8') });
            } catch (error) { reject(error); }
        });
    });
    if (result.code !== 0 || result.signal !== null) fail('CHECK_' + kind.toUpperCase() + '_FAILED');
    return result;
}
async function check({ root = path.resolve(__dirname, '..'), runtime = false, evidence } = {}) {
    root = path.resolve(root);
    const directory = await evidenceDirectory(root, evidence);
    const save = async (file, value) => { if (directory) await privateSave(directory, file, value); };
    const gateFiles = {}, checks = {};
    try {
        console.log('=== build ===');
        const build = await runProcess({ root, directory, kind: 'build', args: COMMANDS.build });
        gateFiles.build = build.name; checks.build = { exitCode: 0 };
        const before = await collectToolGateInputs(root), snapshot = Buffer.from(canonical(before));
        const inputsSha256 = hash(snapshot);
        await save('inputs-before.json', snapshot);
        await save('intent.json', { schema: 2, kind: 'local_candidate_gates', root, inputsSha256, runtime, publicationAllowed: false });
        const manifestBytes = await fs.readFile(path.join(root, 'dist/build-manifest.json'));
        const manifest = JSON.parse(manifestBytes);
        await save('worker.js', await fs.readFile(path.join(root, 'dist/worker.js')));
        await save('build-manifest.json', manifestBytes);
        await save('source-inputs.json', collectSourceInputs(root).map(input => ({ file: input.path, bytes: input.content.length, sha256: hash(input.content) })));
        for (const kind of ['type', 'verify', 'full', ...(runtime ? ['runtime'] : [])]) {
            if (canonical(await collectToolGateInputs(root)) !== snapshot.toString('utf8')) fail('CHECK_INPUTS_CHANGED');
            console.log('=== ' + kind + ' ===');
            const result = await runProcess({ root, directory, kind, args: COMMANDS[kind], inputsSha256 });
            gateFiles[kind] = result.name;
            if (kind === 'verify' && !/Errors:\s+0\s+Warnings:\s+0/.test(result.stdout)) fail('CHECK_VERIFY_FAILED');
            checks[kind] = { exitCode: 0, ...(kind === 'full' ? assertFullTestOutput(result.stdout, before.discoveredTests.length) :
                kind === 'runtime' ? assertRuntimeOutput(result.stdout) : {}) };
        }
        const after = Buffer.from(canonical(await collectToolGateInputs(root)));
        await save('inputs-after.json', after);
        if (!snapshot.equals(after)) fail('CHECK_INPUTS_CHANGED');
        const report = { schema: 2, candidate: manifest, testScope: before.testScope, checks, gateFiles, inputsSha256,
            sourceInputsUnchanged: true, runtimeExecuted: runtime, browserExecuted: false, a5Executed: false,
            releaseAllowed: false, completedAt: new Date().toISOString() };
        await save('implementation-report.json', report);
        console.log('LOCAL_CHECK_COMPLETE ' + JSON.stringify({ buildId: before.candidate.buildId, full: checks.full,
            realLocalProcessRestarts: checks.runtime?.realLocalProcessRestarts ?? null, browserExecuted: false, releaseAllowed: false }));
        return report;
    } catch (error) {
        await save('failure.json', { at: new Date().toISOString(), error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_CHECK_FAILED', releaseAllowed: false, automaticRetry: false });
        throw error;
    }
}
module.exports = { COMMANDS, parseOptions, evidenceDirectory, runProcess, check };
if (require.main === module) Promise.resolve().then(() => check(parseOptions(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
