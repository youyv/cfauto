import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { verifyArchive, extractArchive, safeRelative } = require('../scripts/workspace-recovery.cjs');
const { privateDirectory } = require('../scripts/maintenance-client.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(change?: (manifest: any) => void) {
    const base = await mkdtemp(path.join(tmpdir(), 'cfauto-workspace-recovery-'));
    const directory = await privateDirectory(path.join(base, 'archive'));
    await mkdir(path.join(directory, 'objects'), { mode: 0o700 });
    const raw = Buffer.from(JSON.stringify({ originalPath: 'C:/path', credential: 'synthetic-only' })), sha256 = hash(raw), packed = gzipSync(raw);
    await writeFile(path.join(directory, 'objects/' + sha256 + '.gz'), packed, { mode: 0o600 });
    const manifest = { schema: 1, kind: 'workspace-recovery-content-store',
        entries: [{ tree: 'source', path: 'docs/original.txt', sha256, bytes: raw.length }, { tree: 'destination-before', path: 'unique.txt', sha256, bytes: raw.length }],
        objects: [{ sha256, bytes: raw.length, gzipBytes: packed.length }] };
    change?.(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path.join(directory, 'manifest.json'), bytes, { mode: 0o600 });
    return { base, directory, raw, sha256, manifestSha256: hash(bytes), out: path.join(base, 'extracted') };
}
describe('offline deduplicated workspace recovery', () => {
    it('audits one stored object for multiple original paths, without treating it as release approval', async () => {
        const f = await fixture(), report = await verifyArchive(f);
        expect(report).toMatchObject({ entries: 2, uniqueObjects: 1, verified: true, offlineOnly: true, publicationAllowed: false });
    });
    it('extracts exact original bytes into a new directory only, without rewriting history', async () => {
        const f = await fixture(), report = await extractArchive({ ...f, tree: 'source', prefix: 'docs' });
        const restored = path.join(f.out, 'docs/original.txt');
        expect(await readFile(restored)).toEqual(f.raw);
        // Existing maintenance readers require private file AND parent ACLs.
        const { readPrivateJson } = require('../scripts/maintenance-client.cjs');
        expect(await readPrivateJson(restored)).toEqual(JSON.parse(f.raw.toString()));
        expect(report).toMatchObject({ files: 1, originalBytesPreserved: true, historicalPathsRewritten: false });
        await expect(extractArchive(f)).rejects.toThrow();
        await expect(extractArchive({ ...f, out: path.join(f.directory, 'nested') })).rejects.toThrow('ARCHIVE_OUTPUT_INSIDE_STORE');
    });
    it('refuses manifest or object drift instead of manufacturing a new identity', async () => {
        const f = await fixture();
        await expect(verifyArchive({ ...f, manifestSha256: '0'.repeat(64) })).rejects.toThrow('ARCHIVE_MANIFEST_CHANGED');
        await writeFile(path.join(f.directory, 'objects/' + f.sha256 + '.gz'), gzipSync(Buffer.from('changed')));
        await expect(verifyArchive(f)).rejects.toThrow();
    });
    it('rejects escaping, ambiguous Windows paths and duplicate destinations', async () => {
        for (const relative of ['../escape', '/absolute', 'C:/secret', 'file:stream', 'a\\b', 'a//b', 'a/./b', 'NUL', 'trail.', 'trail ']) expect(() => safeRelative(relative)).toThrow('ARCHIVE_UNSAFE_PATH');
        const f = await fixture(manifest => manifest.entries.push({ ...manifest.entries[0], path: 'DOCS/ORIGINAL.TXT' }));
        await expect(verifyArchive(f)).rejects.toThrow('ARCHIVE_INVALID_ENTRY');
    });
    it('enforces the recorded decompressed size and entry-to-object relationship', async () => {
        const f = await fixture(manifest => { manifest.objects[0].bytes--; for (const entry of manifest.entries) entry.bytes--; });
        await expect(verifyArchive(f)).rejects.toThrow('ARCHIVE_OBJECT_CHANGED');
        const bad = await fixture(manifest => { manifest.entries[0].bytes++; });
        await expect(verifyArchive(bad)).rejects.toThrow('ARCHIVE_INVALID_ENTRY');
    });
    it('does not create output for missing selections or invalid archive paths', async () => {
        const f = await fixture();
        await expect(extractArchive({ ...f, prefix: 'missing' })).rejects.toThrow('ARCHIVE_PREFIX_NOT_FOUND');
        const bad = await fixture(manifest => { manifest.entries[0].path = '../outside.txt'; });
        await expect(extractArchive(bad)).rejects.toThrow('ARCHIVE_UNSAFE_PATH');
    });
});
