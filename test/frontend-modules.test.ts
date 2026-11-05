import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { bundleFrontendModules } = createRequire(import.meta.url)('../scripts/frontend-modules.cjs');
describe('incremental ES module boundary', () => {
    it('bundles explicit imports without exposing a window export or requiring runtime module fetch', () => {
        const { code, inputs } = bundleFrontendModules(process.cwd());
        expect(inputs).toContain('frontend/modules/automation-summary.js');
        const context = vm.createContext({ Intl, Date });
        vm.runInContext(code, context);
        expect(context.frontendModules).toBeUndefined();
        expect(vm.runInContext('frontendModules.automationSummary({enabled:true}, {custom:{name:"Custom"}}).details', context)).toContain('Custom');
        expect(code).not.toMatch(/\bimport\s*(?:\(|[{])/);
    });
    it('keeps only persistable display statistics in the account save payload', () => {
        const { code } = bundleFrontendModules(process.cwd());
        const context = vm.createContext({ Intl, Date });
        vm.runInContext(code, context);
        const result: any = vm.runInContext(`(() => {
            const accounts = [{ alias: 'a', accountId: 'f'.repeat(32), stats: { total: 1, max: 100000, accountId: 'f'.repeat(32) }, workers_cmliu: ['w'] }];
            const payload = frontendModules.accountSavePayload(accounts);
            return { payload, stats: accounts[0].stats, length: payload.length };
        })()`, context);
        // accountId is runtime read-model metadata; the authority only accepts the historical display fields
        expect(JSON.parse(JSON.stringify(result.payload))).toEqual([{ alias: 'a', accountId: 'f'.repeat(32), workers_cmliu: ['w'], stats: { total: 1, max: 100000 } }]);
        // the source object is not mutated: the page can keep rendering the fresh statistics
        expect(result.stats).toMatchObject({ total: 1, accountId: 'f'.repeat(32) });
        expect(result.length).toBe(1);
        expect(vm.runInContext('frontendModules.accountSavePayload(null)', context)).toBeNull();
        // an incomplete statistics object is dropped rather than persisted as invalid config
        expect(vm.runInContext("frontendModules.accountSavePayload([{ alias: 'b', stats: { accountId: 'x' } }])", context)).toEqual([{ alias: 'b' }]);
    });
    it('rejects orphan files and unresolved imports rather than silently omitting them', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-modules-'));
        try {
            fs.mkdirSync(path.join(root, 'frontend/modules'), { recursive: true });
            fs.writeFileSync(path.join(root, 'frontend/modules/index.js'), 'export const present = true;');
            fs.writeFileSync(path.join(root, 'frontend/modules/orphan.js'), 'export const lost = true;');
            expect(() => bundleFrontendModules(root)).toThrow('Unreferenced frontend modules');
            fs.writeFileSync(path.join(root, 'frontend/modules/index.js'), "export { missing } from './missing.js';");
            expect(() => bundleFrontendModules(root)).toThrow();
        } finally {
            // Only the explicitly created temporary test directory is removed.
            const resolved = fs.realpathSync(root);
            const parent = fs.realpathSync(os.tmpdir());
            if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase() || !path.basename(resolved).startsWith('frontend-modules-')) throw new Error('Unsafe test cleanup target');
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    });
});
