import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteFixture } from './sqlite-fixture';
import { ConfigStore } from '../../src/reliability/config-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { CredentialAuthority } from '../../src/reliability/credential-authority';
import { ConfigEditor, parseConfigEdit, parseConfigSelector, splitAutomationConfig, legacyConfigEdit } from '../../src/reliability/config-editor';
import { migrateCredentialAccounts, readCredentialAccounts } from '../../src/reliability/credential-accounts';
import { manifestDigest } from '../../src/reliability/protocol';
const opened: ReturnType<typeof sqliteFixture>[] = [];
const ring = { currentId: 'new', keys: { new: 'local-only-secret-at-least-32-bytes' } };
const account = { accountId: 'a'.repeat(32), alias: 'one', email: '', globalKey: '', apiToken: 'mock-token-only', authMode: 'token' as const, workers_cmliu: ['demo'] };
const week = 7 * 24 * 60 * 60 * 1000;
async function fixture() {
    const f = sqliteFixture(); opened.push(f);
    const config = new ConfigStore(f.db), dispatch = new TaskDispatch(f.db, new Uint8Array(32).fill(7));
    let now = 1000;
    const authority = new CredentialAuthority(f.db, config, dispatch, ring, () => now);
    const records: any[] = [
        { domain: 'accounts', revision: 1, value: await migrateCredentialAccounts([account], ring, 'plaintext') },
        { domain: 'autoConfig', revision: 1, value: { enabled: true, interval: 30 } },
        { domain: 'vars:joey', revision: 1, value: [{ key: 'other', value: 'kept', secret: true }, { key: 'yx', value: 'old' }] }
    ];
    config.beginImport('g1', await manifestDigest(records), records.length); records.forEach(r => config.stage('g1', r)); await config.activateInitial('g1', 0);
    await authority.initialize('g1', 1); config.setMaintenance(false, 1);
    const make = () => new ConfigEditor(f.db, config, authority, ring, new Uint8Array(32).fill(9));
    const editor = make();
    const input = (selector: any, value: any, rev = 0, key = 'edit-1') => ({ key, generation: 'g1', epoch: 2, revision: rev, selector, value });
    const put = (domain: string, value: any) => config.compareAndSet('g1', [{ domain, expectedRevision: config.read([domain]).records[0].revision, value }]);
    return { ...f, config, dispatch, authority, editor, make, input, put, setNow: (time: number) => { now = time; } };
}
afterEach(() => { vi.restoreAllMocks(); for (const f of opened.splice(0)) f.sql.close(); });
describe('authoritative configuration editor', () => {
    it.each([{ kind: 'accounts', template: 'cmliu' }, { kind: 'variables' }, { kind: 'variables', template: '__proto__' }, { kind: 'upstream', template: 'ech' }, { kind: 'override', template: 'joey' }, { kind: 'auto', scope: 'admin' }, { kind: 'runtime' }])('rejects arbitrary selectors %j', selector => {
        expect(() => parseConfigSelector(selector)).toThrow(/^INVALID$/);
    });
    it('rejects arbitrary patches and direct deployment ledger edits', async () => {
        const f = await fixture();
        for (const extra of [{ changes: [] }, { handler: 'save' }, { expected: [] }, { scope: 'admin' }]) expect(() => parseConfigEdit({ ...f.input({ kind: 'auto' }, {}, 1), ...extra })).toThrow(/^INVALID$/);
        await expect(f.editor.edit(f.input({ kind: 'deploy', template: 'joey' }, { currentSha: 'fake' }))).rejects.toThrow(/^INVALID$/);
    });
    it.each([null, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1])('rejects invalid edit stamps %j', async revision => {
        const f = await fixture(); await expect(f.editor.edit(f.input({ kind: 'auto' }, {}, revision as any))).rejects.toThrow(/^INVALID$/);
    });
    it('returns masked accounts and exact config stamps without exposing ciphertext or plaintext', async () => {
        const f = await fixture(), result: any = await f.editor.read({ kind: 'accounts' });
        expect(result).toMatchObject({ generation: 'g1', epoch: 2, revision: 1 });
        expect(result.value[0]).toMatchObject({ apiToken: '***', globalKey: '', credentialRevision: 1, workers_cmliu: ['demo'] });
        expect(JSON.stringify(result)).not.toMatch(/mock-token|v2:/);
        f.sql.prepare("UPDATE config_records SET payload=? WHERE domain='accounts'").run(JSON.stringify([{ ...account, apiToken: 'v2:bad', credentialRevision: 1 }]));
        await expect(f.editor.read({ kind: 'accounts' })).rejects.toThrow();
    });
    it('commits validated variables and replays the same receipt after reconstruction', async () => {
        const f = await fixture(), input = f.input({ kind: 'variables', template: 'cmliu' }, [{ key: ' KEY ', value: 'secret-value', secret: true }]);
        const first = await f.editor.edit(input);
        expect(first).toEqual({ generation: 'g1', epoch: 2, domain: 'vars:cmliu', revision: 1, duplicate: false });
        expect(await f.make().edit(input)).toEqual({ ...first as any, duplicate: true });
        expect(f.config.read(['vars:cmliu']).records[0]).toMatchObject({ revision: 1, value: [{ key: 'KEY', value: 'secret-value', secret: true }] });
        const receipts = JSON.stringify(f.db.rows('SELECT * FROM config_edit_receipts'));
        expect(receipts).not.toMatch(/secret-value|KEY/);
        expect(f.config.pendingProjection().filter(r => r.domain === 'vars:cmliu')).toHaveLength(1);
    });
    it('allows a lost ACK replay during maintenance but refuses a new key without effects', async () => {
        const f = await fixture(), input = f.input({ kind: 'auto' }, { enabled: false }, 1);
        await f.editor.edit(input); f.config.setMaintenance(true, 2);
        expect(await f.editor.edit(input)).toMatchObject({ duplicate: true });
        const before = f.config.readAll();
        await expect(f.editor.edit({ ...input, key: 'new', epoch: 3, revision: 2 })).rejects.toThrow(/^MAINTENANCE$/);
        expect(f.config.readAll()).toEqual(before); expect(f.db.rows('SELECT * FROM config_edit_receipts')).toHaveLength(1);
    });
    it('rejects same key with different content rather than overwriting its receipt', async () => {
        const f = await fixture(), input = f.input({ kind: 'auto' }, { enabled: true }, 1);
        await f.editor.edit(input); await expect(f.editor.edit({ ...input, value: { enabled: false } })).rejects.toThrow(/^CONFLICT$/);
        expect(f.config.read(['autoConfig']).records[0].revision).toBe(2);
    });
    it('freezes the input before the HMAC await and prevents two stale tabs losing an edit', async () => {
        const f = await fixture(), input = f.input({ kind: 'auto' }, { enabled: false }, 1);
        const work = f.editor.edit(input); input.value.enabled = true; await work;
        expect((f.config.read(['autoConfig']).records[0].value as any).enabled).toBe(false);
        await expect(f.editor.edit({ ...input, key: 'other-tab' })).rejects.toThrow(/^CONFLICT$/);
    });
    it('rejects wrong generation, epoch ABA and stale CAS immediately before commit', async () => {
        const f = await fixture(), input = f.input({ kind: 'auto' }, {}, 1);
        await expect(f.editor.edit({ ...input, generation: 'g2' })).rejects.toThrow(/^CONFLICT$/);
        const original = f.config.compareAndSet.bind(f.config);
        vi.spyOn(f.config, 'compareAndSet').mockImplementationOnce((...args) => { f.config.setMaintenance(true, 2); f.config.setMaintenance(false, 3); return original(...args); });
        await expect(f.editor.edit(input)).rejects.toThrow(/^CONFLICT$/);
        expect(f.db.rows('SELECT * FROM config_edit_receipts')).toEqual([]);
        expect(f.config.read(['autoConfig']).records[0].revision).toBe(1);
    });
    it('rolls back config and projection if receipt insertion fails', async () => {
        const f = await fixture(), before = f.config.readAll();
        f.sql.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON config_edit_receipts BEGIN SELECT RAISE(ABORT,'test receipt failure'); END");
        await expect(f.editor.edit(f.input({ kind: 'auto' }, {}, 1))).rejects.toThrow('test receipt failure');
        expect(f.config.readAll()).toEqual(before); expect(f.db.rows('SELECT * FROM config_edit_receipts')).toEqual([]);
    });
    it('rolls back a receipt if a later config write fails', async () => {
        const f = await fixture(), before = f.config.readAll();
        f.sql.exec("CREATE TRIGGER reject_config BEFORE INSERT ON config_records BEGIN SELECT RAISE(ABORT,'test config failure'); END");
        await expect(f.editor.edit(f.input({ kind: 'auto' }, {}, 1))).rejects.toThrow('test config failure');
        expect(f.config.readAll()).toEqual(before); expect(f.db.rows('SELECT * FROM config_edit_receipts')).toEqual([]);
    });
    it.each([[{ key: 'a', value: {} }], [{ key: 'a', value: 'x', namespace_id: 'fake' }], [{ key: 'a', value: 'x', secret: 'true' }], [{ key: 'a', value: '1' }, { key: 'a', value: '2' }]])('rejects unsafe variable rows %#', async value => {
        const f = await fixture(); await expect(f.editor.edit(f.input({ kind: 'variables', template: 'cmliu' }, value))).rejects.toThrow(/^INVALID$/);
        expect(f.config.read(['vars:cmliu']).records[0].revision).toBe(0);
    });
    it('keeps runtime separate and rejects browser attempts to reset timestamps', async () => {
        const f = await fixture(); f.config.recordRuntime('cron-1', { lastCheck: 100, lastGc: 80 });
        for (const value of [{ lastCheck: 0 }, { lastGc: 0 }, { enabled: 'false' }, { interval: '30' }]) await expect(f.editor.edit(f.input({ kind: 'auto' }, value, 1))).rejects.toThrow(/^INVALID$/);
        await f.editor.edit(f.input({ kind: 'auto' }, { enabled: false, interval: 45, autoJoey: false }, 1));
        expect(await f.editor.read({ kind: 'auto' })).toMatchObject({ value: { enabled: false, interval: 45, autoJoey: false }, runtime: { revision: 1, value: { lastCheck: 100, lastGc: 80 } } });
        expect(f.config.read(['autoConfig']).records[0].value).not.toHaveProperty('lastCheck');
    });
    it('will not silently erase legacy runtime embedded in autoConfig', async () => {
        const f = await fixture(); f.put('autoConfig', { enabled: true, lastCheck: 100 });
        await expect(f.editor.edit(f.input({ kind: 'auto' }, {}, 2))).rejects.toThrow(/^NOT_READY$/);
        await expect(f.editor.read({ kind: 'auto' })).rejects.toThrow(/^NOT_READY$/);
        expect((f.config.read(['autoConfig']).records[0].value as any).lastCheck).toBe(100);
    });
    it('updates only Joey yx and preserves other variable secrets without remote calls', async () => {
        const f = await fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
        await f.editor.edit(f.input({ kind: 'joey_nodes' }, '1.2.3.4\nexample.test', 1));
        expect(f.config.read(['vars:joey']).records[0].value).toEqual([{ key: 'other', value: 'kept', secret: true }, { key: 'yx', value: '1.2.3.4\nexample.test' }]);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('adds Joey yx once and rejects malformed or oversized nodes', async () => {
        const f = await fixture(); f.put('vars:joey', []);
        for (const value of ['', '  ', 'x'.repeat(8193), { rawContent: 'x' }]) await expect(f.editor.edit(f.input({ kind: 'joey_nodes' }, value, 2))).rejects.toThrow(/^INVALID$/);
        const input = f.input({ kind: 'joey_nodes' }, 'line', 2); await f.editor.edit(input); await f.make().edit(input);
        expect(f.config.read(['vars:joey']).records[0].value).toEqual([{ key: 'yx', value: 'line' }]);
    });
    it('does not replace corrupt Joey settings with an empty list', async () => {
        const f = await fixture(); f.put('vars:joey', { corrupt: true });
        await expect(f.editor.edit(f.input({ kind: 'joey_nodes' }, 'line', 2))).rejects.toThrow(/^NOT_READY$/);
        expect(f.config.read(['vars:joey']).records[0].revision).toBe(2);
    });
    it('normalizes explicit upstreams but does not issue validation downloads or write caches', async () => {
        const f = await fixture(), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
        await f.editor.edit(f.input({ kind: 'upstream', template: 'joey' }, { path: ' custom/worker.js ', branch: ' next ' }));
        expect(f.config.read(['upstream:joey']).records[0].value).toEqual({ path: 'custom/worker.js', branch: 'next' });
        expect(f.config.pendingProjection().at(-1)).toMatchObject({ domain: 'upstream:joey' }); expect(fetch).not.toHaveBeenCalled();
    });
    it.each([{ path: '../x', branch: 'main' }, { path: 'https://evil.test/x', branch: 'main' }, { path: 'x', branch: 'main', url: 'https://evil.test' }])('rejects unsafe upstream %j', async value => {
        const f = await fixture(); await expect(f.editor.edit(f.input({ kind: 'upstream', template: 'cmliu' }, value))).rejects.toThrow(/^INVALID$/);
    });
    it('applies favorite add/remove commands with CAS and does not duplicate an existing SHA', async () => {
        const f = await fixture(), selector = { kind: 'favorites', template: 'joey' }, item = { sha: 'a'.repeat(40), alias: 'one' };
        await f.editor.edit(f.input(selector, { action: 'add', item }));
        await f.editor.edit(f.input(selector, { action: 'add', item: { ...item, alias: 'not overwritten' } }, 1, 'again'));
        expect(f.config.read(['favorites:joey']).records[0].value).toEqual([item]);
        await f.editor.edit(f.input(selector, { action: 'remove', item: { sha: item.sha } }, 2, 'remove'));
        expect(f.config.read(['favorites:joey']).records[0].value).toEqual([]);
    });
    it('rejects malformed favorite contents and corrupt stored lists', async () => {
        const f = await fixture(), selector = { kind: 'favorites', template: 'joey' };
        for (const value of [{ action: 'clear', item: { sha: 'a'.repeat(40) } }, { action: 'add', item: { sha: 'bad' } }, { action: 'add', item: { sha: 'a'.repeat(40), source: 'injected' } }]) await expect(f.editor.edit(f.input(selector, value))).rejects.toThrow(/^INVALID$/);
        f.put('favorites:joey', {});
        await expect(f.editor.edit(f.input(selector, { action: 'add', item: { sha: 'a'.repeat(40) } }, 1))).rejects.toThrow(/^NOT_READY$/);
    });
    it('uses CredentialAuthority for metadata, observation and durable credential replay', async () => {
        const f = await fixture(), masked = { ...account, apiToken: '***', alias: 'renamed' };
        await f.editor.edit(f.input({ kind: 'accounts' }, [masked], 1));
        const stored = f.config.read(['accounts']).records[0].value as any[];
        expect(stored[0]).toMatchObject({ alias: 'renamed', credentialRevision: 1 }); expect(stored[0].apiToken).toMatch(/^v2:/);
        const change = f.input({ kind: 'accounts' }, [{ ...masked, apiToken: 'new-token-not-in-receipts' }], 2, 'rotate');
        await expect(f.editor.edit(change)).rejects.toThrow(/^MAINTENANCE$/);
        f.setNow(1000 + week); const first = await f.editor.edit(change);
        expect(await f.make().edit(change)).toEqual({ ...first as any, duplicate: true });
        expect((await readCredentialAccounts(f.config.read(['accounts']).records[0].value as any, ring))[0]).toMatchObject({ credentialRevision: 2, apiToken: 'new-token-not-in-receipts' });
        expect(JSON.stringify(f.db.rows('SELECT * FROM config_edit_receipts'))).not.toContain('new-token');
    });
    it('answers concurrent identical account edits from a single atomic receipt', async () => {
        const f = await fixture(), input = f.input({ kind: 'accounts' }, [{ ...account, alias: 'new', apiToken: '***' }], 1);
        const results = await Promise.all([f.editor.edit(input), f.make().edit(input)]);
        expect(results.map((r: any) => r.duplicate).sort()).toEqual([false, true]);
        expect(f.config.read(['accounts']).records[0].revision).toBe(2); expect(f.db.rows('SELECT * FROM config_edit_receipts')).toHaveLength(1);
    });
    it('blocks credential changes/removal during tasks while permitting metadata edits', async () => {
        const f = await fixture(); f.setNow(1000 + week);
        await f.dispatch.submit({ scope: 'test', key: 'task', targets: [{ account: account.accountId, snapshot: 'snap', steps: ['upload'] }] });
        await expect(f.editor.edit(f.input({ kind: 'accounts' }, [], 1))).rejects.toThrow(/^CONFLICT$/);
        await expect(f.editor.edit(f.input({ kind: 'accounts' }, [{ ...account, apiToken: 'changed' }], 1))).rejects.toThrow(/^CONFLICT$/);
        await f.editor.edit(f.input({ kind: 'accounts' }, [{ ...account, apiToken: '***', alias: 'new' }], 1));
        expect(f.config.read(['accounts']).records[0].revision).toBe(2);
    });
    it('atomically removes only deleted-account overrides and retains unrelated domains', async () => {
        const f = await fixture(); f.setNow(1000 + week);
        const removed = 'override:joey:' + account.accountId, retained = 'override:cmliu:' + 'b'.repeat(32);
        f.put(removed, [{ key: 'x', value: 'private' }]); f.put(retained, [{ key: 'x', value: 'kept' }]);
        await f.editor.edit(f.input({ kind: 'accounts' }, [], 1));
        expect(f.config.read([removed, retained]).records.map(r => r.value)).toEqual([null, [{ key: 'x', value: 'kept' }]]);
        expect(f.config.read(['vars:joey']).records[0].revision).toBe(1);
    });
    it('detects phantom override creation during removal instead of leaving orphaned data', async () => {
        const f = await fixture(); f.setNow(1000 + week); const real = f.config.compareAndSet.bind(f.config);
        vi.spyOn(f.config, 'compareAndSet').mockImplementationOnce((...args) => {
            real('g1', [{ domain: 'override:joey:' + account.accountId, expectedRevision: 0, value: [] }]); return real(...args);
        });
        await expect(f.editor.edit(f.input({ kind: 'accounts' }, [], 1))).rejects.toThrow(/^CONFLICT$/);
        expect(f.config.read(['accounts']).records[0].revision).toBe(1); expect(f.db.rows('SELECT * FROM config_edit_receipts')).toEqual([]);
    });
    it('rolls back credentials and removed-account cleanup if any companion write fails', async () => {
        const f = await fixture(); f.setNow(1000 + week); f.put('override:joey:' + account.accountId, []);
        const before = f.config.readAll();
        f.sql.exec("CREATE TRIGGER reject_override BEFORE INSERT ON config_records WHEN NEW.domain LIKE 'override:%' BEGIN SELECT RAISE(ABORT,'test override failure'); END");
        await expect(f.editor.edit(f.input({ kind: 'accounts' }, [], 1))).rejects.toThrow('test override failure');
        expect(f.config.readAll()).toEqual(before); expect(f.db.rows('SELECT * FROM config_edit_receipts')).toEqual([]);
    });
});
describe('legacy automation runtime split preparation', () => {
    it('preserves both monotonic timestamps without mutating the legacy input', () => {
        const old = { enabled: false, interval: 45, lastCheck: 100, lastGc: 80 };
        expect(splitAutomationConfig(old)).toEqual({ config: { enabled: false, interval: 45, fuseThreshold: 0, fuseWebhook: '' }, runtime: { lastCheck: 100, lastGc: 80 } });
        expect(old).toHaveProperty('lastCheck', 100);
    });
    it.each([{ lastCheck: -1 }, { lastGc: 1.5 }, { lastCheck: null }, { lastGc: '100' }, { lastCheck: Number.MAX_SAFE_INTEGER + 1 }, { unknown: true }])('does not normalize invalid legacy runtime into zero %j', input => {
        expect(() => splitAutomationConfig(input)).toThrow(/^INVALID$/);
    });
});

describe('legacy configuration HTTP intent with explicit revision headers', () => {
    const request = (url: string, extra: Record<string, string> = {}) => new Request('https://panel.test' + url, { method: 'POST', headers: { 'idempotency-key': 'once', 'x-config-generation': 'g1', 'x-config-epoch': '2', 'x-config-revision': '1', ...extra } });
    it.each([
        ['/api/accounts', [], { kind: 'accounts' }],
        ['/api/auto_config', { enabled: true }, { kind: 'auto' }],
        ['/api/settings?type=joey', [], { kind: 'variables', template: 'joey' }],
        ['/api/favorites?type=cmliu', { action: 'add', item: { sha: 'a'.repeat(40) } }, { kind: 'favorites', template: 'cmliu' }],
        ['/api/upstream?type=joey', { path: '', branch: '' }, { kind: 'upstream', template: 'joey' }]
    ])('maps only the registered legacy mutation %s', (url, value, selector) => {
        expect(legacyConfigEdit(request(url as string), value)).toEqual({ key: 'once', generation: 'g1', epoch: 2, revision: 1, selector, value });
    });
    it('maps Joey non-KV nodes to global config, not a remote task or account override', () => {
        expect(legacyConfigEdit(request('/api/save_yxip'), { type: 'joey_var', rawContent: 'local-node' })).toMatchObject({ selector: { kind: 'joey_nodes' }, value: 'local-node' });
        expect(() => legacyConfigEdit(request('/api/save_yxip'), { type: 'joey_var', rawContent: 'node', accountId: account.accountId })).toThrow(/^INVALID$/);
    });
    it.each(['/api/settings', '/api/settings?type=joey&type=cmliu', '/api/auto_config?type=joey', '/api/accounts?handler=restore', '/api/upstream?type=ech', '/api/restore', '/api/settings?type=__proto__'])('rejects ambiguous or unregistered legacy URL %s', url => {
        expect(() => legacyConfigEdit(request(url), [])).toThrow(/^INVALID$/);
    });
    it.each([['x-config-epoch', ''], ['x-config-revision', '01'], ['x-config-revision', '-1'], ['x-config-revision', '9007199254740992'], ['idempotency-key', ''], ['x-config-generation', '']])('never guesses missing or invalid %s', (header, value) => {
        expect(() => legacyConfigEdit(request('/api/accounts', { [header]: value }), [])).toThrow(/^INVALID$/);
    });
});


describe('editable per-template compatibility dates', () => {
    it('defaults to the upstream-suggested Joey date and stores a validated override', async () => {
        const f = await fixture();
        const initial: any = await f.editor.read({ kind: 'template', template: 'joey' });
        expect(initial).toMatchObject({ generation: 'g1', epoch: 2, revision: 0, value: { compatibilityDate: '2026-01-20' } });
        const input = f.input({ kind: 'template', template: 'joey' }, { compatibilityDate: '2025-12-01' });
        const first: any = await f.editor.edit(input);
        expect(first).toEqual({ generation: 'g1', epoch: 2, domain: 'template:joey', revision: 1, duplicate: false });
        expect(await f.make().edit(input)).toEqual({ ...first, duplicate: true });
        const after: any = await f.editor.read({ kind: 'template', template: 'joey' });
        expect(after).toMatchObject({ revision: 1, value: { compatibilityDate: '2025-12-01' } });
        // A stale panel baseline must conflict instead of overwriting a newer save.
        await expect(f.editor.edit({ ...f.input({ kind: 'template', template: 'joey' }, { compatibilityDate: '2025-01-01' }, 0), key: 'edit-2' })).rejects.toThrow(/^CONFLICT$/);
    });
    it.each([
        { compatibilityDate: 'not-a-date' }, { compatibilityDate: '2020-12-31' }, { compatibilityDate: '2025-02-30' },
        { compatibilityDate: '2999-01-01' }, { compatibilityDate: 20250101 }, {}, { compatibilityDate: '2025-01-01', extra: true }, '2025-01-01', null
    ])('rejects an invalid compatibility setting %j', async value => {
        const f = await fixture();
        await expect(f.editor.edit(f.input({ kind: 'template', template: 'cmliu' }, value as any))).rejects.toThrow(/^INVALID$/);
    });
    it('rejects unknown or ambiguous template selectors', () => {
        for (const selector of [{ kind: 'template', template: '../etc' }, { kind: 'template' }, { kind: 'template', template: '__proto__' }]) expect(() => parseConfigSelector(selector)).toThrow(/^INVALID$/);
    });
});
