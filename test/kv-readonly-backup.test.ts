import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { inspectLegacyBackup } = require('../scripts/inspect-legacy-backup.cjs');
const { backupKv } = require('../scripts/backup-kv-readonly.cjs');
const account = 'a'.repeat(32), namespace = 'b'.repeat(32), version = '11111111-1111-1111-1111-111111111111';
const envelope = (result: any, extra = {}) => Response.json({ success: true, result, ...extra });
async function fixture(overrides: (url: URL, ordinal: number) => Response | Promise<Response> | undefined = () => undefined) {
    const parent = await mkdtemp(path.join(tmpdir(), 'cfauto-kv-backup-unit-')), out = path.join(parent, 'backup');
    const calls: { url: string; init: any }[] = [];
    const transport = async (target: string, init: any) => {
        calls.push({ url: target, init }); const url = new URL(target);
        expect(url.origin).toBe('https://api.cloudflare.com'); expect(init.method).toBe('GET'); expect(init.redirect).toBe('error');
        const override = overrides(url, calls.length); if (override !== undefined) return override;
        if (url.pathname.endsWith('/deployments')) return envelope({ deployments: [{ id: 'deployment', versions: [{ version_id: version, percentage: 100 }] }] });
        if (url.pathname.includes('/versions/')) return envelope({ id: version, resources: { bindings: [{ name: 'CONFIG_KV', type: 'kv_namespace', namespace_id: namespace }] } });
        if (url.pathname.endsWith('/keys')) return envelope([{ name: 'ACCOUNTS', metadata: { encoding: 'legacy' } }, { name: 'global/config' }], { result_info: { count: 2, cursor: '' } });
        if (url.pathname.endsWith('/values/ACCOUNTS')) return new Response('private-test-only-token');
        if (url.pathname.endsWith('/values/global%2Fconfig')) return new Response(new Uint8Array([0, 255, 128, 10]));
        throw new Error('unexpected');
    };
    const backup = (extra = {}) => backupKv({ account, worker: 'manager', namespace, out, headers: { Authorization: 'Bearer test-only-not-real' }, transport, ...extra });
    return { parent, out, calls, backup };
}
describe('read-only complete KV backup, never a cutover/drain proof', () => {
    it('verifies bytes and bindings, keeps indexed filenames and marks live evidence non-migratable', async () => {
        const f = await fixture(), result = await f.backup();
        expect(result).toMatchObject({ directory: f.out, count: 2, migrationReady: false, version });
        const manifest = JSON.parse(await readFile(path.join(f.out, 'manifest.json'), 'utf8'));
        expect(manifest).toMatchObject({ readOnly: true, inventoryMatched: true, verifiedLocalBytes: true, consistency: 'live-best-effort-not-cutover', migrationReady: false });
        expect(manifest.entries[0]).toMatchObject({ name: 'ACCOUNTS', file: 'value-000000.bin', bytes: 23 });
        expect(await readFile(path.join(f.out, manifest.entries[1].file))).toEqual(Buffer.from([0, 255, 128, 10]));
        expect(JSON.stringify(result)).not.toMatch(/private-test|ACCOUNTS|Authorization/);
        expect(f.calls.every(c => c.init.method === 'GET')).toBe(true);
        expect((await readFile(path.join(f.out, 'manifest.sha256'), 'utf8')).trim()).toBe(result.manifestSha256);
    });
    it('follows every opaque cursor and compares a second complete enumeration', async () => {
        const f = await fixture(url => {
            if (!url.pathname.endsWith('/keys')) return undefined;
            const next = url.searchParams.get('cursor') === 'opaque+/=cursor';
            return envelope([{ name: next ? 'global/config' : 'ACCOUNTS' }], { result_info: { count: 1, cursor: next ? '' : 'opaque+/=cursor' } });
        });
        expect((await f.backup()).count).toBe(2);
        expect(f.calls.filter(c => new URL(c.url).searchParams.get('cursor') === 'opaque+/=cursor')).toHaveLength(2);
    });
    it('supports an empty namespace and empty/binary values', async () => {
        const f = await fixture(url => url.pathname.endsWith('/keys') ? envelope([], { result_info: { count: 0, cursor: '' } }) : undefined);
        expect((await f.backup()).count).toBe(0);
        const g = await fixture(url => url.pathname.includes('/values/') ? new Response(null) : undefined);
        expect((await g.backup()).totalBytes).toBe(0);
    });
    it('never overwrites an earlier directory or removes existing evidence', async () => {
        const f = await fixture(); await f.backup(); const old = await readFile(path.join(f.out, 'manifest.json'));
        await expect(f.backup()).rejects.toThrow(); expect(await readFile(path.join(f.out, 'manifest.json'))).toEqual(old);
        expect(f.calls).toHaveLength(8);
    });
    it('refuses a stale/wrong CONFIG_KV binding before enumerating values', async () => {
        const f = await fixture(url => url.pathname.includes('/versions/') ? envelope({ id: version, resources: { bindings: [{ name: 'CONFIG_KV', type: 'kv_namespace', namespace_id: 'c'.repeat(32) }] } }) : undefined);
        await expect(f.backup()).rejects.toThrow(/^CONFIG_BINDING_MISMATCH$/); expect(f.calls).toHaveLength(2);
        expect(await readdir(f.out)).toContain('failure.json'); expect(await readdir(f.out)).not.toContain('manifest.json');
    });
    it.each([
        envelope([], {}), envelope([{ name: 'x' }], { result_info: { count: 2, cursor: '' } }),
        envelope([], { result_info: { count: 0, cursor: 'more' } }),
        envelope([{ name: 'same' }, { name: 'same' }], { result_info: { count: 2, cursor: '' } }),
        envelope([{ name: '..' }], { result_info: { count: 1, cursor: '' } }),
        envelope([{ name: 'x', expiration: -1 }], { result_info: { count: 1, cursor: '' } }),
        envelope([{ name: 'x', unexpected: true }], { result_info: { count: 1, cursor: '' } }),
        envelope([{ name: 'x'.repeat(513) }], { result_info: { count: 1, cursor: '' } })
    ])('rejects incomplete/unsafe key pages %# without any value GET', async bad => {
        const f = await fixture(url => url.pathname.endsWith('/keys') ? bad : undefined);
        await expect(f.backup()).rejects.toThrow(); expect(f.calls.every(c => !c.url.includes('/values/'))).toBe(true);
        expect(await readdir(f.out)).not.toContain('manifest.json');
    });
    it('rejects cursor loops rather than declaring a partial backup complete', async () => {
        let page = 0;
        const f = await fixture(url => url.pathname.endsWith('/keys') ? envelope([{ name: 'key-' + page++ }], { result_info: { count: 1, cursor: 'repeat' } }) : undefined);
        await expect(f.backup()).rejects.toThrow(/^CURSOR_NOT_PROGRESSING$/); expect(f.calls.filter(c => c.url.includes('/keys?'))).toHaveLength(2);
    });
    it('detects live keyset/metadata changes and retains partial raw value evidence', async () => {
        let page = 0;
        const f = await fixture(url => url.pathname.endsWith('/keys') ? envelope([{ name: 'ACCOUNTS', metadata: { revision: ++page } }], { result_info: { count: 1, cursor: '' } }) : undefined);
        await expect(f.backup()).rejects.toThrow(/^KEY_INVENTORY_CHANGED$/);
        expect(await readdir(f.out)).toContain('value-000000.bin'); expect(await readdir(f.out)).not.toContain('manifest.json');
    });
    it('detects an active deployment change during reads', async () => {
        let deployment = 0;
        const f = await fixture(url => url.pathname.endsWith('/deployments') ? envelope({ deployments: [{ id: 'deployment-' + ++deployment, versions: [{ version_id: version, percentage: 100 }] }] }) : undefined);
        await expect(f.backup()).rejects.toThrow(/^REMOTE_VERSION_CHANGED$/);
        expect(await readdir(f.out)).toContain('failure.json');
    });
    it.each([401, 404, 429, 500, 302])('fails closed for HTTP %s and does not print remote body details', async status => {
        const f = await fixture(url => url.pathname.includes('/values/') ? new Response('private provider details', { status }) : undefined);
        await expect(f.backup()).rejects.toThrow('READ_FAILED_HTTP_' + status);
        expect(await readFile(path.join(f.out, 'failure.json'), 'utf8')).not.toContain('private'); expect(f.calls).toHaveLength(4);
    });
    it('refuses oversized value streams while keeping earlier evidence', async () => {
        const f = await fixture(url => url.pathname.includes('/values/') ? new Response(new Uint8Array(25 * 1024 * 1024 + 1)) : undefined);
        await expect(f.backup()).rejects.toThrow(/^READ_TOO_LARGE$/); expect(await readdir(f.out)).not.toContain('manifest.json');
    });
    it.each(['transport', 'body'])('bounds an uncooperative %s by a single request deadline', async mode => {
        const f = await fixture(url => {
            if (!url.pathname.includes('/values/')) return undefined;
            return mode === 'transport' ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }));
        });
        await expect(f.backup({ timeoutMs: 50 })).rejects.toThrow(/^READ_TIMEOUT$/);
        expect(await readdir(f.out)).toContain('failure.json');
    });
    it('retains local write failures without exposing a secret path', async () => {
        const f = await fixture(); await writeFile(path.join(f.parent, 'exists'), 'kept');
        await expect(f.backup({ out: path.join(f.parent, 'exists') })).rejects.toThrow(); expect(f.calls).toHaveLength(0);
    });
});

it('feeds the exact existing backup writer output into the offline legacy source reader without returning credential values',async()=>{const f=await fixture(url=>{if(url.pathname.endsWith('/keys'))return envelope([{name:'ACCOUNTS_UNIFIED_STORAGE'},{name:'AUTO_UPDATE_CFG_GLOBAL'}],{result_info:{count:2,cursor:''}});if(url.pathname.endsWith('/values/ACCOUNTS_UNIFIED_STORAGE'))return new Response(JSON.stringify([{accountId:account,alias:'local',apiToken:'private-test-only-token',email:'',workers_cmliu:['one']}]));if(url.pathname.endsWith('/values/AUTO_UPDATE_CFG_GLOBAL'))return new Response(JSON.stringify({enabled:false,lastCheck:1}));});const backup=await f.backup();const options={directory:f.out,manifestSha256:backup.manifestSha256,account,worker:'manager',namespace,version};const inspected=await inspectLegacyBackup(options);expect(inspected).toMatchObject({mode:'offline_integrity_only',files:2,businessDomains:15,accounts:1,credentialsValidated:false,migrationReady:false,activationReady:false,blockers:{legacyDrainUnproven:1}});expect(JSON.stringify(inspected)).not.toMatch(/private-test|apiToken|lastCheck/);const contents=await readdir(f.out);await expect(inspectLegacyBackup({...options,worker:'wrong'})).rejects.toThrow('INVALID');await writeFile(path.join(f.out,'value-000000.bin'),'changed');await expect(inspectLegacyBackup(options)).rejects.toThrow();expect(await readdir(f.out)).toEqual(contents);});
