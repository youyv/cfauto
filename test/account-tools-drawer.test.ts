import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

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
});
