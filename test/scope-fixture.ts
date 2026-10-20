// Small, explicit fake inventory for gate-verifier tests, never real gate evidence.
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
export async function writeSyntheticScope(root: string) {
    await mkdir(path.join(root, 'test'), { recursive: true });
    const groups = Object.fromEntries(['core', 'frontend', 'operations', 'reliability'].map((name, i) => [name, [`test/case-${i}.test.ts`]]));
    for (const files of Object.values(groups)) await writeFile(path.join(root, files[0]), '// synthetic discovery fixture');
    await writeFile(path.join(root, 'test/suites.json'), JSON.stringify({ schema: 1, groups }));
    for (const file of ['verify.js', 'vitest.config.ts', 'playwright.config.cjs', 'playwright.cross-browser.config.cjs']) {
        try { await access(path.join(root, file)); } catch { await writeFile(path.join(root, file), '// synthetic tool fixture'); }
    }
}
