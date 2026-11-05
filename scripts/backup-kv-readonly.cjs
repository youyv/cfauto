/* Live read-only KV evidence, NOT a cutover snapshot or proof that writers drained. */
const fs = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { active, stringField } = require('./backup-worker-readonly.cjs');
const fail = code => { throw new Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
async function backupKv({ account, worker, namespace, out, headers, transport = fetch, timeoutMs = 30000 }) {
    if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-f0-9]{32}$/.test(namespace) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('INVALID_TARGET');
    out = path.resolve(out);
    await fs.mkdir(out, { mode: 0o700 }); // Exclusive: never replace an existing backup.
    if (process.platform === 'win32') {
        const identity = cp.execFileSync('whoami.exe', [], { windowsHide: true, encoding: 'utf8' }).trim();
        cp.execFileSync('icacls.exe', [out, '/inheritance:r', '/grant:r', identity + ':(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
    }
    const save = (name, bytes) => fs.writeFile(path.join(out, name), bytes, { flag: 'wx', mode: 0o600 });
    const base = 'https://api.cloudflare.com/client/v4/accounts/' + account;
    async function get(suffix, limit) {
        const controller = new AbortController(); let timer, reader;
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('READ_TIMEOUT')); }, timeoutMs); });
        try {
            const pending = Promise.resolve().then(() => transport(base + suffix, { method: 'GET', headers: { ...headers }, redirect: 'error', signal: controller.signal }));
            void pending.then(r => { if (controller.signal.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
            const response = await Promise.race([pending, deadline]);
            if (response.status !== 200 || response.redirected) { void response.body?.cancel().catch(() => {}); fail('READ_FAILED_HTTP_' + response.status); }
            reader = response.body?.getReader(); const chunks = []; let size = 0;
            if (reader) for (;;) {
                const chunk = await Promise.race([reader.read(), deadline]); if (chunk.done) break;
                size += chunk.value.length; if (size > limit) fail('READ_TOO_LARGE'); chunks.push(Buffer.from(chunk.value));
            }
            return Buffer.concat(chunks);
        } finally { clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); }
    }
    async function json(suffix, file) {
        const bytes = await get(suffix, 2 * 1024 * 1024); await save(file, bytes);
        let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_API_JSON'); }
        if (value?.success !== true) fail('API_READ_REJECTED'); return value;
    }
    async function bindingSnapshot(label) {
        const selected = active((await json('/workers/scripts/' + worker + '/deployments', label + '-deployments.json')).result);
        const version = (await json('/workers/scripts/' + worker + '/versions/' + selected.version, label + '-version.json')).result;
        if (version?.id !== selected.version || !Array.isArray(version.resources?.bindings)) fail('INVALID_VERSION_BINDINGS');
        const bindings = version.resources.bindings.filter(b => b?.name === 'CONFIG_KV');
        if (bindings.length !== 1 || bindings[0].type !== 'kv_namespace' || bindings[0].namespace_id !== namespace) fail('CONFIG_BINDING_MISMATCH');
        return selected;
    }
    async function inventory(label) {
        const keys = [], seen = new Set(), cursors = new Set(); let cursor = '';
        for (let page = 0; page < 1000; page++) {
            const data = await json('/storage/kv/namespaces/' + namespace + '/keys?limit=1000' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), label + '-keys-' + String(page).padStart(4, '0') + '.json');
            if (!Array.isArray(data.result) || data.result.length > 1000 || !data.result_info || data.result_info.count !== data.result.length || typeof data.result_info.cursor !== 'string') fail('INCOMPLETE_KEY_PAGE');
            for (const key of data.result) {
                if (!key || typeof key.name !== 'string' || !key.name || ['.', '..'].includes(key.name) || Buffer.byteLength(key.name) > 512 || seen.has(key.name) || Object.keys(key).some(k => !['name', 'expiration', 'metadata'].includes(k))) fail('INVALID_KEY_PAGE');
                if (key.expiration !== undefined && (!Number.isSafeInteger(key.expiration) || key.expiration < 0)) fail('INVALID_KEY_PAGE');
                seen.add(key.name); keys.push(key);
            }
            if (keys.length > 100000) fail('TOO_MANY_KEYS');
            cursor = data.result_info.cursor;
            if (!cursor) return keys.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
            if (cursors.has(cursor) || cursor.length > 4096 || !data.result.length) fail('CURSOR_NOT_PROGRESSING'); cursors.add(cursor);
        }
        fail('TOO_MANY_PAGES');
    }
    const startedAt = new Date().toISOString(); let completed = 0;
    await save('intent.json', JSON.stringify({ schema: 1, account, worker, namespace, startedAt, readOnly: true, consistency: 'live-best-effort-not-cutover', migrationReady: false }, null, 2));
    try {
        const before = await bindingSnapshot('before'), keys = await inventory('before'), entries = []; let totalBytes = 0;
        for (const key of keys) {
            // Index-based filenames, never remotely supplied key names or paths.
            const value = await get('/storage/kv/namespaces/' + namespace + '/values/' + encodeURIComponent(key.name), 25 * 1024 * 1024);
            totalBytes += value.length; if (totalBytes > 512 * 1024 * 1024) fail('BACKUP_TOO_LARGE');
            const file = 'value-' + String(entries.length).padStart(6, '0') + '.bin'; await save(file, value);
            if (hash(await fs.readFile(path.join(out, file))) !== hash(value)) fail('BACKUP_HASH_MISMATCH');
            entries.push({ ...key, file, bytes: value.length, sha256: hash(value) }); completed++;
        }
        const afterKeys = await inventory('after'), after = await bindingSnapshot('after');
        if (canonical(before) !== canonical(after)) fail('REMOTE_VERSION_CHANGED');
        if (canonical(keys) !== canonical(afterKeys)) fail('KEY_INVENTORY_CHANGED');
        const manifest = { schema: 1, readOnly: true, account, worker, namespace, startedAt, capturedAt: new Date().toISOString(), ...before, consistency: 'live-best-effort-not-cutover', migrationReady: false, inventoryMatched: true, verifiedLocalBytes: true, totalBytes, entries };
        await save('manifest.json', JSON.stringify(manifest, null, 2));
        const manifestBytes = await fs.readFile(path.join(out, 'manifest.json'));
        if (canonical(JSON.parse(manifestBytes)) !== canonical(manifest)) fail('MANIFEST_READBACK_MISMATCH');
        await save('manifest.sha256', hash(manifestBytes) + '\n');
        return { directory: out, count: entries.length, totalBytes, version: before.version, migrationReady: false, manifestSha256: hash(manifestBytes) };
    } catch (error) {
        const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_OR_NETWORK_ERROR';
        await save('failure.json', JSON.stringify({ code, completed, capturedAt: new Date().toISOString(), migrationReady: false }));
        fail(code); // Never print provider responses, key names, credentials or value bytes.
    }
}
module.exports = { backupKv };
if (require.main === module) (async () => {
    const args = process.argv.slice(2), opts = {};
    if (args.length !== 8) fail('USAGE_CONFIG_NAMESPACE_AUTH_FILE_OUT');
    for (let i = 0; i < args.length; i += 2) { if (!['--config', '--namespace', '--auth-file', '--out'].includes(args[i]) || opts[args[i]]) fail('INVALID_OPTIONS'); opts[args[i]] = args[i + 1]; }
    const config = await fs.readFile(opts['--config'], 'utf8'), auth = await fs.readFile(opts['--auth-file'], 'utf8');
    const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || stringField(auth, 'oauth_token');
    if (!token) fail('EXISTING_AUTH_UNAVAILABLE');
    console.log(JSON.stringify(await backupKv({ account: stringField(config, 'account_id'), worker: stringField(config, 'name'), namespace: opts['--namespace'], out: opts['--out'], headers: { Authorization: 'Bearer ' + token } }), null, 2));
})().catch(error => { console.error('Read-only KV backup failed: ' + (/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'LOCAL_OR_NETWORK_ERROR')); process.exitCode = 1; });
