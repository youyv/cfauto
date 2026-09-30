import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(__dirname, '..');
function setup() {
    const ctx = vm.createContext({ UI_ICON_MAP: JSON.parse(fs.readFileSync(path.join(root, 'frontend/vendor/lucide/map.json'), 'utf8')) });
    vm.runInContext(fs.readFileSync(path.join(root, 'frontend/js/icons.js'), 'utf8'), ctx);
    return (button: unknown) => { ctx.button = button; vm.runInContext('ensureButtonDescription(button)', ctx); };
}
function button(text: string, action = '', title = '') {
    const attrs: Record<string, string> = { 'data-act': action };
    return { textContent: text, title, getAttribute: (key: string) => attrs[key] || null, setAttribute: (key: string, value: string) => { attrs[key] = value; } };
}
describe('button hover descriptions', () => {
    it('describes icon-only controls and gives them accessible names', () => {
        const apply = setup();
        for (const [action, text] of [['openWorkbench', '📋'], ['closeModal', '×'], ['regenBatchUuid', '🎲'], ['saveAutoConfig', '💾']]) {
            const b = button(text, action); apply(b);
            expect(b.title.length).toBeGreaterThan(2);
            expect(b.getAttribute('aria-label')).toBe(b.title);
        }
    });
    it('preserves explicit titles and changed favorite-state descriptions', () => {
        const apply = setup(); const b = button('☆', '', '收藏此版本');
        apply(b); expect(b.title).toBe('收藏此版本');
        b.title = '取消收藏'; b.textContent = '★'; apply(b);
        expect(b.getAttribute('aria-label')).toBe('取消收藏');
    });
    it('updates generated descriptions when a dynamic text button changes', () => {
        const apply = setup(); const b = button('加载中'); apply(b);
        b.textContent = '重新加载'; apply(b); expect(b.title).toBe('重新加载');
    });
});
