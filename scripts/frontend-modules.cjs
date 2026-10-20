const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

// A synchronous module island keeps legacy startup ordering and the existing CSP intact.
function bundleFrontendModules(root) {
    const result = esbuild.buildSync({
        absWorkingDir: root, entryPoints: ['frontend/modules/index.js'], bundle: true,
        write: false, format: 'iife', globalName: 'frontendModules', platform: 'browser',
        target: 'es2022', metafile: true, logLevel: 'silent'
    });
    const inputs = Object.keys(result.metafile.inputs).map(p => p.replace(/\\/g, '/'));
    function walk(dir) {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
            ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.relative(root, path.join(dir, e.name)).split(path.sep).join('/')] : []);
    }
    const orphan = walk(path.join(root, 'frontend/modules')).filter(p => !inputs.includes(p));
    if (orphan.length) throw new Error('Unreferenced frontend modules: ' + orphan.join(', '));
    if (inputs.some(p => !p.startsWith('frontend/modules/'))) throw new Error('Frontend modules must not import legacy scope or server files');
    return { code: result.outputFiles[0].text.replace('var frontendModules =', 'const frontendModules ='), inputs };
}
module.exports = { bundleFrontendModules };
