// Test-only loopback server. Never loads wrangler config, credentials, or real KV.
const http = require('node:http');
const fs = require('node:fs');

async function main() {
    const css = fs.readFileSync('test/e2e/rendering.css');
    const worker = (await import('../../dist/worker.js')).default;
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
