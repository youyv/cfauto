// dns-fix.js — preload hook: fix Node.js DNS resolution for Wrangler
//
// Problem: Node.js picks up 127.0.0.1 as DNS server (from Clash/other DNS
// proxy), but nothing serves DNS on port 53 at that address currently.
// This causes ECONNREFUSED for all hostname resolution.
//
// Solution: Auto-detect the real system DNS server and fall back to it
// when 127.0.0.1:53 is unreachable. No hardcoded gateway addresses.
const dns = require('dns');
const cp = require('child_process');

/** Detect the system's real upstream DNS server (not 127.0.0.1 proxy). */
function getSystemDns() {
    try {
        // Method 1: PowerShell — read DNS from active network adapter
        const cmd = [
            'powershell -Command "',
            '(Get-DnsClientServerAddress -AddressFamily IPv4',
            '| Where-Object { $_.ServerAddresses }',
            '| Select-Object -First 1).ServerAddresses[0]"'
        ].join(' ');
        const out = cp.execSync(cmd, { timeout: 3000, encoding: 'utf8', windowsHide: true });
        const ip = out.trim();
        if (ip && ip !== '127.0.0.1' && ip !== '0.0.0.0' && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
            return ip;
        }
    } catch (_) { console.error('[dns-fix] Failed to detect system DNS via PowerShell:', _?.message || _); }

    try {
        // Method 2: ipconfig fallback
        const out = cp.execSync('ipconfig /all', { timeout: 3000, encoding: 'utf8', windowsHide: true });
        const m = out.match(/DNS\s*Servers?[\s.:]+(\d+\.\d+\.\d+\.\d+)/i);
        if (m && m[1] !== '127.0.0.1' && m[1] !== '0.0.0.0') return m[1];
    } catch (_) { console.error('[dns-fix] Failed to detect system DNS via ipconfig:', _?.message || _); }

    return null;
}

const servers = dns.getServers();
if (servers.length === 1 && servers[0] === '127.0.0.1') {
    dns.resolve('api.cloudflare.com', 'A', (err) => {
        if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND')) {
            const fallback = getSystemDns();
            if (fallback) {
                dns.setServers([fallback]);
                console.log('[dns-fix] 127.0.0.1:53 unreachable, fell back to ' + fallback);
            } else {
                console.log('[dns-fix] 127.0.0.1:53 unreachable, no fallback DNS found');
            }
        } else if (!err) {
            console.log('[dns-fix] 127.0.0.1:53 OK, keeping local DNS');
        }
    });
}
