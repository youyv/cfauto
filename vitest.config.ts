import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { readTestSuites } = createRequire(import.meta.url)('./scripts/test-scope.cjs');
const suites = readTestSuites(fileURLToPath(new URL('.', import.meta.url)));
export default defineConfig({
    test: { include: suites.files, allowOnly: false, passWithNoTests: false, maxWorkers: 4 }
});
