import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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
