import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { backupKeys } from '../src/lib/backup-policy';
const { prepare, allowed, main } = createRequire(import.meta.url)('../scripts/prepare-recovery.cjs');
const snapshot = { _format: 'worker-pro-recovery@1', _schemaVersion: 1,
    put: [{ key: 'VARS_cmliu', value: 'invalid old raw' }], delete: ['VARS_joey'] };
describe('offline recovery preparation', () => {
    it('covers all current fixed backup keys', () => { for (const key of backupKeys()) expect(allowed(key)).toBe(true); });
    it('preserves exact old bytes and only explicitly selected keys', () => {
        expect(prepare(snapshot, ['VARS_cmliu'])).toEqual({ put: snapshot.put, delete: [] });
        expect(prepare(snapshot, ['VARS_joey'])).toEqual({ put: [], delete: ['VARS_joey'] });
    });
    it('rejects ordinary backups, unknown keys and duplicated put/delete keys', () => {
        expect(() => prepare({ VARS_cmliu: [] }, ['VARS_cmliu'])).toThrow();
        expect(() => prepare(snapshot, [])).toThrow();
        expect(() => prepare(snapshot, ['SESSION_forged'])).toThrow();
        expect(() => prepare({ ...snapshot, delete: ['VARS_cmliu'] }, ['VARS_cmliu'])).toThrow();
        expect(() => prepare({ ...snapshot, delete: ['SESSION_forged'] }, ['SESSION_forged'])).toThrow();
    });
    it('writes only local bulk files and refuses to overwrite existing output', () => {
        const dir = mkdtempSync(join(tmpdir(), 'worker-recovery-test-'));
        const source = join(dir, 'snapshot.json');
        const files = [source, join(dir, 'kv-put.json'), join(dir, 'kv-delete.json')];
        try {
            writeFileSync(source, JSON.stringify(snapshot));
            main([source, dir, '--keys', 'VARS_cmliu,VARS_joey']);
            expect(JSON.parse(readFileSync(files[1], 'utf8'))).toEqual(snapshot.put);
            expect(JSON.parse(readFileSync(files[2], 'utf8'))).toEqual(snapshot.delete);
            expect(() => main([source, dir, '--keys', 'VARS_cmliu'])).toThrow('overwrite');
        } finally { for (const file of files) if (existsSync(file)) unlinkSync(file); rmdirSync(dir); }
    });
});
