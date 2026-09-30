import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root = path.resolve(__dirname, '..');
function setup() {
    const calls: unknown[][] = [];
    const lines: any[] = [];
    const log = { appendChild: (line: unknown) => lines.push(line), childElementCount: 0, scrollTop: 0, scrollHeight: 1 };
    const context = vm.createContext({
        UI_ICON_MAP: JSON.parse(fs.readFileSync(path.join(root, 'frontend/vendor/lucide/map.json'), 'utf8')),
        setUiIconText: (element: any, symbol: string, text: string) => { calls.push([symbol, text]); element.textContent = symbol + text; },
        $: () => log, registerActions() {}, window: { addEventListener() {} },
        document: { addEventListener() {}, createTextNode: (text: string) => text,
            createElement: () => ({ textContent: '', insertBefore(text: string) { this.textContent = text + this.textContent; } }) },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'frontend/js/workbench.js'), 'utf8'), context);
    return { calls, lines, write: (message: string) => { context.message = message; vm.runInContext('wbLog(message)', context); }, buffer: () => vm.runInContext('recentWbLogs', context) as string[] };
}
describe('workbench status icons', () => {
    it('decorates preview, summary and success prefixes while preserving raw reports', () => {
        const s = setup();
        for (const message of ['🔍 预览部署 joey...', '📋 将影响 1 个账号', '✅ 预览完成']) s.write(message);
        expect(s.calls.map(c => c[0])).toEqual(['🔍', '📋', '✅']);
        expect(s.buffer()[0]).toContain('🔍 预览部署 joey...');
    });
    it('retains indentation and uses the complete variation-selector symbol', () => {
        const s = setup(); s.write('   ⚠️ 警告');
        expect(s.calls).toEqual([['⚠️', ' 警告']]);
        expect(s.lines[0].textContent).toBe('   ⚠️ 警告');
    });
    it('leaves payload symbols and markup as literal text', () => {
        const s = setup(); s.write('账号 🔒 <script>test</script>');
        expect(s.calls).toEqual([]);
        expect(s.lines[0].textContent).toBe('账号 🔒 <script>test</script>');
        s.write('✅ 账号 🔒 <img onerror=test>');
        expect(s.calls[0]).toEqual(['✅', ' 账号 🔒 <img onerror=test>']);
    });
});
