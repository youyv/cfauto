// dns-fix.js — preload hook: fix Node.js DNS resolution for Wrangler
//
// Problem: Node.js picks up 127.0.0.1 as DNS server (from Clash/other DNS
// proxy), but nothing serves DNS on port 53 at that address currently.
// This causes ECONNREFUSED for all hostname resolution.
//
// Solution: Synchronously detect whether the configured DNS actually works;
// if not, auto-discover the real system DNS servers (filtering loopback/APIPA
// and prioritizing physical adapters), then set the first candidate that
// verifies with a real lookup. No hardcoded addresses — works on any machine
// with zero configuration.
//
// IMPORTANT: All diagnostics go to STDERR only (console.error). This file is
// loaded via NODE_OPTIONS into every Node process, including stdio-based MCP
// servers where STDOUT is the JSON-RPC protocol channel — any stray STDOUT
// output would corrupt the protocol.
//
// Note: Node 24 removed all dns.*Sync methods, so synchronous probing is done
// via `nslookup` output inspection (Windows nslookup exit code is always 0,
// so we check for the Addresses: result line instead).
const dns = require('dns');
const cp = require('child_process');

const PROBE_HOST = 'api.cloudflare.com';

/** 完全关闭本脚本：设 DNS_FIX_DISABLE=1（排障时用，避免它本身成为变量） */
const DISABLED = process.env.DNS_FIX_DISABLE === '1';

/** stderr 日志 — 绝不用 console.log/process.stdout，避免污染 stdio 协议通道 */
function log(msg) {
    try { process.stderr.write('[dns-fix] ' + msg + '\n'); } catch (_) { /* 无 stderr 时静默 */ }
}

/** 判定一个地址是否"绝对无效"：回环 / 0.0.0.0 / 广播。其余（192.168.x、10.x 等内网段）都可能是真实 DNS，一律保留 */
function isUnusableIp(ip) {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
    const p = ip.split('.').map(Number);
    if (p.some((n) => n > 255)) return true;
    if (p[0] === 127) return true;                       // 回环（Clash/代理残留）
    if (p[0] === 0) return true;                         // 0.0.0.0 / 保留
    if (p[0] === 169 && p[1] === 254) return true;       // APIPA 链路本地
    return p.every((n) => n === 255);                    // 广播
}

/** 当前配置是否"全无效"（全是回环/0.0.0.0），只有此时才需要干预，避免误改用户正常配置 */
function allUnusable(servers) {
    return servers.length > 0 && servers.every((s) => isUnusableIp(s));
}

/**
 * 同步探测：nslookup 指定服务器查询。
 * Windows nslookup 退出码恒为 0（失败也返回 0），所以用输出里是否出现
 * "Addresses:" 结果行判断（成功必有解析结果行，失败只有服务器信息行）。
 * 注意：不要加 -retry 参数（Windows 版本会误解析导致全部失败）。
 */
function probeServer(server) {
    try {
        const out = cp.execSync('nslookup -timeout=2 ' + PROBE_HOST + ' ' + server, {
            timeout: 8000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        return /Addresses?:/.test(out);
    } catch (_) {
        return false;
    }
}

/** Method 1: PowerShell — 收集全部 IPv4 DNS，物理网卡优先（虚拟网卡垫底），去重 */
function getSystemDnsViaPowershell() {
    try {
        const ps = [
            '$addrs = Get-DnsClientServerAddress -AddressFamily IPv4',
            '  | Where-Object { $_.ServerAddresses }',
            '  | Sort-Object @{Expression={ if ($_.InterfaceAlias -match \'virtual|vpn|tap|tun|vmware|virtualbox|hyper-v|hyperv|docker|wsl|loopback|bluetooth|ndis\') {1} else {0} }}, InterfaceAlias;',
            '$seen = @{}; $out = @();',
            'foreach ($a in $addrs) {',
            '  foreach ($ip in $a.ServerAddresses) {',
            '    if (-not $seen.ContainsKey([string]$ip)) { $seen[[string]$ip] = $true; $out += [string]$ip }',
            '  }',
            '}',
            '$out -join [char]10'
        ].join(' ');
        const cmd = 'powershell -NoProfile -Command "' + ps + '"';
        const out = cp.execSync(cmd, { timeout: 5000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const ips = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        return ips.filter((ip) => !isUnusableIp(ip));
    } catch (e) {
        log('PowerShell DNS detection failed: ' + ((e && e.message) || e));
        return [];
    }
}

/** Method 2: ipconfig 兜底 — 解析 DNS Servers 段落里的全部地址（含续行） */
function getSystemDnsViaIpconfig() {
    try {
        const out = cp.execSync('ipconfig /all', { timeout: 5000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const ips = [];
        let inDnsSection = false;
        for (const line of out.split(/\r?\n/)) {
            if (/DNS\s*Servers/i.test(line)) { inDnsSection = true; continue; }
            if (!inDnsSection) continue;
            // 续行：纯 IP 列表（可能有多个空格分隔）
            const m = line.match(/^\s*(\d{1,3}(?:\.\d{1,3}){3}(?:\s+\d{1,3}(?:\.\d{1,3}){3})*)\s*$/);
            if (m) {
                for (const ip of m[1].split(/\s+/)) if (!isUnusableIp(ip)) ips.push(ip);
            } else {
                inDnsSection = false; // 遇到非 IP 行，段落结束
            }
        }
        return ips;
    } catch (e) {
        log('ipconfig DNS detection failed: ' + ((e && e.message) || e));
        return [];
    }
}

// ==================== 主流程（模块加载时同步执行，消除竞态） ====================
const originalServers = dns.getServers();
if (DISABLED) {
    log('DNS_FIX_DISABLE=1 - leaving DNS configuration untouched');
} else if (allUnusable(originalServers)) {
    // 1) 同步探测当前配置：能用就保持（如本地确实跑了 DNS 服务）
    if (probeServer(originalServers[0])) {
        log(originalServers.join(', ') + ' OK, keeping current DNS');
    } else {
        // 2) 收集系统 DNS 候选：PowerShell 优先，ipconfig 兜底
        let candidates = getSystemDnsViaPowershell();
        if (candidates.length === 0) candidates = getSystemDnsViaIpconfig();
        if (candidates.length === 0) {
            log(originalServers.join(', ') + ' unreachable, but no system DNS found; keeping current config');
        } else {
            // 3) 逐个验证，取第一个可用的；全部失败则保持原配置
            let applied = null;
            for (const cand of candidates) {
                if (probeServer(cand)) { applied = cand; break; }
            }
            if (applied) {
                try {
                    dns.setServers([applied]);
                    log(originalServers.join(', ') + ' unreachable, fell back to verified DNS ' + applied);
                } catch (e) { log('setServers failed: ' + ((e && e.message) || e)); }
            } else {
                log('all candidates failed (' + candidates.join(', ') + '); keeping original config');
            }
        }
    }
} else {
    // 配置里有真实 DNS（可能混合了 127.0.0.1 主备），Node 自带故障转移，不干预
    // 只做了「地址形状」检查，并没有发起真实查询 —— 措辞必须如实，否则会把排障带偏
    // （本机 DNS 实际在抖，却每次都打印「看起来正常」）。
    log('configured DNS ' + originalServers.join(', ') + ' has non-loopback entries; leaving untouched without probing');
}

// ==================== dns.lookup 兜底 ====================
// 为什么需要这一层：
//   dns.setServers() 只改变 c-ares（dns.resolve*）使用的服务器，对 dns.lookup 无效 ——
//   而 dns.lookup 走的是操作系统的 getaddrinfo，也正是 fetch/undici/net 实际使用的那条路。
//   路由器 DNS 抖动时 getaddrinfo 会直接返回 ENOTFOUND / EAI_AGAIN，这就是 wrangler 报
//   "Unable to resolve Cloudflare's API hostname" 的直接原因，上面的 setServers 救不了它。
//
// 做法：只在原生 lookup **失败**时介入，用独立的 dns.Resolver 实例（各自持有自己的服务器，
// 不改动全局 c-ares 状态、无并发竞争）向公共 DNS 重查一次，成功就返回结果，失败则原样抛出。
// 原生解析正常时这条路径完全不会被触发，因此对正常网络没有影响。
const FALLBACK_TOTAL_BUDGET_MS = 1500;
const FALLBACK_PER_TRY_MS = 600;
// 可用 DNS_FIX_FALLBACK_DNS 覆盖（测试受限网络时用）
const FALLBACK_DNS = (process.env.DNS_FIX_FALLBACK_DNS || '1.1.1.1,8.8.8.8,223.5.5.5')
    .split(',').map((s) => s.trim()).filter(Boolean);
const FALLBACK_LOOKUP_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ETIMEOUT', 'ESERVFAIL', 'EREFUSED'];

let fallbackResolvers = null;
/** 懒创建独立 Resolver 实例（每个实例只持有自己那一台服务器） */
function getFallbackResolvers() {
    if (fallbackResolvers) return fallbackResolvers;
    const out = [];
    for (const srv of FALLBACK_DNS) {
        try {
            const r = new dns.Resolver();
            r.setServers([srv]);
            out.push({ srv, r });
        } catch (e) { /* 该运行时没有 Resolver 就跳过 */ }
    }
    fallbackResolvers = out;
    return out;
}

function isLookupFailure(err) {
    return !!(err && err.code && FALLBACK_LOOKUP_CODES.indexOf(err.code) !== -1);
}

/**
 * 依次尝试各公共 DNS，返回 [{address, family}] 或 null。
 *
 * **必须带硬上限**：c-ares 默认会对每台服务器重试到 5 秒以上，串行试三台就是十几秒，
 * 而 wrangler 的 API 超时只有 10 秒 —— 那样「DNS 解析失败」会从快速报错退化成整体超时，
 * 比不做兜底更糟（实测就是这样：deploy 从 Unable to resolve 变成 timed out）。
 * 因此每次尝试 600ms、总预算 1500ms，超时立即返回 null，让原生错误快速冒泡。
 */
function resolveViaFallback(hostname, family, cb) {
    const list = getFallbackResolvers();
    if (list.length === 0) return cb(null);
    const wantV4 = family !== 6;
    const wantV6 = family !== 4;
    let done = false;
    let deadline = null;
    function finish(results) {
        if (done) return;
        done = true;
        if (deadline) clearTimeout(deadline);
        cb(results);
    }
    deadline = setTimeout(function () { finish(null); }, FALLBACK_TOTAL_BUDGET_MS);

    let i = 0;
    function next() {
        if (done) return;
        if (i >= list.length) return finish(null);
        const entry = list[i++];
        let pending = 0;
        let found = null;
        function tryOne(fn, fam) {
            pending++;
            let settled = false;
            const timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                pending--;
                if (pending === 0 && !found) next();
            }, FALLBACK_PER_TRY_MS);
            fn.call(entry.r, hostname, function (e, a) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                pending--;
                if (!e && a && a.length && !found) {
                    found = a.map(function (x) { return { address: x, family: fam }; });
                    log('native lookup failed for ' + hostname + ', resolved via fallback DNS ' + entry.srv);
                    return finish(found);
                }
                if (pending === 0 && !found) next();
            });
        }
        if (wantV4) tryOne(entry.r.resolve4, 4);
        if (wantV6) tryOne(entry.r.resolve6, 6);
    }
    next();
}

const nativeLookup = dns.lookup;
function cfautoLookupFallback(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    else if (typeof opts === 'number') { opts = { family: opts }; }
    if (typeof cb !== 'function') return nativeLookup.apply(dns, arguments);
    const wantsAll = !!(opts && opts.all);
    const family = (opts && opts.family) || 0;
    // DNS_FIX_FORCE_FALLBACK=1 时才跳过原生结果，用于验证兜底路径本身可用
    const forced = process.env.DNS_FIX_FORCE_FALLBACK === '1';
    nativeLookup.call(dns, hostname, opts, function (err, address, fam) {
        if (!forced && (!err || !isLookupFailure(err))) return cb(err, address, fam);
        resolveViaFallback(hostname, family, function (results) {
            if (!results || results.length === 0) return cb(err, address, fam);
            if (wantsAll) return cb(null, results);
            return cb(null, results[0].address, results[0].family);
        });
    });
}
// 只有在未禁用时才接管 dns.lookup（DISABLED 时保留运行时原始实现）
if (!DISABLED) dns.lookup = cfautoLookupFallback;

