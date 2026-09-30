import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
const html = fs.readFileSync('frontend/index.html', 'utf8');
describe('header automation drawer', () => {
    it('defaults to collapsed with all configuration controls and save inside', () => {
        expect(html).toContain('<details class="automation-drawer">');
        const drawer = html.split('<details class="automation-drawer">')[1].split('</details>')[0];
        for (const id of ['auto_update_toggle', 'auto_update_interval', 'auto_cmliu_toggle', 'auto_joey_toggle', 'auto_ech_toggle', 'fuse_threshold', 'fuse_webhook']) {
            expect(drawer).toContain(`id="${id}"`);
            expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
        }
        expect(drawer).toContain('data-act="saveAutoConfig"');
    });
    it('keeps frequent actions outside the drawer', () => {
        const quick = html.split('<details class="automation-drawer">')[0];
        for (const action of ['toggleTheme', 'logout', 'openWorkbench', 'openBatchDeployModal', 'openYxipGuarded']) {
            expect(quick).toContain(`data-act="${action}"`);
        }
    });
});
