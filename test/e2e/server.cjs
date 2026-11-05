// Test-only loopback server. Never loads wrangler config, credentials, or real KV.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { build } = require('esbuild');

async function main() {
    const css = fs.readFileSync('test/e2e/rendering.css');
    // Node does not implement cloudflare:workers. Adapt only the test copy in
    // memory; production assets and dist/worker.js remain unchanged. Any attempt
    // to instantiate a real coordinator in this static-only server must fail.
    const bundle = await build({
        entryPoints: [path.resolve('dist/worker.js')], bundle: true,
        platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
        plugins: [{ name: 'static-only-cloudflare', setup(builder) {
            builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare:workers', namespace: 'e2e-runtime' }));
            builder.onLoad({ filter: /.*/, namespace: 'e2e-runtime' }, () => ({
                contents: 'export class DurableObject { constructor() { throw new Error("Durable Objects are forbidden in the E2E static server"); } }', loader: 'js'
            }));
        } }]
    });
    const compiled = new Module(path.resolve('test/e2e/.worker-test.cjs'), module);
    compiled.filename = path.resolve('test/e2e/.worker-test.cjs');
    compiled.paths = module.paths;
    compiled._compile(bundle.outputFiles[0].text, compiled.filename);
    const worker = compiled.exports.default;
    // Static asset requests are the only Worker calls allowed; auth uses a dummy session.
    const env = { ACCESS_CODE: 'e2e-not-a-secret', CONFIG_KV: { get: async key => {
        if (key === 'SESSION_e2e') return 'e2e-csrf';
        throw new Error('Unexpected KV access in static server');
    } } };
    globalThis.fetch = async () => { throw new Error('External network is forbidden in E2E server'); };
    const allowed = new Set(['/', '/app.js', '/app.css', '/vendor/sweetalert2.js', '/manifest.json']);
    http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1:17891');
            if (url.pathname === '/test/rendering.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(css); return; }
            if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
            // API must be intercepted by Playwright; fail closed if a mock is missing.
            if (req.method !== 'GET' || !allowed.has(url.pathname)) { res.writeHead(501); res.end('Not a test static route'); return; }
            const response = await worker.fetch(new Request(url, { headers: { Cookie: '__Host-auth=e2e' } }), env, {});
            let body = await response.text();
            // Production /app.css is unchanged; only disable animation and fix test fonts.
            if (url.pathname === '/') body = body.replace('</head>', '<link rel="stylesheet" href="/test/rendering.css"></head>');
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(body);
        } catch (error) { console.error(error); res.writeHead(500); res.end('Test server error'); }
    }).listen(17891, '127.0.0.1');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
