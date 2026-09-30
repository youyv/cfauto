import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const map = JSON.parse(read('frontend/vendor/lucide/map.json')) as Record<string, string>;
describe('local dashboard icons', () => {
    it('vendors every mapped icon as script-free SVG geometry', () => {
        for (const name of new Set(Object.values(map))) {
            const svg = read('frontend/vendor/lucide/' + name + '.svg');
            expect(svg).toContain('viewBox="0 0 24 24"');
            expect(svg).not.toMatch(/<script|<foreignObject|\bon\w+=|\bhref=/i);
        }
    });
    it('resolves every static icon marker', () => {
        const names = new Set(Object.values(map));
        for (const match of read('frontend/index.html').matchAll(/data-ui-icon="([^"]+)"/g)) {
            expect(names.has(match[1])).toBe(true);
        }
    });
    it('preserves the upstream license in the distributable', () => {
        expect(read('frontend/vendor/lucide/LICENSE')).toContain('ISC License');
        expect(read('build.js')).toContain("'/*! Lucide 0.468.0");
    });
    it('preserves icon source text across asynchronous button snapshots', () => {
        for (const file of ['accounts.js', 'deploy.js']) {
            expect(read('frontend/js/' + file)).not.toContain('btn ? btn.innerText');
            expect(read('frontend/js/' + file)).toContain('btn ? btn.textContent');
        }
    });
    it('only auto-decorates explicit markers and buttons, not user content', () => {
        expect(read('frontend/js/icons.js')).toContain("const selector = 'button, [data-ui-icon]'");
        expect(read('frontend/js/icons.js')).toContain("original.textContent = source");
        expect(read('frontend/js/icons.js')).toContain("'aria-hidden', 'true'");
    });
});

// Credential badges are not buttons: render explicitly without scanning account names.
describe('account credential icons', () => {
    it('renders key, token and missing-credential states with the SVG helper', () => {
        const source = read('frontend/js/accounts.js');
        expect(source).toContain("setUiIconText(warn, '⚠️', '')");
        expect(source).toContain("setUiIconText(mode, (a.apiToken && a.authMode !== 'key') ? '🔑' : '🔐', '')");
        expect(source).toContain("mode.setAttribute('aria-label', mode.title)");
        expect(source).toContain("warn.setAttribute('aria-label', warn.title)");
        expect(source).not.toContain("mode.textContent =");
        expect(source).toContain('tdAlias.textContent = a.alias');
    });
});

describe('decorative icon audit', () => {
    it('keeps emoji out of all literal input placeholders', () => {
        const files = ['frontend/index.html', ...fs.readdirSync(path.join(root, 'frontend/js')).map(f => 'frontend/js/' + f)];
        for (const file of files) {
            const source = read(file);
            const placeholders = [...source.matchAll(/placeholder\s*=\s*["']([^"']*)/g)];
            for (const match of placeholders) expect(match[1]).not.toMatch(/[\p{Extended_Pictographic}]/u);
        }
    });
    it('marks the encryption note and search fields for local SVG rendering', () => {
        expect(read('frontend/js/accounts.js')).toContain('class="account-tools-note"><span data-ui-icon="lock">');
        expect(read('frontend/js/accounts.js')).toContain('data-input-icon="search"');
        expect(read('frontend/js/yxip.js')).toContain("setAttribute('data-input-icon', 'search')");
        expect(read('build.js')).toContain('encodeURIComponent(svg)');
    });
    it('resolves markers in dynamic templates as well as static HTML', () => {
        const names = new Set(Object.values(map));
        for (const file of fs.readdirSync(path.join(root, 'frontend/js'))) {
            for (const match of read('frontend/js/' + file).matchAll(/data-ui-icon="([a-z-]+)"/g)) expect(names.has(match[1])).toBe(true);
        }
    });
});

describe('native select and escaped icon regressions', () => {
    it('keeps native option contents text-only and free of emoji', () => {
        for (const match of read('frontend/index.html').matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)) {
            expect(match[1]).not.toMatch(/<[^>]+>|\p{Extended_Pictographic}/u);
        }
    });
    it('renders the secret label explicitly instead of a surrogate-pair emoji', () => {
        const source = read('frontend/js/vars.js');
        expect(source).not.toContain('\\uD83D\\uDD12');
        expect(source).toContain("setUiIconText(secretIcon, '🔒', '')");
    });
    it('updates select decorations for programmatic template switches too', () => {
        expect(read('frontend/js/deploy.js')).toContain("updateSelectIcon($('bd_template'))");
        expect(read('frontend/js/yxip.js')).toContain("updateSelectIcon($('yxip_type'))");
    });
});
