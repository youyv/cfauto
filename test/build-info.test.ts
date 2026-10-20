import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { readGitState, createBuildInfo, hashInputs, renderBuildInfo, releaseVersionErrors, manifestErrors, createManifest, collectSourceInputs } = require('../scripts/build-info.cjs');
const sha = 'a'.repeat(40), source = 'b'.repeat(64);
const info = (dirty: boolean | null = false) => createBuildInfo('12.1.1', { commit: sha, dirty }, source);

describe('release provenance', () => {
    it('labels clean, dirty and unavailable Git states honestly', () => {
        expect(info().shortCommit).toBe('aaaaaaaa');
        expect(info().buildId).toBe('12.1.1.aaaaaaaa.bbbbbbbbbbbb');
        expect(info(true).buildId).toContain('aaaaaaaa-dirty');
        expect(info(null).buildId).toContain('aaaaaaaa-unverified');
        const unknown = createBuildInfo('12.1.1', { commit: null, dirty: null }, source);
        expect(unknown.buildId).toContain('unknown-unverified');
        expect(unknown.commit).toBeNull();
    });
    it('uses checkout Git rather than CI env; detached HEAD and untracked changes work', () => {
        const run = (args: string[]) => args.includes('--show-toplevel') ? process.cwd() : args.includes('HEAD') ? sha + '\n' : '?? new-code.ts\n';
        expect(readGitState(process.cwd(), run)).toEqual({ commit: sha, dirty: true });
        expect(readGitState(process.cwd(), (args: string[]) => args.includes('--show-toplevel') ? process.cwd() : args.includes('HEAD') ? sha : '')).toEqual({ commit: sha, dirty: false });
    });
    it('does not call failed/malformed Git output clean or expose error details', () => {
        expect(readGitState(process.cwd(), () => { throw new Error('private path'); })).toEqual({ commit: null, dirty: null });
        expect(readGitState(process.cwd(), (args: string[]) => args.includes('--show-toplevel') ? process.cwd() : '<script>')).toEqual({ commit: null, dirty: null });
        expect(readGitState(process.cwd(), (args: string[]) => {
            if (args.includes('--show-toplevel')) return process.cwd();
            if (args.includes('HEAD')) return sha;
            throw new Error('private status');
        })).toEqual({ commit: sha, dirty: null });
    });
    it('rejects an enclosing unrelated repository', () => {
        expect(readGitState(process.cwd(), () => path.dirname(process.cwd()))).toEqual({ commit: null, dirty: null });
    });
    it('hash is stable under reordering but binds paths and exact source bytes', () => {
        const inputs = [{ path: 'src/a.ts', content: 'one' }, { path: 'frontend/b.js', content: 'two' }];
        expect(hashInputs(inputs)).toBe(hashInputs([...inputs].reverse()));
        expect(hashInputs(inputs)).not.toBe(hashInputs([{ ...inputs[0], content: 'changed' }, inputs[1]]));
        expect(hashInputs(inputs)).not.toBe(hashInputs([{ ...inputs[0], path: 'src/c.ts' }, inputs[1]]));
    });
    it('source allowlist excludes generated artifacts, local credentials and backups', () => {
        const inputs = collectSourceInputs(process.cwd());
        const names = inputs.map((entry: { path: string }) => entry.path);
        expect(names).toContain('src/index.ts');
        expect(names).toContain('frontend/vendor/lucide/LICENSE');
        expect(names).toContain('pnpm-lock.yaml');
        expect(names).not.toContain('src/frontend-bundle.ts');
        expect(names.every((name: string) => !/wrangler|\.env|backup-.*json|^dist\//.test(name))).toBe(true);
        expect(hashInputs(inputs)).toBe(hashInputs(collectSourceInputs(process.cwd())));
    });
    it('escapes HTML and renders all metadata placeholders', () => {
        const html = renderBuildInfo('{{VERSION}}|{{BUILD_LABEL}}|{{BUILD_ID}}|{{BUILD_SOURCE}}|{{BUILD_STATE}}', info(true));
        expect(html).toContain('aaaaaaaa · 含未提交修改');
        expect(html).not.toContain('{{');
        expect(renderBuildInfo('{{VERSION}}', { ...info(), version: '<img src="x">' })).toBe('&lt;img src=&quot;x&quot;&gt;');
    });
    it('checks README and latest release heading against the single package version', () => {
        const readme = '# CF Auto (V12.1.1)\n> **版本状态**: V12.1.1';
        const changelog = '# 更新日志\n## 未发布\n- work\n## V12.1.1 (2026-09-30)\n## V12.1.0';
        expect(releaseVersionErrors('12.1.1', readme, changelog)).toEqual([]);
        expect(releaseVersionErrors('12.1.2', readme, changelog)).toHaveLength(3);
        expect(releaseVersionErrors('12.1.1', '', '')).toHaveLength(3);
    });
    it('manifest identifies exact bytes and catches stale/tampered artifacts', () => {
        const bytes = Buffer.from('mock worker');
        const manifest = createManifest(info(), 'asset-123', bytes);
        expect(manifestErrors(manifest, info(), 'asset-123', bytes)).toEqual([]);
        expect(manifestErrors(manifest, info(), 'asset-123', Buffer.from('different'))).not.toEqual([]);
        expect(manifestErrors(manifest, info(true), 'asset-123', bytes)).not.toEqual([]);
        expect(manifestErrors(manifest, info(), 'asset-other', bytes)).not.toEqual([]);
        expect(JSON.stringify(manifest)).not.toMatch(/timestamp|hostname|token|secret|cwd/i);
    });
    it('diagnostic report includes build identity without losing existing redaction', () => {
        const context = vm.createContext({ window: { APP_VERSION: 'V12.1.1', APP_BUILD_INFO: info(true) }, location: { origin: 'https://mock.invalid' }, registerActions() {} });
        vm.runInContext(fs.readFileSync('frontend/js/diagnostics.js', 'utf8'), context);
        const report = vm.runInContext('buildDebugReport("test", "Bearer mock-token-for-test-12345", {})', context);
        expect(report).toContain(info(true).buildId);
        expect(report).toContain('含未提交修改');
        expect(report).toContain('不代表已推送或已部署');
        expect(report).not.toContain('mock-token-for-test-12345');
    });
});
