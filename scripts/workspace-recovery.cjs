/* Offline recovery of the workspace migration content store. No network,
 * code execution, in-place restore, source rewriting or deployment authority. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { privateDirectory, assertPrivate } = require('./maintenance-client.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function safeRelative(value) {
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\\:\x00-\x1f<>"|?*]/.test(value) || path.posix.isAbsolute(value)) fail('ARCHIVE_UNSAFE_PATH');
    for (const part of value.split('/')) {
        if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail('ARCHIVE_UNSAFE_PATH');
    }
    return value;
}
async function plainFile(root, relative, maxBytes) {
    safeRelative(relative);
    const file = path.join(root, relative), stat = await fs.lstat(file);
    const rel = path.relative(await fs.realpath(root), await fs.realpath(file));
    if (!stat.isFile() || stat.isSymbolicLink() || (rel === '..' || rel.startsWith('..' + path.sep)) || path.isAbsolute(rel) || stat.size > maxBytes) fail('ARCHIVE_UNSAFE_FILE');
    const bytes = await fs.readFile(file), after = await fs.lstat(file);
    if (bytes.length !== stat.size || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs) fail('ARCHIVE_FILE_CHANGED');
    return bytes;
}
async function loadArchive({ directory, manifestSha256 }) {
    const root = path.resolve(directory);
    await assertPrivate(root);
    if (!digest(manifestSha256)) fail('ARCHIVE_EXPECTED_MANIFEST_HASH_REQUIRED');
    const bytes = await plainFile(root, 'manifest.json', 32 * 1024 * 1024);
    if (sha(bytes) !== manifestSha256) fail('ARCHIVE_MANIFEST_CHANGED');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('ARCHIVE_INVALID_MANIFEST'); }
    if (manifest.schema !== 1 || manifest.kind !== 'workspace-recovery-content-store' || !Array.isArray(manifest.entries) || !Array.isArray(manifest.objects) || !manifest.entries.length || !manifest.objects.length || manifest.entries.length > 100000) fail('ARCHIVE_INVALID_MANIFEST');
    const objects = new Map();
    for (const object of manifest.objects) {
        if (!object || !digest(object.sha256) || objects.has(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes < 0 || object.bytes > 512 * 1024 * 1024 || !Number.isSafeInteger(object.gzipBytes) || object.gzipBytes < 1 || object.gzipBytes > 512 * 1024 * 1024) fail('ARCHIVE_INVALID_OBJECT');
        objects.set(object.sha256, object);
    }
    const seen = new Set();
    for (const entry of manifest.entries) {
        if (!entry || !['source', 'destination-before', 'git-state'].includes(entry.tree)) fail('ARCHIVE_INVALID_ENTRY');
        safeRelative(entry.path);
        const key = (entry.tree + '/' + entry.path).toLowerCase(), object = objects.get(entry.sha256);
        if (seen.has(key) || !object || entry.bytes !== object.bytes) fail('ARCHIVE_INVALID_ENTRY');
        seen.add(key);
    }
    const objectDir = path.join(root, 'objects'), stat = await fs.lstat(objectDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ARCHIVE_UNSAFE_FILE');
    return { root, manifest, objects, manifestSha256 };
}
async function objectBytes(archive, object) {
    const packed = await plainFile(archive.root, 'objects/' + object.sha256 + '.gz', object.gzipBytes);
    if (packed.length !== object.gzipBytes) fail('ARCHIVE_OBJECT_CHANGED');
    let bytes;
    try { bytes = gunzipSync(packed, { maxOutputLength: Math.max(1, object.bytes) }); } catch { fail('ARCHIVE_OBJECT_CHANGED'); }
    if (bytes.length !== object.bytes || sha(bytes) !== object.sha256) fail('ARCHIVE_OBJECT_CHANGED');
    return bytes;
}
async function verifyLoaded(archive) {
    for (const object of archive.objects.values()) await objectBytes(archive, object);
    return { schema: 1, manifestSha256: archive.manifestSha256, entries: archive.manifest.entries.length,
        uniqueObjects: archive.objects.size, logicalBytes: archive.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        verified: true, offlineOnly: true, publicationAllowed: false };
}
async function verifyArchive(options) { return verifyLoaded(await loadArchive(options)); }
async function extractArchive({ tree = 'source', prefix = '', out, ...options }) {
    const archive = await loadArchive(options);
    if (!['source', 'destination-before', 'git-state'].includes(tree)) fail('ARCHIVE_INVALID_TREE');
    if (prefix) safeRelative(prefix);
    if (typeof out !== 'string' || !out) fail('ARCHIVE_NEW_OUTPUT_REQUIRED');
    const requested = path.resolve(out);
    const destination = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
    const rel = path.relative(await fs.realpath(archive.root), destination);
    if (!rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) fail('ARCHIVE_OUTPUT_INSIDE_STORE');
    const entries = archive.manifest.entries.filter(entry => entry.tree === tree && (!prefix || entry.path === prefix || entry.path.startsWith(prefix + '/')));
    if (!entries.length) fail('ARCHIVE_PREFIX_NOT_FOUND');
    // Validate all original objects before writing anything. Existing output
    // directories are refused: never overwrite a checkout or recovery session.
    await verifyLoaded(archive);
    await privateDirectory(destination);
    const resolvedDestination = await fs.realpath(destination);
    const directoryKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const privateDirectories = new Set([directoryKey(resolvedDestination)]);
    for (const entry of entries) {
        const file = path.join(resolvedDestination, entry.path), relative = path.relative(resolvedDestination, file);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('ARCHIVE_UNSAFE_PATH');
        let nextParent = resolvedDestination;
        for (const part of entry.path.split('/').slice(0, -1)) {
            nextParent = path.join(nextParent, part);
            if (!privateDirectories.has(directoryKey(nextParent))) {
                await privateDirectory(nextParent);
                privateDirectories.add(directoryKey(nextParent));
            }
        }
        const parent = await fs.realpath(path.dirname(file));
        const expectedParent = path.resolve(path.dirname(file));
        const sameParent = process.platform === 'win32' ? parent.toLowerCase() === expectedParent.toLowerCase() : parent === expectedParent;
        if (!sameParent) fail('ARCHIVE_UNSAFE_PATH');
        const bytes = await objectBytes(archive, archive.objects.get(entry.sha256));
        await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
        // Restore new outputs with the ACL contract expected by maintenance readers.
        // Historical bytes stay unchanged; no permissions on the archive are relaxed.
        if (process.platform === 'win32') await require('./private-path.cjs').windowsPrivatePath(file, 'file');
        await assertPrivate(file);
        if (sha(await fs.readFile(file)) !== entry.sha256) fail('ARCHIVE_EXTRACT_VERIFY_FAILED');
    }
    return { schema: 1, out: destination, tree, prefix, files: entries.length, manifestSha256: archive.manifestSha256,
        originalBytesPreserved: true, historicalPathsRewritten: false, offlineOnly: true, publicationAllowed: false };
}
module.exports = { safeRelative, loadArchive, verifyArchive, extractArchive };
if (require.main === module) {
    (async () => {
        const [command, directory, manifestSha256, tree, rawPrefix, out, ...extra] = process.argv.slice(2);
        if (!directory || extra.length) fail('USAGE_VERIFY_DIRECTORY_HASH_OR_EXTRACT_DIRECTORY_HASH_TREE_PREFIX_NEW_OUTPUT');
        let report;
        if (command === 'verify' && tree === undefined) report = await verifyArchive({ directory, manifestSha256 });
        else if (command === 'extract' && tree && rawPrefix !== undefined && out) report = await extractArchive({ directory, manifestSha256, tree, prefix: rawPrefix === '.' ? '' : rawPrefix, out });
        else fail('USAGE_VERIFY_DIRECTORY_HASH_OR_EXTRACT_DIRECTORY_HASH_TREE_PREFIX_NEW_OUTPUT');
        console.log(JSON.stringify(report, null, 2));
    })().catch(error => { console.error(/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'WORKSPACE_RECOVERY_FAILED'); process.exitCode = 1; });
}
