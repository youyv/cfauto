#!/usr/bin/env node
'use strict';
// Offline only: never loads Wrangler credentials, calls a network API, or mutates KV.
const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 10 * 1024 * 1024;
function allowed(key) {
    return typeof key === 'string' && (/^(ACCOUNTS_UNIFIED_STORAGE|AUTO_UPDATE_CFG_GLOBAL|DEPLOY_JOURNAL)$/.test(key) ||
        /^(VARS|DEPLOY_CONFIG|FAVORITES|UPSTREAM)_(cmliu|joey|ech)$/.test(key) || /^VARS_(cmliu|joey|ech)_ACC_[A-Za-z0-9]{1,64}$/.test(key));
}
function prepare(snapshot, selected) {
    if (!snapshot || snapshot._format !== 'worker-pro-recovery@1' || snapshot._schemaVersion !== 1 ||
        !Array.isArray(snapshot.put) || !Array.isArray(snapshot.delete)) throw Error('Invalid recovery snapshot format');
    const entries = new Map();
    for (const item of snapshot.put) {
        if (!item || !allowed(item.key) || typeof item.value !== 'string' || entries.has(item.key)) throw Error('Invalid or duplicate snapshot entry');
        entries.set(item.key, item.value);
    }
    for (const key of snapshot.delete) {
        if (!allowed(key) || entries.has(key)) throw Error('Invalid or duplicate deletion entry');
        entries.set(key, null);
    }
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(k => !entries.has(k))) {
        throw Error('Explicit unique --keys must all belong to the snapshot; do not include untouched keys');
    }
    return { put: selected.filter(k => entries.get(k) !== null).map(key => ({ key, value: entries.get(key) })),
        delete: selected.filter(k => entries.get(k) === null) };
}
function main(args) {
    const [source, destination, flag, keys, ...extra] = args;
    if (!source || !destination || flag !== '--keys' || !keys || extra.length) throw Error('Usage: node scripts/prepare-recovery.cjs SNAPSHOT OUTPUT_DIR --keys KEY1,KEY2');
    if (fs.statSync(source).size > MAX_BYTES) throw Error('Snapshot exceeds 10 MiB');
    const result = prepare(JSON.parse(fs.readFileSync(source, 'utf8')), keys.split(','));
    const dir = path.resolve(destination);
    const targets = [path.join(dir, 'kv-put.json'), path.join(dir, 'kv-delete.json')];
    if (targets.some(p => fs.existsSync(p))) throw Error('Output files already exist; refusing to overwrite');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targets[0], JSON.stringify(result.put, null, 2), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(targets[1], JSON.stringify(result.delete, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('Prepared offline recovery files: ' + result.put.length + ' put, ' + result.delete.length + ' delete. No KV operations performed. Protect these sensitive files.');
}
if (require.main === module) {
    try { main(process.argv.slice(2)); }
    catch { console.error('Recovery preparation failed. Check format, explicit keys, size and output paths. No KV operations performed.'); process.exitCode = 1; }
}
module.exports = { prepare, allowed, main };
