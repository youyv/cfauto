// Related checks run in one suite; scoped fixtures preserve isolation. No browser is launched.
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

describe('Workbench and account drawers', () => {
    describe('workbench-drag', () => {
        function setup() {
            const events: Record<string, Function> = {};
            let capture = false;
            const handle = { contains: () => true, classList: { add() {}, remove() {} }, setPointerCapture() { capture = true; }, hasPointerCapture: () => capture, releasePointerCapture() { capture = false; } };
            const panel = { style: { left: '200px', top: '80px', transform: 'translateX(-50%)' }, offsetWidth: 700, offsetHeight: 300, getBoundingClientRect() { return { left: parseFloat(this.style.left), top: parseFloat(this.style.top) }; } };
            const win = { innerWidth: 1200, innerHeight: 800, addEventListener: (name: string, fn: Function) => { events[name] = fn; } };
            vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../frontend/js/workbench.js'), 'utf8'), {
                $: (id: string) => id === 'workbench_drag' ? handle : panel,
                document: { addEventListener: (name: string, fn: Function) => { events[name] = fn; } },
                window: win, registerActions() {},
            });
            const event = (x: number, y: number, interactive = false, pointerId = 1) => ({ button: 0, isPrimary: true, pointerId, clientX: x, clientY: y, target: { closest: () => interactive ? {} : null }, preventDefault() {} });
            return { events, panel, event, win, captured: () => capture };
        }
        describe('workbench free dragging', () => {
            it('moves horizontally and vertically without an initial jump', () => {
                const { events, panel, event } = setup();
                events.pointerdown(event(240, 100));
                expect(panel.style.left).toBe('200px');
                expect(panel.style.transform).toBe('none');
                events.pointermove(event(340, 160));
                expect(panel.style.left).toBe('300px'); expect(panel.style.top).toBe('140px');
            });
            it('ignores button descendants and other pointers', () => {
                const { events, panel, event, captured } = setup();
                events.pointerdown(event(240, 100, true)); expect(captured()).toBe(false);
                events.pointerdown(event(240, 100)); events.pointermove(event(400, 400, false, 2));
                expect(panel.style.left).toBe('200px');
            });
            it('clamps the window and stops dragging on cancellation', () => {
                const { events, panel, event, captured } = setup();
                events.pointerdown(event(240, 100)); events.pointermove(event(5000, 5000));
                expect(panel.style.left).toBe('500px'); expect(panel.style.top).toBe('500px');
                events.pointercancel(event(5000, 5000)); expect(captured()).toBe(false);
                events.pointermove(event(0, 0)); expect(panel.style.left).toBe('500px');
            });
            it('keeps a moved panel reachable when the viewport shrinks', () => {
                const { events, panel, event, win } = setup();
                events.pointerdown(event(240, 100)); events.pointerup(event(240, 100));
                win.innerWidth = 800; win.innerHeight = 350; events.resize();
                expect(panel.style.left).toBe('100px'); expect(panel.style.top).toBe('50px');
            });
        });
    });

    describe('workbench-icons', () => {
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
    });

    describe('account-tools-drawer', () => {
        function setup() {
            const listeners: Record<string, (event: unknown) => void> = {};
            const context = vm.createContext({
                document: { addEventListener: (type: string, callback: (event: unknown) => void) => { listeners[type] = callback; } },
                registerActions: () => {}, switchProjectTab: () => {},
            });
            vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../frontend/js/accounts.js'), 'utf8'), context);
            return { header: () => vm.runInContext('_getTableHeader()', context) as string, listeners };
        }

        describe('account tools drawer', () => {
            it('starts collapsed and keeps all eight actions inside the drawer, search outside', () => {
                const { header } = setup();
                const html = header();
                expect(html).toContain('<details class="account-tools-drawer">');
                const drawer = html.split('</details>')[0];
                for (const action of ['selectAllAccounts', 'deselectAllAccounts', 'batchDeleteAccounts', 'verifyAllCredentials', 'exportAccounts', 'importAccounts', 'backupAll', 'restoreBackup']) {
                    expect(drawer).toContain('data-act="' + action + '"');
                }
                expect(html.split('</details>')[1]).toContain('id="account_search"');
            });
            it('retains toggled state on redraw, ignoring detached old drawers', () => {
                const { header, listeners } = setup();
                const toggle = (open: boolean, isConnected = true) => listeners.toggle({ target: { matches: () => true, open, isConnected } });
                toggle(true);
                expect(header()).toContain('class="account-tools-drawer" open');
                toggle(false, false);
                expect(header()).toContain('class="account-tools-drawer" open');
                toggle(false);
                expect(header()).toContain('<details class="account-tools-drawer">');
            });
            it('strips runtime statistics before sending an account save payload', () => {
                const context = vm.createContext({ document: { addEventListener() {} }, registerActions: () => {}, switchProjectTab: () => {} });
                vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../frontend/js/accounts.js'), 'utf8'), context);
                const payload: any = vm.runInContext("accountSavePayload([{ alias: 'a', accountId: 'f'.repeat(32), stats: { total: 1, max: 2, accountId: 'f'.repeat(32) }, workers_cmliu: ['w'] }])", context);
                expect(JSON.parse(JSON.stringify(payload))).toEqual([{ alias: 'a', accountId: 'f'.repeat(32), workers_cmliu: ['w'] }]);
            });
        });
    });
});
