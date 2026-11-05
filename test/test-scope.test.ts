import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeSyntheticScope } from './scope-fixture';
const require = createRequire(import.meta.url);
const { readTestSuites, collectTestScope, assertFullTestOutput, assertRuntimeOutput, RUNTIME_CHECKPOINTS, FULL_COMMAND } = require('../scripts/test-scope.cjs');
const { parseOptions, COMMANDS, evidenceDirectory } = require('../scripts/check.cjs');
async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'cfauto-test-scope-'));
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'scripts/runner.cjs'), '// fixture tool');
    await writeSyntheticScope(root);
    return root;
}
async function manifest(root: string, change: (value: any) => void) {
    const file = path.join(root, 'test/suites.json'), value = JSON.parse(await readFile(file, 'utf8'));
    change(value); await writeFile(file, JSON.stringify(value));
}
describe('explicit, code-bound test scope', () => {
    it('derives complete scope from named groups without a historical count floor', async () => {
        const root = await fixture(), scope = collectTestScope(root);
        expect(readTestSuites(root).files).toHaveLength(4);
        expect(scope.inputs.some((item: any) => item.file === 'scripts/runner.cjs')).toBe(true);
        expect(assertFullTestOutput('Test Files 4 passed (4)\nTests 8 passed (8)\n', 4)).toEqual({ files: 4, tests: 8 });
        expect(COMMANDS.full).toEqual(FULL_COMMAND);
        expect(COMMANDS.runtime).toEqual(['scripts/test-reliability-runtime.cjs']);
    });
    it('refuses missing, unlisted, duplicate, empty and escaping suites', async () => {
        const root = await fixture();
        const original = await readFile(path.join(root, 'test/suites.json'));
        for (const change of [
            (value: any) => value.groups.core.push(value.groups.core[0]),
            (value: any) => { value.groups.core = []; },
            (value: any) => { value.groups.core = ['../outside.test.ts']; },
            (value: any) => { delete value.groups.core; }
        ]) {
            await manifest(root, change); expect(() => readTestSuites(root)).toThrow();
            await writeFile(path.join(root, 'test/suites.json'), original);
        }
        await writeFile(path.join(root, 'test/unlisted.test.ts'), '// should not silently disappear');
        expect(() => readTestSuites(root)).toThrow('TEST_SCOPE_DISCOVERY_MISMATCH');
        await unlink(path.join(root, 'test/unlisted.test.ts'));
        await unlink(path.join(root, 'test/case-0.test.ts'));
        expect(() => readTestSuites(root)).toThrow('TEST_SCOPE_DISCOVERY_MISMATCH');
    });
    it('ignores only generated fixture cache, never real fixtures or helper drift', async () => {
        const root = await fixture(), before = collectTestScope(root);
        await mkdir(path.join(root, 'test/fixtures/reliability/.wrangler/tmp'), { recursive: true });
        await writeFile(path.join(root, 'test/fixtures/reliability/.wrangler/tmp/bundle.js'), 'regenerable');
        expect(collectTestScope(root)).toEqual(before);
        await writeFile(path.join(root, 'test/fixtures/reliability/worker.ts'), '// real fixture');
        expect(collectTestScope(root)).not.toEqual(before);
        const withFixture = collectTestScope(root);
        await writeFile(path.join(root, 'scripts/runner.cjs'), '// modified real helper');
        expect(collectTestScope(root)).not.toEqual(withFixture);
    });
    it('rejects a junction even at the generated-cache boundary', async () => {
        const root = await fixture(), other = await fixture();
        await mkdir(path.join(root, 'test/fixtures/reliability'), { recursive: true });
        await symlink(other, path.join(root, 'test/fixtures/reliability/.wrangler'), 'junction');
        expect(() => collectTestScope(root)).toThrow('TEST_SCOPE_UNSAFE_INPUT');
    });
    it('rejects filtered, skipped, empty and repeated summaries', () => {
        for (const stdout of [
            'Test Files 3 passed (3)\nTests 8 passed (8)',
            'Test Files 4 passed | 1 skipped (5)\nTests 8 passed (8)',
            'Test Files 4 passed (4)\nTests 8 passed | 1 skipped (9)',
            'Test Files 4 passed (4)\nTests 0 passed (0)',
            'Test Files 4 passed (4)\nTests 9007199254740992 passed (9007199254740992)',
            'Test Files 4 passed (4)\nTests 8 passed (8)\nTests 8 passed (8)'
        ]) expect(() => assertFullTestOutput(stdout, 4)).toThrow('TEST_SCOPE_FULL_OUTPUT_INVALID');
    });
    it('requires every recovery checkpoint and actual restart observations, not prose or a counter alone', () => {
        const observed = RUNTIME_CHECKPOINTS.map((id: string, i: number) => ({ id, restarts: i + 1 }));
        const log = (items = observed, count = observed.length) => `RUNTIME_CHECKPOINTS ${JSON.stringify(items)}\nACTUAL_LOCAL_PROCESS_RESTARTS ${count}`;
        expect(assertRuntimeOutput(log()).checkpoints).toEqual(observed);
        for (const text of [
            'ACTUAL_LOCAL_PROCESS_RESTARTS 35', log(observed.slice(1)), log([...observed].reverse()),
            log(observed, 0), log().replace(/RESTARTS \d+/, 'RESTARTS 0x9'), log(observed, observed.length - 1), log() + '\nACTUAL_LOCAL_PROCESS_RESTARTS 35'
        ]) expect(() => assertRuntimeOutput(text)).toThrow();
    });
    it('offers exactly one ordinary pipeline and an explicit extended runtime option', () => {
        expect(parseOptions([])).toEqual({ runtime: false, evidence: undefined });
        expect(parseOptions(['--runtime', '--evidence', '.wrangler/new-run'])).toEqual({ runtime: true, evidence: '.wrangler/new-run' });
        for (const args of [['--browser'], ['--deploy'], ['--runtime', '--runtime'], ['--evidence']]) expect(() => parseOptions(args)).toThrow();
    });
    it('refuses evidence paths outside the workspace cache and refuses overwrites', async () => {
        const root = await fixture();
        await expect(evidenceDirectory(root, path.join(tmpdir(), 'not-check-evidence'))).rejects.toThrow('CHECK_EVIDENCE_PATH_ESCAPE');
        const out = await evidenceDirectory(root, '.wrangler/current');
        expect(out).toBe(path.join(root, '.wrangler/current'));
        await expect(evidenceDirectory(root, '.wrangler/current')).rejects.toThrow();
    });
});
