// Related checks run in one suite; scoped fixtures preserve isolation. No browser is launched.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { FRONTEND_CSS } from '../src/frontend-bundle';
import { createRequire } from 'node:module';

describe('UI appearance and accessibility', () => {
    describe('frontend-icons', () => {
        const root = path.resolve(__dirname, '..');
        const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
        const map = JSON.parse(read('frontend/vendor/lucide/map.json')) as Record<string, string>;
        it("vendored assets, static/dynamic references and license", () => {
        // vendors every mapped icon as script-free SVG geometry
        {
                for (const name of new Set(Object.values(map))) {
                    const svg = read('frontend/vendor/lucide/' + name + '.svg');
                    expect(svg).toContain('viewBox="0 0 24 24"');
                    expect(svg).not.toMatch(/<script|<foreignObject|\bon\w+=|\bhref=/i);
                }
            }
        // resolves every static icon marker
        {
                const names = new Set(Object.values(map));
                for (const match of read('frontend/index.html').matchAll(/data-ui-icon="([^"]+)"/g)) {
                    expect(names.has(match[1])).toBe(true);
                }
            }
        // preserves the upstream license in the distributable
        {
                expect(read('frontend/vendor/lucide/LICENSE')).toContain('ISC License');
                expect(read('build.js')).toContain("'/*! Lucide 0.468.0");
            }
        // resolves markers in dynamic templates as well as static HTML
        {
                const names = new Set(Object.values(map));
                for (const file of fs.readdirSync(path.join(root, 'frontend/js'))) {
                    for (const match of read('frontend/js/' + file).matchAll(/data-ui-icon="([a-z-]+)"/g)) expect(names.has(match[1])).toBe(true);
                }
            }
        });
        it("explicit, accessible and non-destructive icon integration", () => {
        // preserves DOM nodes across asynchronous button states
        {
                for (const file of ['accounts.js', 'deploy.js']) {
                    expect(read('frontend/js/' + file)).not.toContain('btn ? btn.innerText');
                    expect(read('frontend/js/' + file)).toContain('beginButtonBusy(btn,');
                }
            }
        // only mounts explicit icons and never scans button text
        {
                expect(read('frontend/js/icons.js')).toContain("const selector = 'button, [data-ui-icon]'");
                expect(read('frontend/js/icons.js')).toContain("original.textContent = source");
                expect(read('frontend/js/icons.js')).not.toContain('createTreeWalker');
                expect(read('frontend/js/icons.js')).not.toContain('UI_ICON_PATTERN');
                expect(read('frontend/js/icons.js')).toContain("'aria-hidden', 'true'");
            }
        // renders key, token and missing-credential states with the SVG helper
        {
                const source = read('frontend/js/accounts.js');
                expect(source).toContain("setUiContent(warn, 'triangle-alert', '')");
                expect(source).toContain("setUiContent(mode, (a.apiToken && a.authMode !== 'key') ? 'key-round' : 'shield-check', '')");
                expect(source).toContain("mode.setAttribute('aria-label', mode.title)");
                expect(source).toContain("warn.setAttribute('aria-label', warn.title)");
                expect(source).not.toContain("mode.textContent =");
                expect(source).toContain('tdAlias.textContent = a.alias');
            }
        // marks the encryption note and search fields for local SVG rendering
        {
                expect(read('frontend/js/accounts.js')).toContain('class="account-tools-note"><span data-ui-icon="lock">');
                expect(read('frontend/js/accounts.js')).toContain('data-input-icon="search"');
                expect(read('frontend/js/yxip.js')).toContain("setAttribute('data-input-icon', 'search')");
                expect(read('build.js')).toContain('encodeURIComponent(svg)');
            }
        // renders the secret label explicitly instead of a surrogate-pair emoji
        {
                const source = read('frontend/js/vars.js');
                expect(source).not.toContain('\\uD83D\\uDD12');
                expect(source).toContain("setUiContent(secretIcon, 'lock', '')");
            }
        // updates select decorations for programmatic template switches too
        {
                expect(read('frontend/js/deploy.js')).toContain("updateSelectIcon($('bd_template'))");
                expect(read('frontend/js/yxip.js')).toContain("updateSelectIcon($('yxip_type'))");
            }
        });
        it("native editable text remains free of decorative markup", () => {
        // keeps emoji out of all literal input placeholders
        {
                const files = ['frontend/index.html', ...fs.readdirSync(path.join(root, 'frontend/js')).map(f => 'frontend/js/' + f)];
                for (const file of files) {
                    const source = read(file);
                    const placeholders = [...source.matchAll(/placeholder\s*=\s*["']([^"']*)/g)];
                    for (const match of placeholders) expect(match[1]).not.toMatch(/[\p{Extended_Pictographic}]/u);
                }
            }
        // keeps native option contents text-only and free of emoji
        {
                for (const match of read('frontend/index.html').matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)) {
                    expect(match[1]).not.toMatch(/<[^>]+>|\p{Extended_Pictographic}/u);
                }
            }
        });
    });

    describe('ui-conventions', () => {
        const root = path.resolve(__dirname, '..');
        const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
        const files = ['frontend/index.html', ...fs.readdirSync(path.join(root, 'frontend/js')).filter(f => f.endsWith('.js')).map(f => 'frontend/js/' + f)];
        const names = new Set(Object.values(JSON.parse(read('frontend/vendor/lucide/map.json'))));
        it("native controls have types, unique ARIA targets and accessible field names", () => {
        // declares non-submit type for literal and DOM-created application buttons
        {
                for (const file of files) {
                    const source = read(file);
                    for (const match of source.matchAll(/<button\b[^>]*>/g)) expect(match[0], file).toContain('type="button"');
                    for (const match of source.matchAll(/const (\w+) = document\.createElement\('button'\);/g)) {
                        expect(source.slice(match.index! + match[0].length).trimStart(), file).toMatch(new RegExp('^' + match[1] + "\\.type = 'button';"));
                    }
                }
            }
        // resolves static ARIA control, label and description references to unique elements
        {
                const html = read('frontend/index.html');
                const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
                for (const match of html.matchAll(/\baria-(?:controls|labelledby|describedby)="([^"]+)"/g)) {
                    for (const id of match[1].trim().split(/\s+/)) expect(ids.filter(value => value === id), id).toHaveLength(1);
                }
            }
        // provides field and switch names without replacing native controls
        {
                const vars = read('frontend/js/vars.js');
                expect(vars).toContain("keyInput.setAttribute('aria-label', '变量名称')");
                expect(vars).toContain("valInput.setAttribute('aria-label', '变量值')");
                expect(vars).toContain("secChk.type = 'checkbox'");
                expect(vars).toContain("secChk.setAttribute('aria-label', '标记为 Secret 变量')");
            }
        });
        it("only explicit icon adapters are allowed on non-interactive decoration", () => {
        // restricts the legacy symbol adapter to workbench prefixes
        {
                for (const file of files.filter(f => !/\/(icons|workbench)\.js$/.test(f))) expect(read(file), file).not.toContain('setUiIconText(');
                // The same no-text-scanning guard is owned by the icon integration contract above.
            }
        // uses known explicit icon names and never marks interactive elements decorative
        {
                for (const file of files) {
                    const source = read(file);
                    for (const match of source.matchAll(/setUiContent\([^,\n]+, '([^']+)'/g)) expect(names.has(match[1]), file + ': ' + match[1]).toBe(true);
                    expect(source, file).not.toMatch(/<(?:button|input|select)\b[^>]*\bdata-ui-icon=/);
                }
            }
        });
    });

    describe('button-descriptions', () => {
        const root = path.resolve(__dirname, '..');
        function setup() {
            const ctx = vm.createContext({ UI_ICON_MAP: JSON.parse(fs.readFileSync(path.join(root, 'frontend/vendor/lucide/map.json'), 'utf8')) });
            vm.runInContext(fs.readFileSync(path.join(root, 'frontend/js/icons.js'), 'utf8'), ctx);
            return (button: unknown) => { ctx.button = button; vm.runInContext('ensureButtonDescription(button)', ctx); };
        }
        function button(text: string, action = '', title = '', decorative = false) {
            const attrs: Record<string, string> = { 'data-act': action };
            return { textContent: text, title, cloneNode() { return { textContent: decorative ? '' : this.textContent, querySelectorAll: () => [] }; }, getAttribute: (key: string) => attrs[key] || null, setAttribute: (key: string, value: string) => { attrs[key] = value; } };
        }
        describe('button hover descriptions', () => {
            it('describes icon-only controls and gives them accessible names', () => {
                const apply = setup();
                for (const [action, text] of [['openWorkbench', '📋'], ['closeModal', '×'], ['regenBatchUuid', '🎲'], ['saveAutoConfig', '💾']]) {
                    const b = button(text, action, '', true); apply(b);
                    expect(b.title.length).toBeGreaterThan(2);
                    expect(b.getAttribute('aria-label')).toBe(b.title);
                }
            });
            it('preserves explicit titles and changed favorite-state descriptions', () => {
                const apply = setup(); const b = button('☆', '', '收藏此版本', true);
                apply(b); expect(b.title).toBe('收藏此版本');
                b.title = '取消收藏'; b.textContent = '★'; apply(b);
                expect(b.getAttribute('aria-label')).toBe('取消收藏');
            });
            it('does not remove symbol-like user text from a generated title', () => {
                const apply = setup(); const b = button('账号 ★ 🚀 ×'); apply(b);
                expect(b.title).toBe('账号 ★ 🚀 ×');
            });
            it('updates generated descriptions when a dynamic text button changes', () => {
                const apply = setup(); const b = button('加载中'); apply(b);
                b.textContent = '重新加载'; apply(b); expect(b.title).toBe('重新加载');
            });
        });
    });

    describe('select-icon-colors', () => {
        it('synchronizes template icon colours and clears stale colours', () => {
            const attrs: Record<string, string> = {};
            let option: Record<string, string> = {};
            const select = {
                selectedOptions: [{ getAttribute: (key: string) => option[key] || null }],
                setAttribute: (key: string, value: string) => { attrs[key] = value; },
                removeAttribute: (key: string) => { delete attrs[key]; },
            };
            const context = vm.createContext({ UI_ICON_MAP: {}, UI_ICON_PATHS: { box: '<path/>', rocket: '<path/>' }, select });
            vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../frontend/js/icons.js'), 'utf8'), context);
            for (const tone of ['cmliu', 'joey', 'ech']) {
                option = { 'data-option-icon': 'box', 'data-option-tone': tone };
                vm.runInContext('updateSelectIcon(select)', context);
                expect(attrs['data-icon-tone']).toBe(tone);
                expect(attrs['data-input-icon']).toBe('box');
            }
            option = { 'data-option-icon': 'rocket' };
            vm.runInContext('updateSelectIcon(select)', context);
            expect(attrs['data-icon-tone']).toBeUndefined();
            expect(attrs['data-input-icon']).toBe('rocket');
        });
    });

    describe('local-css', () => {
        describe('production local Tailwind', () => {
            it('contains utilities from dynamic UI and responsive wrappers', () => {
                for (const selector of ['.hidden{', '.text-red-500{', '.text-green-400{', '.bg-blue-500{', '.max-h-60{']) expect(FRONTEND_CSS).toContain(selector);
                expect(FRONTEND_CSS).toContain('@media (min-width:768px)');
            });
            it('does not rely on runtime Tailwind CDN in page, CSP or test server', () => {
                for (const file of ['src/index.ts', 'src/config/login-html.ts', 'test/e2e/server.cjs']) expect(fs.readFileSync(file, 'utf8')).not.toContain('cdn.tailwindcss.com');
                expect(fs.readFileSync('test/e2e/server.cjs', 'utf8')).not.toContain('tailwindcss/lib/cli');
            });
        });
    });

    describe('reduced-motion', () => {
        // Configuration import only: no Playwright runner or browser is launched.
        // Cold package loading is setup work, not the per-test assertion being measured.
        const browserContextConfig = createRequire(import.meta.url)('../playwright.config.cjs');
        function setup(reduced = false) {
            const motion = { matches: reduced, addEventListener: (_: string, fn: () => void) => { change = fn; } };
            let change = () => {};
            const frames = new Map<number, unknown>();
            let serial = 0;
            const button = { style: { transform: '' } };
            const attrs: Record<string, string> = {};
            const listeners: Record<string, () => void> = {};
            const document = { hidden: false, readyState: 'loading', documentElement: {
                getAttribute: (k: string) => attrs[k], setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; }
            }, body: { style: { setProperty() {}, removeProperty() {} } }, getElementById: () => button,
            addEventListener: (k: string, fn: () => void) => { listeners[k] = fn; } };
            const ctx = vm.createContext({ document, window: { matchMedia: (q: string) => q.includes('reduced-motion') ? motion : { matches: false, addEventListener() {} } },
                localStorage: { getItem: () => null, setItem() {} }, registerActions() {}, setUiContent() {}, console,
                requestAnimationFrame: (fn: unknown) => { frames.set(serial, fn); return serial++; }, cancelAnimationFrame: (id: number) => frames.delete(id), setTimeout() {} });
            vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../frontend/js/starfield.js'), 'utf8'), ctx);
            // A scene stub avoids canvas dependence; no queued frame is executed.
            vm.runInContext('starScene = { canvas: {}, ctx: {}, shootingStars: [] }', ctx);
            return { run: (s: string) => vm.runInContext(s, ctx), frames, button, document,
                change: (value: boolean) => { motion.matches = value; change(); }, visibility: () => listeners.visibilitychange() };
        }
        describe('reduced motion lifecycle', () => {
            it('passes the preference through browser context options, not an unsupported test option', () => {
                expect(browserContextConfig.use.contextOptions.reducedMotion).toBe('reduce');
                expect(browserContextConfig.use.reducedMotion).toBeUndefined();
            });
            it('does not schedule dark canvas or button rotation with the preference enabled', () => {
                const s = setup(true); s.run('toggleTheme()');
                expect(s.frames.size).toBe(0); expect(s.button.style.transform).toBe('');
            });
            it('cancels frame ID zero and does not duplicate loops', () => {
                const s = setup(); s.run('setDarkMode(true); initStarfield()'); expect(s.frames.size).toBe(1);
                s.run('stopStarfield()'); expect(s.frames.size).toBe(0);
            });
            it('responds to preference changes and resumes only a visible dark page', () => {
                const s = setup(); s.run('setDarkMode(true)'); expect(s.frames.size).toBe(1);
                s.change(true); expect(s.frames.size).toBe(0);
                s.visibility(); expect(s.frames.size).toBe(0);
                s.document.hidden = true; s.change(false); expect(s.frames.size).toBe(0);
                s.document.hidden = false; s.visibility(); expect(s.frames.size).toBe(1);
                s.run('setDarkMode(false)'); s.change(true); s.change(false); expect(s.frames.size).toBe(0);
            });
            it('does not restart a hidden page through theme application', () => {
                const s = setup(); s.document.hidden = true; s.run('setDarkMode(true)'); expect(s.frames.size).toBe(0);
            });
        });
    });
});
