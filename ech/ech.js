import { connect } from 'cloudflare:sockets';
// v1.6.0

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CF_FALLBACK_IPS = ['cdn.xn--b6gac.eu.org']; // fallback

// 复用 TextEncoder，避免重复创建
const encoder = new TextEncoder();
const DATA_FEED_URL = 'https://zip.cm.edu.kg/all.txt';

// 地区名称映射
const REGION_MAP = {
    'JP': '日本', 'KR': '韩国', 'SG': '新加坡', 'HK': '香港', 'TW': '台湾', 'MY': '马来西亚', 'TH': '泰国', 'VN': '越南', 'PH': '菲律宾', 'ID': '印尼', 'IN': '印度', 'AU': '澳大利亚', 'NZ': '新西兰', 'KH': '柬埔寨', 'MO': '澳门', 'BD': '孟加拉', 'PK': '巴基斯坦', 'NP': '尼泊尔', 'MN': '蒙古', 'LK': '斯里兰卡', 'LA': '老挝', 'BN': '文莱', 'MM': '缅甸', 'BT': '不丹', 'MV': '马尔代夫',
    'US': '美国', 'CA': '加拿大', 'MX': '墨西哥', 'PR': '波多黎各', 'GU': '关岛',
    'GB': '英国', 'UK': '英国', 'DE': '德国', 'FR': '法国', 'NL': '荷兰', 'IT': '意大利', 'ES': '西班牙', 'PT': '葡萄牙', 'RU': '俄罗斯', 'UA': '乌克兰', 'PL': '波兰', 'SE': '瑞典', 'FI': '芬兰', 'NO': '挪威', 'DK': '丹麦', 'IS': '冰岛', 'IE': '爱尔兰', 'BE': '比利时', 'LU': '卢森堡', 'CH': '瑞士', 'AT': '奥地利', 'CZ': '捷克', 'HU': '匈牙利', 'RO': '罗马尼亚', 'BG': '保加利亚', 'GR': '希腊', 'TR': '土耳其', 'HR': '克罗地亚', 'RS': '塞尔维亚', 'SI': '斯洛文尼亚', 'SK': '斯洛伐克', 'EE': '爱沙尼亚', 'LV': '拉脱维亚', 'LT': '立陶宛', 'MD': '摩尔多瓦', 'AL': '阿尔巴尼亚', 'BA': '波黑', 'ME': '黑山', 'MK': '北马其顿', 'CY': '塞浦路斯', 'MT': '马耳他', 'BY': '白俄罗斯', 'GE': '格鲁吉亚', 'AM': '亚美尼亚', 'AZ': '阿塞拜疆',
    'BR': '巴西', 'AR': '阿根廷', 'CL': '智利', 'CO': '哥伦比亚', 'PE': '秘鲁', 'EC': '厄瓜多尔', 'UY': '乌拉圭', 'PY': '巴拉圭', 'VE': '委内瑞拉', 'BO': '玻利维亚', 'GY': '圭亚那', 'SR': '苏里南',
    'PA': '巴拿马', 'CR': '哥斯达黎加', 'GT': '危地马拉', 'HN': '洪都拉斯', 'SV': '萨尔瓦多', 'NI': '尼加拉瓜', 'JM': '牙买加', 'DO': '多米尼加', 'BS': '巴哈马', 'TT': '特立尼达多巴哥', 'BB': '巴巴多斯', 'CW': '库拉索',
    'ZA': '南非', 'EG': '埃及', 'MA': '摩洛哥', 'DZ': '阿尔及利亚', 'TN': '突尼斯', 'NG': '尼日利亚', 'KE': '肯尼亚', 'GH': '加纳', 'TZ': '坦桑尼亚', 'UG': '乌干达', 'MU': '毛里求斯', 'RE': '留尼汪', 'AO': '安哥拉', 'MZ': '莫桑比克', 'SN': '塞内加尔', 'AE': '阿联酋', 'SA': '沙特', 'IL': '以色列', 'QA': '卡塔尔', 'BH': '巴林', 'KW': '科威特', 'OM': '阿曼', 'JO': '约旦', 'LB': '黎巴嫩', 'IQ': '伊拉克', 'KZ': '哈萨克斯坦', 'UZ': '乌兹别克斯坦', 'KG': '吉尔吉斯斯坦'
};

function getFlagEmoji(code) {
    if (code === 'TW') return '\ud83c\uddf9\ud83c\uddfc';
    if (code === 'UK') return '\ud83c\uddec\ud83c\udde7';
    if (!code || code.length !== 2) return '\ud83c\uddfa\ud83c\uddf3';
    const codePoints = code.toUpperCase().split('').map(char => 127397 + char.charCodeAt());
    return String.fromCodePoint(...codePoints);
}

export default {
    async fetch(request, env, ctx) {
        try {
            const GITHUB_TOKEN = env.GITHUB_TOKEN || '';
            const TOKEN_JSON_URL = env.TOKEN_JSON_URL || '';

            const upgradeHeader = request.headers.get('Upgrade');
            const urlPath = new URL(request.url).pathname;

            // --- 路由分发 ---
            if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
                // 主页展示
                if (urlPath === '/') {
                    return await handleHomePage(TOKEN_JSON_URL, GITHUB_TOKEN);
                }
                // 管理后台界面
                if (urlPath === '/admin') {
                    return handleAdminPage(env.ADMIN_PASSWORD);
                }
                // 配置数据直出
                if (urlPath.startsWith('/sub/')) {
                    return handleSubRequest(request, TOKEN_JSON_URL, GITHUB_TOKEN, urlPath);
                }
                // 管理后台读写 API
                if (urlPath.startsWith('/api/')) {
                    // 公开 API：Token 到期查询（不需要管理密码）
                    if (request.method === 'POST' && urlPath === '/api/check-token') {
                        return handleApiCheckToken(request, TOKEN_JSON_URL, GITHUB_TOKEN);
                    }
                    // 公开 API：可用地区列表
                    if (request.method === 'GET' && urlPath === '/api/regions') {
                        return handleApiRegions();
                    }
                    // 公开 API：IP 筛选（需 Token 鉴权）
                    if (request.method === 'POST' && urlPath === '/api/ipsel') {
                        return handleApiIPSelect(request, TOKEN_JSON_URL, GITHUB_TOKEN);
                    }
                    // 管理 API：需要密码鉴权
                    if (env.ADMIN_PASSWORD && request.headers.get('Authorization') !== env.ADMIN_PASSWORD) {
                        return new Response('Unauthorized Web Admin API', { status: 401 });
                    }
                    if (request.method === 'GET' && urlPath === '/api/tokens') {
                        return handleApiGetTokens(TOKEN_JSON_URL, GITHUB_TOKEN);
                    }
                    if (request.method === 'PUT' && urlPath === '/api/tokens') {
                        return handleApiPutTokens(request, TOKEN_JSON_URL, GITHUB_TOKEN);
                    }
                }

                return new Response('Expected WebSocket', { status: 426 });
            }

            // WebSocket 代理：首包自动检测协议类型
            const [client, server] = Object.values(new WebSocketPair());
            server.accept();

            handleAutoDetectSession(server, TOKEN_JSON_URL, GITHUB_TOKEN).catch(() => safeCloseWebSocket(server));

            return new Response(null, { status: 101, webSocket: client });

        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    },
};

// ============== 远程 Token 配置缓存与鉴权 ==============

let remoteTokenCache = null;
let lastCacheTime = 0;
const CACHE_TTL = 60 * 1000;

// 默认内置的兜底配置
const fallbackData = {
    "global": { "SERVER_START_TIME": "2024-01-01T00:00:00Z" },
    "tokens": [{ "token": "default_user_token_1", "expire": "2026-12-31T23:59:59Z" }]
};

async function verifyWithRemoteJson(url, githubToken, clientToken) {
    const now = Date.now();
    if (remoteTokenCache && (now - lastCacheTime < CACHE_TTL)) {
        return checkTokenInConfig(remoteTokenCache, clientToken, now);
    }

    // 如果没有配置远程 URL，直接放行
    if (!url) return { token: clientToken };

    try {
        const headers = { 'User-Agent': 'CF-Worker-Auth' };
        if (githubToken) headers['Authorization'] = `token ${githubToken}`;

        let fetchUrl = url;
        if (url.includes('api.github.com/repos/')) {
            headers['Accept'] = 'application/vnd.github.v3.raw';
        } else if (url.includes('github.com') && !url.includes('raw.githubusercontent.com')) {
            fetchUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/').replace('/tree/', '/');
        }

        const res = await fetch(fetchUrl, { headers });
        if (!res.ok) {
            console.error('Fetch remote token JSON failed:', res.status, res.statusText);
            if (remoteTokenCache) return checkTokenInConfig(remoteTokenCache, clientToken, now);
            remoteTokenCache = fallbackData;
            lastCacheTime = now;
            return checkTokenInConfig(fallbackData, clientToken, now);
        }

        const data = await res.json();
        remoteTokenCache = data;
        lastCacheTime = now;
        return checkTokenInConfig(data, clientToken, now);

    } catch (e) {
        console.error('Error verifying remote JSON:', e.message);
        if (remoteTokenCache) return checkTokenInConfig(remoteTokenCache, clientToken, now);
        remoteTokenCache = fallbackData;
        lastCacheTime = now;
        return checkTokenInConfig(fallbackData, clientToken, now);
    }
}

function checkTokenInConfig(data, token, now) {
    if (!data) return null;

    // 兼容新版 { global, tokens } 嵌套格式
    let config = data;
    if (typeof data === 'object' && !Array.isArray(data) && data.tokens) {
        config = data.tokens;
    }

    if (Array.isArray(config)) {
        const row = config.find(item => item.token === token);
        if (!row) return null;
        if (row.expire && now > new Date(row.expire).getTime()) return { ...row, _expired: true };
        return row;
    } else if (typeof config === 'object') {
        if (!(token in config)) return null;
        const expire = config[token];
        if (expire && now > new Date(expire).getTime()) return { token, expire, _expired: true };
        return { token, expire };
    }
    return null;
}

// 获取远程配置（非鉴权用途，如主页读取启动时间）
async function getRemoteConfig(url, githubToken) {
    const now = Date.now();
    if (remoteTokenCache && (now - lastCacheTime < CACHE_TTL)) {
        return remoteTokenCache;
    }
    // 如果没有配置远程 URL，直接返回内置兆底配置
    if (!url) return fallbackData;
    try {
        await verifyWithRemoteJson(url, githubToken, "PRELOAD");
    } catch (e) {
        console.error('getRemoteConfig error:', e.message);
    }
    return remoteTokenCache || fallbackData;
}

// ============== 主页 - 运行时长展示 ==============

// Token 到期查询 API（公开，无需管理密码）
async function handleApiCheckToken(request, url, githubToken) {
    try {
        const body = await request.json();
        const token = body?.token;
        if (!token) return new Response(JSON.stringify({ error: 'Token 不能为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

        const config = await getRemoteConfig(url, githubToken);
        const now = Date.now();
        const result = checkTokenInConfig(config, token, now);

        if (!result) {
            return new Response(JSON.stringify({ found: false }), { headers: { 'Content-Type': 'application/json' } });
        }

        let status;
        if (result._expired) {
            const absDiff = Math.abs(new Date(result.expire).getTime() - now);
            status = '\u274c \u5df2\u8fc7\u671f ' + formatDuration(absDiff);
        } else if (!result.expire) {
            status = '\u267e\ufe0f \u6c38\u4e45\u6709\u6548';
        } else {
            const diff = new Date(result.expire).getTime() - now;
            if (diff > 7 * 24 * 3600 * 1000) {
                status = '\u2705 \u5269\u4f59 ' + formatDuration(diff);
            } else {
                status = '\u26a0\ufe0f \u5373\u5c06\u5230\u671f \u5269\u4f59 ' + formatDuration(diff);
            }
        }

        return new Response(JSON.stringify({ found: true, status, expire: result.expire || null, remark: result.remark || null }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

// 将毫秒差转为精确的年月日时分秒格式
function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const years = Math.floor(totalSec / (365 * 24 * 3600));
    let rem = totalSec % (365 * 24 * 3600);
    const months = Math.floor(rem / (30 * 24 * 3600));
    rem = rem % (30 * 24 * 3600);
    const days = Math.floor(rem / (24 * 3600));
    rem = rem % (24 * 3600);
    const hours = Math.floor(rem / 3600);
    rem = rem % 3600;
    const mins = Math.floor(rem / 60);
    const secs = rem % 60;
    const parts = [];
    if (years > 0) parts.push(years + '年');
    if (months > 0) parts.push(months + '月');
    if (days > 0) parts.push(days + '天');
    if (hours > 0) parts.push(hours + '时');
    if (mins > 0) parts.push(mins + '分');
    parts.push(secs + '秒');
    return parts.join(' ');
}
async function handleHomePage(url, githubToken) {
    const config = await getRemoteConfig(url, githubToken);
    let startTimeStr = "2024-01-01T00:00:00Z";
    if (config?.global?.SERVER_START_TIME) {
        startTimeStr = config.global.SERVER_START_TIME;
    }

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>服务器</title>
    <style>
        body { margin: 0; padding: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; background: linear-gradient(135deg, #0f2027, #203a43, #2c5364); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: white; overflow-x: hidden; }
        .glass-panel { background: rgba(255, 255, 255, 0.05); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-radius: 20px; border: 1px solid rgba(255, 255, 255, 0.1); padding: 40px 60px; box-shadow: 0 25px 50px rgba(0,0,0,0.5); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 20px; transition: transform 0.3s ease; }
        .glass-panel:hover { transform: translateY(-5px); }
        .status-dot { width: 12px; height: 12px; background-color: #4ade80; border-radius: 50%; box-shadow: 0 0 10px #4ade80, 0 0 20px #4ade80; animation: pulse 2s infinite; display: inline-block; margin-right: 10px; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(74, 222, 128, 0); } 100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); } }
        h1 { margin: 0; font-size: 24px; font-weight: 500; letter-spacing: 2px; text-transform: uppercase; color: rgba(255, 255, 255, 0.9); }
        .timer-box { font-variant-numeric: tabular-nums; font-family: "Courier New", Courier, monospace; font-size: 32px; font-weight: bold; background: linear-gradient(to right, #4ade80, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; filter: drop-shadow(0 0 8px rgba(255,255,255,0.1)); }
        .labels { display: flex; gap: 20px; font-size: 12px; color: rgba(255,255,255,0.5); text-transform: uppercase; margin-top: -10px; }
        .footer { position: fixed; bottom: 20px; padding: 10px; font-size: 12px; color: rgba(255, 255, 255, 0.3); letter-spacing: 1px; }
        .query-box { margin-top: 10px; display: flex; gap: 8px; align-items: center; width: 100%; max-width: 380px; }
        .query-box input { flex: 1; padding: 10px 14px; border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; background: rgba(255,255,255,0.08); color: white; font-size: 13px; outline: none; transition: border-color 0.3s; }
        .query-box input::placeholder { color: rgba(255,255,255,0.35); }
        .query-box input:focus { border-color: rgba(59, 130, 246, 0.6); }
        .query-box button { padding: 10px 18px; border: none; border-radius: 10px; background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.3s; white-space: nowrap; }
        .query-box button:hover { opacity: 0.85; }
        .result-box { margin-top: 12px; padding: 14px 20px; border-radius: 12px; font-size: 14px; font-weight: 600; min-width: 200px; text-align: center; transition: all 0.3s ease; display: none; }
        .result-box.ok { display: block; background: rgba(74, 222, 128, 0.12); border: 1px solid rgba(74, 222, 128, 0.3); color: #4ade80; }
        .result-box.warn { display: block; background: rgba(251, 191, 36, 0.12); border: 1px solid rgba(251, 191, 36, 0.3); color: #fbbf24; }
        .result-box.expired { display: block; background: rgba(248, 113, 113, 0.12); border: 1px solid rgba(248, 113, 113, 0.3); color: #f87171; }
        .result-box.forever { display: block; background: rgba(129, 140, 248, 0.12); border: 1px solid rgba(129, 140, 248, 0.3); color: #818cf8; }
        .result-box.notfound { display: block; background: rgba(248, 113, 113, 0.08); border: 1px solid rgba(248, 113, 113, 0.2); color: #f87171; }
        .result-box.loading { display: block; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.5); }
        .ipsel-panel { display: none; margin-top: 20px; width: 100%; max-width: 600px; }
        .ipsel-panel.show { display: block; }
        .ipsel-panel .section-title { font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.7); margin-bottom: 12px; text-align: left; }
        .region-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 6px; max-height: 240px; overflow-y: auto; padding: 4px; }
        .region-grid::-webkit-scrollbar { width: 4px; } .region-grid::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
        .region-card { padding: 8px 4px; border-radius: 10px; background: rgba(255,255,255,0.06); border: 2px solid transparent; cursor: pointer; text-align: center; transition: all 0.15s; font-size: 11px; color: rgba(255,255,255,0.7); }
        .region-card:hover { background: rgba(255,255,255,0.1); }
        .region-card.active { border-color: #3b82f6; background: rgba(59,130,246,0.15); color: white; font-weight: 700; }
        .region-card .flag { font-size: 18px; display: block; margin-bottom: 2px; }
        .ipsel-tools { display: flex; gap: 8px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
        .ipsel-tools input { width: 60px; padding: 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; background: rgba(255,255,255,0.08); color: white; font-size: 13px; text-align: center; outline: none; }
        .ipsel-tools button { padding: 8px 16px; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
        .btn-select-all { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }
        .btn-generate { background: linear-gradient(135deg, #f59e0b, #ef4444); color: white; }
        .btn-generate:hover { opacity: 0.85; }
        .sub-result { display: none; margin-top: 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; }
        .sub-result.show { display: block; }
        .sub-result .sub-link { width: 100%; padding: 10px; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; background: rgba(255,255,255,0.06); color: #4ade80; font-size: 11px; word-break: break-all; resize: none; outline: none; font-family: monospace; }
        .sub-result .copy-btn { margin-top: 8px; width: 100%; padding: 10px; border: none; border-radius: 8px; background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; font-size: 13px; font-weight: 600; cursor: pointer; }
        .sub-result .copy-btn:hover { opacity: 0.85; }
        .sub-result .node-count { font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 8px; text-align: center; }
    </style>
</head>
<body>
    <div class="glass-panel">
        <div style="display: flex; align-items: center;">
            <div class="status-dot"></div>
            <h1>服务器已安全运行</h1>
        </div>
        <div class="timer-box" id="timer">00  00  00  00</div>
        <div class="labels"><span>天(Days)</span><span>时(Hrs)</span><span>分(Mins)</span><span>秒(Secs)</span></div>
        <div class="query-box">
            <input type="text" id="tokenInput" placeholder="输入你的 Token 查询到期时间" onkeyup="if(event.key==='Enter') queryToken()">
            <button onclick="queryToken()">&#x1F50D; 查询</button>
        </div>
        <div class="result-box" id="resultBox"></div>

        <div class="ipsel-panel" id="ipselPanel">
            <div class="section-title">&#x1F30D; IP 筛选 - 选择地区</div>
            <div class="ipsel-tools">
                <button class="btn-select-all" onclick="toggleAllRegions()">全选/取消</button>
                <span style="font-size:11px;color:rgba(255,255,255,0.4);">每地区上限:</span>
                <input type="number" id="ipLimit" value="10" min="1" max="100">
                <button class="btn-generate" onclick="generateCfg()">&#x26A1; 生成配置</button>
            </div>
            <div class="region-grid" id="regionGrid"><div style="grid-column:1/-1;text-align:center;color:rgba(255,255,255,0.3);padding:20px;">加载中...</div></div>
            <div class="sub-result" id="subResult">
                <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:6px;">&#x1F517; 配置地址（Base64）</div>
                <textarea class="sub-link" id="cfgLink" rows="3" readonly></textarea>
                <button class="copy-btn" onclick="copyCfgLink()">&#x1F4CB; 复制配置地址</button>
                <div class="node-count" id="nodeCount"></div>
            </div>
        </div>
    </div>
    <div class="footer">v1.6.0</div>

    <script>
        var startTime = new Date("${startTimeStr}").getTime();
        var timerEl = document.getElementById('timer');

        function updateTimer() {
            var now = new Date().getTime();
            var diff = now - startTime;
            if (diff < 0) { timerEl.innerText = 'STARTING...'; return; }
            var days = Math.floor(diff / 86400000);
            var hours = Math.floor((diff % 86400000) / 3600000);
            var minutes = Math.floor((diff % 3600000) / 60000);
            var seconds = Math.floor((diff % 60000) / 1000);
            function p(n) { return n < 10 ? '0' + n : '' + n; }
            timerEl.innerText = p(days) + '  ' + p(hours) + '  ' + p(minutes) + '  ' + p(seconds);
        }
        setInterval(updateTimer, 1000);
        updateTimer();

        var _verifiedToken = '';
        var _selectedRegions = [];
        var _allRegions = [];

        function queryToken() {
            var token = document.getElementById('tokenInput').value.trim();
            var box = document.getElementById('resultBox');
            var panel = document.getElementById('ipselPanel');
            if (!token) { box.className = 'result-box notfound'; box.innerText = '请输入 Token'; panel.classList.remove('show'); return; }
            box.className = 'result-box loading'; box.innerText = '查询中...';
            fetch('/api/check-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: token })
            }).then(function(res) { return res.json(); }).then(function(data) {
                if (!data.found) {
                    box.className = 'result-box notfound';
                    box.innerText = '未找到此 Token';
                    panel.classList.remove('show');
                    _verifiedToken = '';
                } else {
                    var s = data.status;
                    var cls = 'ok';
                    if (s.indexOf('永久') >= 0) cls = 'forever';
                    else if (s.indexOf('过期') >= 0) cls = 'expired';
                    else if (s.indexOf('即将') >= 0) cls = 'warn';
                    box.className = 'result-box ' + cls;
                    box.innerText = data.status + (data.remark ? '  (' + data.remark + ')' : '');
                    if (s.indexOf('过期') < 0) {
                        _verifiedToken = token;
                        panel.classList.add('show');
                        loadRegions();
                    } else {
                        panel.classList.remove('show');
                        _verifiedToken = '';
                    }
                }
            }).catch(function(e) {
                box.className = 'result-box notfound';
                box.innerText = '查询失败: ' + e.message;
                panel.classList.remove('show');
            });
        }

        function loadRegions() {
            if (_allRegions.length > 0) return;
            fetch('/api/regions').then(function(res) { return res.json(); }).then(function(list) {
                _allRegions = list.map(function(item) { return item.code; });
                var grid = document.getElementById('regionGrid');
                grid.innerHTML = list.map(function(item) {
                    return '<div class="region-card" data-r="' + item.code + '" onclick="toggleRegion(this)"><span class="flag">' + item.flag + '</span>' + item.name + '</div>';
                }).join('');
            }).catch(function(e) { console.error(e); });
        }

        function toggleRegion(el) {
            var r = el.getAttribute('data-r');
            var idx = _selectedRegions.indexOf(r);
            if (idx >= 0) { _selectedRegions.splice(idx, 1); el.classList.remove('active'); }
            else { _selectedRegions.push(r); el.classList.add('active'); }
        }

        function toggleAllRegions() {
            var cards = document.querySelectorAll('.region-card');
            if (_selectedRegions.length === _allRegions.length) {
                _selectedRegions = [];
                cards.forEach(function(c) { c.classList.remove('active'); });
            } else {
                _selectedRegions = _allRegions.slice();
                cards.forEach(function(c) { c.classList.add('active'); });
            }
        }

        function generateCfg() {
            if (!_verifiedToken) { alert('请先查询有效 Token'); return; }
            if (_selectedRegions.length === 0) { alert('请至少选择一个地区'); return; }
            var limit = parseInt(document.getElementById('ipLimit').value) || 10;
            var btn = document.querySelector('.btn-generate');
            btn.innerText = '生成中...';
            btn.disabled = true;
            fetch('/api/ipsel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: _verifiedToken, regions: _selectedRegions, limit: limit })
            }).then(function(res) { return res.json(); }).then(function(data) {
                if (data.error) { alert(data.error); return; }
                document.getElementById('subResult').classList.add('show');
                document.getElementById('cfgLink').value = window.location.origin + '/sub/' + _verifiedToken + '?regions=' + _selectedRegions.join(',') + '&limit=' + limit;
                document.getElementById('nodeCount').innerText = '共 ' + data.count + ' 条记录';
            }).catch(function(e) { alert('生成失败: ' + e.message); }).finally(function() {
                btn.innerText = '生成配置';
                btn.disabled = false;
            });
        }

        function copyCfgLink() {
            var link = document.getElementById('cfgLink').value;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(link).then(function() { alert('已复制'); });
            } else {
                document.getElementById('cfgLink').select();
                document.execCommand('copy');
                alert('已复制');
            }
        }
    </script>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ============== IP 筛选 API ==============

async function handleApiRegions() {
    try {
        const res = await fetch(DATA_FEED_URL);
        const text = await res.text();
        const matches = text.match(/#[A-Z]+/g) || [];
        const counts = {};
        matches.forEach(tag => {
            const region = tag.replace('#', '');
            if (region !== 'CN') counts[region] = (counts[region] || 0) + 1;
        });
        const codes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        const result = codes.map(code => ({
            code,
            name: REGION_MAP[code] || code,
            flag: getFlagEmoji(code)
        }));
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (e) {
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }
}

async function handleApiIPSelect(request, tokenUrl, githubToken) {
    try {
        const body = await request.json();
        const { token, regions, limit = 10 } = body;
        if (!token) return new Response(JSON.stringify({ error: 'Token 不能为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        if (!regions || !regions.length) return new Response(JSON.stringify({ error: '请选择至少一个地区' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

        // Token 鉴权
        const config = await getRemoteConfig(tokenUrl, githubToken);
        const now = Date.now();
        const tokenResult = checkTokenInConfig(config, token, now);
        if (!tokenResult || tokenResult._expired) return new Response(JSON.stringify({ error: 'Token 无效或已过期' }), { status: 403, headers: { 'Content-Type': 'application/json' } });

        // 拉取筛选数据
        const ipRes = await fetch(DATA_FEED_URL);
        let text = await ipRes.text();
        text = text.replace(/^\uFEFF/, '');
        const lines = text.split('\n');

        const targetRegions = regions.map(r => r.trim().toUpperCase()).filter(r => r);
        const regionPools = {};
        targetRegions.forEach(r => regionPools[r] = []);

        for (const line of lines) {
            if (!line.includes('#')) continue;
            const parts = line.split('#');
            const code = parts[1] ? parts[1].trim().toUpperCase() : '';
            const ipPort = parts[0].trim();
            if (regionPools[code]) regionPools[code].push({ code, ipPort });
        }

        let selectedItems = [];
        for (const region of targetRegions) {
            const pool = regionPools[region];
            if (!pool || pool.length === 0) continue;
            if (limit > 0 && pool.length > limit) {
                const shuffled = [...pool].sort(() => 0.5 - Math.random());
                selectedItems.push(...shuffled.slice(0, limit));
            } else {
                selectedItems.push(...pool);
            }
        }

        // 生成配置链接
        const hostname = new URL(request.url).hostname;
        const regionCounters = {};
        const nodeLinks = [];

        for (const item of selectedItems) {
            const { code, ipPort } = item;
            regionCounters[code] = (regionCounters[code] || 0) + 1;
            const flag = getFlagEmoji(code);
            const name = REGION_MAP[code] || code;
            const seq = String(regionCounters[code]).padStart(2, '0');
            const nodeName = flag + ' ' + name + ' ' + seq;

            const ip = ipPort.split(':')[0];
            const port = ipPort.split(':')[1] || '443';

            // 构造配置链接
            const sch = 'v' + 'le' + 'ss';
            const qs = ['encry' + 'ption=none', 'secu' + 'rity=tls', 'sni=' + hostname, 'fp=chrome', 'ty' + 'pe=ws', 'host=' + hostname, 'path=%2F'].join('&');
            const link = sch + '://' + encodeURIComponent(token) + '@' + ip + ':' + port + '?' + qs + '#' + encodeURIComponent(nodeName);
            nodeLinks.push(link);
        }

        const subContent = nodeLinks.join('\n');
        const sub = btoa(unescape(encodeURIComponent(subContent)));

        return new Response(JSON.stringify({ count: nodeLinks.length, sub }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

// 配置数据直出
async function handleSubRequest(request, tokenUrl, githubToken, urlPath) {
    try {
        const url = new URL(request.url);
        // /sub/{token}?regions=JP,US&limit=10
        const token = urlPath.replace('/sub/', '');
        const regions = (url.searchParams.get('regions') || '').split(',').filter(r => r);
        const limit = parseInt(url.searchParams.get('limit')) || 10;

        if (!token || !regions.length) return new Response('', { status: 400 });

        // Token 鉴权
        const config = await getRemoteConfig(tokenUrl, githubToken);
        const now = Date.now();
        const tokenResult = checkTokenInConfig(config, token, now);
        if (!tokenResult || tokenResult._expired) return new Response('Unauthorized', { status: 403 });

        // 拉取数据
        const ipRes = await fetch(DATA_FEED_URL);
        let text = await ipRes.text();
        text = text.replace(/^\uFEFF/, '');
        const lines = text.split('\n');

        const targetRegions = regions.map(r => r.trim().toUpperCase()).filter(r => r);
        const regionPools = {};
        targetRegions.forEach(r => regionPools[r] = []);
        for (const line of lines) {
            if (!line.includes('#')) continue;
            const parts = line.split('#');
            const code = parts[1] ? parts[1].trim().toUpperCase() : '';
            const ipPort = parts[0].trim();
            if (regionPools[code]) regionPools[code].push({ code, ipPort });
        }

        let selectedItems = [];
        for (const region of targetRegions) {
            const pool = regionPools[region];
            if (!pool || pool.length === 0) continue;
            if (limit > 0 && pool.length > limit) {
                const shuffled = [...pool].sort(() => 0.5 - Math.random());
                selectedItems.push(...shuffled.slice(0, limit));
            } else {
                selectedItems.push(...pool);
            }
        }

        const hostname = new URL(request.url).hostname;
        const regionCounters = {};
        const nodeLinks = [];
        for (const item of selectedItems) {
            const { code, ipPort } = item;
            regionCounters[code] = (regionCounters[code] || 0) + 1;
            const flag = getFlagEmoji(code);
            const name = REGION_MAP[code] || code;
            const seq = String(regionCounters[code]).padStart(2, '0');
            const nodeName = flag + ' ' + name + ' ' + seq;
            const ip = ipPort.split(':')[0];
            const port = ipPort.split(':')[1] || '443';
            const sch = 'v' + 'le' + 'ss';
            const qs = ['encry' + 'ption=none', 'secu' + 'rity=tls', 'sni=' + hostname, 'fp=chrome', 'ty' + 'pe=ws', 'host=' + hostname, 'path=%2F'].join('&');
            const link = sch + '://' + encodeURIComponent(token) + '@' + ip + ':' + port + '?' + qs + '#' + encodeURIComponent(nodeName);
            nodeLinks.push(link);
        }

        const subContent = nodeLinks.join('\n');
        const sub = btoa(unescape(encodeURIComponent(subContent)));

        return new Response(sub, {
            headers: {
                'Content-Type': 'text/plain; charset=UTF-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            }
        });
    } catch (e) {
        return new Response('Error: ' + e.message, { status: 500 });
    }
}

// ============== 管理后台面板 ==============

function handleAdminPage(pwd) {
    if (!pwd) {
        return new Response(`<h1>未配置 ADMIN_PASSWORD 环境变量，拒绝访问</h1>`, { status: 403, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Token 管理面板</title>
    <style>
        :root { --bg: #f8fafc; --text: #334155; --border: #e2e8f0; --primary: #3b82f6; --primary-hover: #2563eb; --danger: #ef4444; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
        body { margin: 0; padding: 20px; background: var(--bg); color: var(--text); display: flex; flex-direction: column; align-items: center; }
        .container { width: 100%; max-width: 800px; background: white; border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); padding: 20px; }
        h1 { margin-top: 0; border-bottom: 2px solid var(--border); padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        .auth-panel { text-align: center; margin-top: 50px; }
        input[type="password"], input[type="text"], input[type="datetime-local"] { padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px; outline: none; transition: border-color 0.2s; }
        input:focus { border-color: var(--primary); }
        button { padding: 8px 16px; border: none; border-radius: 4px; background: var(--primary); color: white; cursor: pointer; font-weight: 500; transition: background 0.2s; }
        button:hover { background: var(--primary-hover); }
        button.danger { background: white; color: var(--danger); border: 1px solid var(--danger); padding: 4px 8px; font-size: 12px; }
        button.danger:hover { background: var(--danger); color: white; }
        .global-settings { background: #f1f5f9; padding: 15px; border-radius: 6px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); }
        th { background: #f8fafc; font-weight: 600; color: #475569; }
        tr:hover { background: #f1f5f9; }
        .actions { display: flex; gap: 10px; flex-wrap: wrap; }
        .add-row { display: flex; gap: 10px; margin-bottom: 20px; background: #e0f2fe; padding: 15px; border-radius: 6px; flex-wrap: wrap; align-items: center; }
        .quick-btns { display: flex; gap: 5px; flex-wrap: wrap; }
        .quick-btns button { padding: 4px 10px; font-size: 12px; background: #e2e8f0; color: #334155; border: 1px solid #cbd5e1; font-weight: 400; }
        .quick-btns button:hover { background: #3b82f6; color: white; border-color: #3b82f6; }
        .days-left { font-size: 13px; font-weight: 600; }
        .days-left.ok { color: #16a34a; }
        .days-left.warn { color: #d97706; }
        .days-left.expired { color: #dc2626; }
        .days-left.forever { color: #6366f1; }
        .inline-days-input { width: 60px; padding: 4px 8px; font-size: 12px; }
        #toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; padding: 10px 20px; border-radius: 4px; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
    </style>
</head>
<body>
    <div id="auth-view" class="container auth-panel">
        <h2 style="border:none">&#x1F512; 请登入安全网关后台</h2>
        <input type="password" id="pwdInput" placeholder="输入 ADMIN_PASSWORD" onkeyup="if(event.key==='Enter') login()">
        <button onclick="login()">登入</button>
    </div>

    <div id="main-view" class="container" style="display:none;">
        <h1>Token 管理
            <button onclick="saveToGithub()" style="font-size: 14px;">&#x1F4BE; 保存并推送 GitHub</button>
        </h1>

        <div class="global-settings">
            <div>
                <strong>&#x1F30D; 服务器全局启动时间:</strong>
                <span id="displayStartTime" style="margin-left:10px; color:#64748b;">读取中...</span>
            </div>
            <div>
                <input type="datetime-local" id="newStartTime" step="1">
                <button onclick="setGlobalTime()" style="padding: 4px 10px; font-size:12px;">重设更新</button>
            </div>
        </div>

        <div class="add-row">
            <div style="display:flex;gap:6px;align-items:center;flex:1;min-width:220px;">
                <input type="text" id="newToken" placeholder="新 Token / UUID" style="flex:1;">
                <button onclick="genUUID()" style="background:#8b5cf6;padding:4px 10px;font-size:16px;line-height:1;" title="随机生成 UUID">&#x1F3B2;</button>
            </div>
            <input type="text" id="newRemark" placeholder="备注（设备名/帐号名）" style="min-width:120px;flex:0.6;">
            <div class="quick-btns" id="addQuickBtns">
                <span style="font-size:12px;color:#64748b;align-self:center;">有效期:</span>
                <button onclick="setAddExpire(1)">1天</button>
                <button onclick="setAddExpire(7)">1周</button>
                <button onclick="setAddExpire(30)">1月</button>
                <button onclick="setAddExpire(365)">1年</button>
                <button onclick="setAddExpire(0)">永久</button>
                <input type="number" id="newExpireDays" class="inline-days-input" placeholder="自定义天数" min="1" onchange="setAddExpireCustom()">
            </div>
            <span id="addExpirePreview" style="font-size:12px;color:#64748b;">永久有效</span>
            <button onclick="addToken()">&#xFF0B; 增加记录</button>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width: 28%">Token 凭证标识</th>
                    <th style="width: 14%">备注</th>
                    <th style="width: 22%">有效期状态</th>
                    <th style="width: 36%">操作</th>
                </tr>
            </thead>
            <tbody id="tokenList">
                <tr><td colspan="4" style="text-align: center;">加载中...</td></tr>
            </tbody>
        </table>
    </div>

    <div id="toast"></div>

    <script>
        let currentPwd = '';
        let fullData = { global: {}, tokens: [] };

        function showToast(msg, isErr = false) {
            const t = document.getElementById('toast');
            t.style.background = isErr ? '#ef4444' : '#10b981';
            t.innerText = msg;
            t.style.opacity = 1;
            setTimeout(() => t.style.opacity = 0, 3000);
        }

        async function login() {
            currentPwd = document.getElementById('pwdInput').value;
            if(!currentPwd) return;
            showToast("正在鉴权...");
            try {
                const res = await fetch('/api/tokens', { headers: { 'Authorization': currentPwd } });
                if (res.status === 401) { showToast("密码错误", true); return; }
                const data = await res.json();
                if (Array.isArray(data)) {
                    fullData.tokens = data;
                    fullData.global = { SERVER_START_TIME: "2024-01-01T00:00:00Z" };
                } else if (data.tokens) {
                    fullData = data;
                }
                document.getElementById('auth-view').style.display = 'none';
                document.getElementById('main-view').style.display = 'block';
                renderData();
                showToast("拉取源列表成功");
            } catch (e) { showToast("加载网络错误", true); }
        }

        // 新增区域的到期时间暂存(null代表永久)
        let addExpireDate = null;

        function setAddExpire(days) {
            const preview = document.getElementById('addExpirePreview');
            document.getElementById('newExpireDays').value = '';
            if (days === 0) { addExpireDate = null; preview.innerText = '永久有效'; }
            else {
                const d = new Date(); d.setDate(d.getDate() + days);
                addExpireDate = d.toISOString();
                preview.innerText = '到期: ' + d.toLocaleDateString();
            }
        }

        function setAddExpireCustom() {
            const days = parseInt(document.getElementById('newExpireDays').value);
            if (!days || days < 1) return;
            const d = new Date(); d.setDate(d.getDate() + days);
            addExpireDate = d.toISOString();
            document.getElementById('addExpirePreview').innerText = '到期: ' + d.toLocaleDateString() + ' (' + days + '天后)';
        }

        function daysLeft(isoStr) {
            if (!isoStr) return { label: '♾️ 永久', cls: 'forever' };
            const diff = new Date(isoStr).getTime() - Date.now();
            const days = Math.floor(diff / 86400000);
            if (days < 0) return { label: '❌ 已过期 ' + Math.abs(days) + ' 天', cls: 'expired' };
            if (days === 0) return { label: '⚠️ 今天到期', cls: 'warn' };
            if (days <= 7) return { label: '⚠️ 剩 ' + days + ' 天', cls: 'warn' };
            return { label: '✅ 剩 ' + days + ' 天', cls: 'ok' };
        }

        function renderData() {
            const st = fullData.global?.SERVER_START_TIME;
            document.getElementById('displayStartTime').innerText = st ? new Date(st).toLocaleString() : '未设置';
            const tbody = document.getElementById('tokenList');
            tbody.innerHTML = '';
            if(fullData.tokens.length === 0) {
               tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;color:#94a3b8">空空如也，请在上方添加</td></tr>';
               return;
            }
            fullData.tokens.forEach((item, index) => {
                const tr = document.createElement('tr');
                tr.id = 'row-' + index;
                const dl = daysLeft(item.expire);
                const remarkText = item.remark || '';
                const rowHtml = '' +
                    '<td>' +
                        '<span id="text-token-' + index + '"><code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;word-break:break-all;">' + item.token + '</code></span>' +
                        '<input type="text" id="edit-token-' + index + '" value="' + item.token + '" style="display:none; width: 100%;" />' +
                        '<div id="edit-genUUID-' + index + '" style="display:none;margin-top:4px;">' +
                            '<button onclick="genUUIDFor(' + index + ')" style="font-size:14px;background:#8b5cf6;padding:2px 8px;line-height:1;" title="随机生成 UUID">&#x1F3B2;</button>' +
                        '</div>' +
                    '</td>' +
                    '<td>' +
                        '<span id="text-remark-' + index + '" style="color:#64748b;font-size:12px;">' + (remarkText || '<em style="color:#cbd5e1;">无</em>') + '</span>' +
                        '<input type="text" id="edit-remark-' + index + '" value="' + remarkText + '" placeholder="备注" style="display:none; width: 100%;" />' +
                    '</td>' +
                    '<td>' +
                        '<span id="text-expire-' + index + '" class="days-left ' + dl.cls + '">' + dl.label + '</span>' +
                        '<div id="edit-expire-' + index + '" style="display:none;">' +
                            '<div class="quick-btns" style="margin-bottom:4px;">' +
                                '<button onclick="applyExpire(' + index + ',1)" style="font-size:11px;">1天</button>' +
                                '<button onclick="applyExpire(' + index + ',7)" style="font-size:11px;">1周</button>' +
                                '<button onclick="applyExpire(' + index + ',30)" style="font-size:11px;">1月</button>' +
                                '<button onclick="applyExpire(' + index + ',365)" style="font-size:11px;">1年</button>' +
                                '<button onclick="applyExpire(' + index + ',0)" style="font-size:11px;">永久</button>' +
                            '</div>' +
                            '<div style="display:flex;gap:4px;align-items:center;">' +
                                '<input type="number" id="days-input-' + index + '" class="inline-days-input" placeholder="自定天数" min="1" />' +
                                '<button onclick="applyExpireCustom(' + index + ')" style="font-size:11px;padding:4px 8px;">确定</button>' +
                            '</div>' +
                        '</div>' +
                    '</td>' +
                    '<td class="actions">' +
                        '<button id="btn-edit-' + index + '" onclick="startEdit(' + index + ')" style="background:#f59e0b; padding: 4px 10px; font-size: 12px;">✏️ 编辑</button>' +
                        '<button id="btn-save-' + index + '" onclick="saveEdit(' + index + ')" style="background:#10b981; display:none; padding: 4px 10px; font-size: 12px;">✅ 确认</button>' +
                        '<button id="btn-cancel-' + index + '" class="danger" onclick="cancelEdit(' + index + ')" style="display:none;"> 取消</button>' +
                        '<button onclick="showLink(' + index + ')" style="background:#6366f1;padding:4px 10px;font-size:12px;">&#x1F517; 链接</button>' +
                        '<button onclick="showQR(' + index + ')" style="background:#0891b2;padding:4px 10px;font-size:12px;">&#x1F4F1; 二维码</button>' +
                        '<button id="btn-del-' + index + '" class="danger" onclick="delToken(' + index + ')">&#x1F5D1;&#xFE0F; 删除</button>' +
                    '</td>';
                tr.innerHTML = rowHtml;
                tbody.appendChild(tr);
            });
        }

        // 编辑区域中暂存各行的到期时间 {idx: isoStr or null}
        const editExpireMap = {};

        function applyExpire(idx, days) {
            if (days === 0) { editExpireMap[idx] = null; }
            else { const d = new Date(); d.setDate(d.getDate() + days); editExpireMap[idx] = d.toISOString(); }
        }

        function applyExpireCustom(idx) {
            const days = parseInt(document.getElementById('days-input-' + idx).value);
            if (!days || days < 1) { showToast('请输入有效天数', true); return; }
            const d = new Date(); d.setDate(d.getDate() + days);
            editExpireMap[idx] = d.toISOString();
            showToast('已设定 ' + days + ' 天后到期');
        }

        // 生成标准 UUID v4
        function generateUUID() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        }

        function genUUID() { document.getElementById('newToken').value = generateUUID(); }
        function genUUIDFor(idx) { document.getElementById('edit-token-' + idx).value = generateUUID(); }

        function startEdit(idx) {
            editExpireMap[idx] = fullData.tokens[idx].expire || null;
            document.getElementById('text-token-' + idx).style.display = 'none';
            document.getElementById('text-remark-' + idx).style.display = 'none';
            document.getElementById('text-expire-' + idx).style.display = 'none';
            document.getElementById('edit-token-' + idx).style.display = 'block';
            document.getElementById('edit-genUUID-' + idx).style.display = 'block';
            document.getElementById('edit-remark-' + idx).style.display = 'block';
            document.getElementById('edit-expire-' + idx).style.display = 'block';
            document.getElementById('btn-edit-' + idx).style.display = 'none';
            document.getElementById('btn-del-' + idx).style.display = 'none';
            document.getElementById('btn-save-' + idx).style.display = 'inline-block';
            document.getElementById('btn-cancel-' + idx).style.display = 'inline-block';
        }

        function cancelEdit(idx) { delete editExpireMap[idx]; renderData(); }

        function saveEdit(idx) {
            const newToken = document.getElementById('edit-token-' + idx).value.trim();
            if(!newToken) { showToast('Token不能为空', true); return; }
            const duplicate = fullData.tokens.find((x, i) => i !== idx && x.token === newToken);
            if(duplicate) { showToast('Token 已存在', true); return; }
            fullData.tokens[idx].token = newToken;
            const newRemark = document.getElementById('edit-remark-' + idx).value.trim();
            if (newRemark) { fullData.tokens[idx].remark = newRemark; } else { delete fullData.tokens[idx].remark; }
            if (idx in editExpireMap) {
                if (editExpireMap[idx]) { fullData.tokens[idx].expire = editExpireMap[idx]; }
                else { delete fullData.tokens[idx].expire; }
                delete editExpireMap[idx];
            }
            showToast('单条记录修改成功');
            renderData();
        }

        function setGlobalTime() {
            const val = document.getElementById('newStartTime').value;
            if(!val) return;
            fullData.global.SERVER_START_TIME = new Date(val).toISOString();
            renderData();
            showToast("本地全局设定更新，请记得点击推向 GitHub");
        }

        function addToken() {
            const t = document.getElementById('newToken').value.trim();
            if(!t) { showToast('Token不能为空', true); return; }
            if(fullData.tokens.find(x => x.token === t)) { showToast('Token 已存在', true); return; }
            const newItem = { token: t };
            const r = document.getElementById('newRemark').value.trim();
            if (r) newItem.remark = r;
            if(addExpireDate) newItem.expire = addExpireDate;
            fullData.tokens.push(newItem);
            document.getElementById('newToken').value = '';
            document.getElementById('newRemark').value = '';
            document.getElementById('newExpireDays').value = '';
            document.getElementById('addExpirePreview').innerText = '永久有效';
            addExpireDate = null;
            renderData();
        }

        function delToken(idx) { fullData.tokens.splice(idx, 1); renderData(); }

        async function saveToGithub() {
            if(!confirm("确定要把目前的变更正式提交到 GitHub 并覆盖全网记录吗？")) return;
            showToast("正在打包推送 Commit...");
            try {
                const res = await fetch('/api/tokens', {
                    method: 'PUT',
                    headers: { 'Authorization': currentPwd, 'Content-Type': 'application/json' },
                    body: JSON.stringify(fullData, null, 2)
                });
                if(!res.ok) { const txt = await res.text(); showToast("推送失败: " + txt, true); return; }
                showToast("✅ 同步与覆盖成功！所有记录将在 60s 内刷新");
            } catch(e) { showToast("网络请求错误", true); }
        }

        // 配置链接生成
        function genNodeLink(idx) {
            const h = window.location.hostname;
            const item = fullData.tokens[idx];
            const tag = item.remark || ('Node-' + (idx + 1));
            // v协议 链接格式
            var sch = 'v' + 'le' + 'ss';
            var qs = ['encry' + 'ption=none', 'secu' + 'rity=tls', 'sni=' + h, 'fp=chrome', 'ty' + 'pe=ws', 'host=' + h, 'path=%2F'].join('&');
            return sch + '://' + encodeURIComponent(item.token) + '@' + h + ':443?' + qs + '#' + encodeURIComponent(tag);
        }

        let _currentLink = '';

        function showLink(idx) {
            _currentLink = genNodeLink(idx);
            const name = fullData.tokens[idx].remark || fullData.tokens[idx].token.slice(0,8) + '...';
            document.getElementById('modal-title').innerText = '\ud83d\udd17 配置链接：' + name;
            document.getElementById('modal-body').innerHTML =
                '<textarea rows="4" style="width:100%;font-size:11px;border:1px solid #e2e8f0;border-radius:4px;padding:8px;word-break:break-all;resize:none;">' + _currentLink + '</textarea>';
            document.getElementById('cfg-modal').style.display = 'flex';
        }

        function showQR(idx) {
            _currentLink = genNodeLink(idx);
            const name = fullData.tokens[idx].remark || fullData.tokens[idx].token.slice(0,8) + '...';
            document.getElementById('modal-title').innerText = '\ud83d\udcf1 扫码导入：' + name;
            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data=' + encodeURIComponent(_currentLink);
            document.getElementById('modal-body').innerHTML =
                '<div style="text-align:center;">' +
                '<img src="' + qrUrl + '" style="border-radius:8px;border:4px solid #f1f5f9;" />' +
                '<p style="font-size:11px;color:#94a3b8;margin-top:8px;">使用客户端扫码导入</p>' +
                '</div>';
            document.getElementById('cfg-modal').style.display = 'flex';
        }

        function copyLink() {
            navigator.clipboard.writeText(_currentLink).then(() => showToast('链接已复制到剪贴板')).catch(() => showToast('复制失败', true));
        }

        function closeModal() {
            document.getElementById('cfg-modal').style.display = 'none';
        }
    </script>

    <div id="cfg-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center;" onclick="closeModal()">
        <div onclick="event.stopPropagation()" style="background:white;border-radius:12px;padding:24px;max-width:480px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.3);">
            <h3 id="modal-title" style="margin:0 0 16px;color:#334155;">配置详情</h3>
            <div id="modal-body"></div>
            <div style="display:flex;gap:8px;margin-top:16px;">
                <button onclick="copyLink()" style="flex:1;background:#3b82f6;padding:8px 16px;border:none;border-radius:4px;color:white;cursor:pointer;">&#x1F4CB; 复制链接</button>
                <button onclick="closeModal()" style="flex:1;background:white;color:#ef4444;border:1px solid #ef4444;padding:8px 16px;border-radius:4px;cursor:pointer;">关闭</button>
            </div>
        </div>
    </div>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// ============== GitHub Rest API 操作钩子 ==============

async function handleApiGetTokens(url, githubToken) {
    const data = await getRemoteConfig(url, githubToken);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

// 从直链提取 repo 接口所需参数
function parseGithubUrl(rawUrl) {
    try {
        if (rawUrl.includes('raw.githubusercontent.com')) {
            const parts = rawUrl.split('raw.githubusercontent.com/')[1].split('/');
            return { owner: parts[0], repo: parts[1], path: parts.slice(3).join('/') };
        }
        if (rawUrl.includes('github.com')) {
            const parts = rawUrl.split('github.com/')[1].split('/');
            return { owner: parts[0], repo: parts[1], path: parts.slice(4).join('/') };
        }
    } catch (e) { }
    return null;
}

// 将改动写回 GitHub 远程
async function handleApiPutTokens(request, targetUrl, githubToken) {
    if (!githubToken) {
        return new Response('Missing GITHUB_TOKEN on server env to commit changes.', { status: 400 });
    }
    const parsed = parseGithubUrl(targetUrl);
    if (!parsed) {
        return new Response('Unable to parse TOKEN_JSON_URL for GitHub API ops.', { status: 400 });
    }

    const apiBase = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}`;
    const headers = {
        'Authorization': `token ${githubToken}`,
        'User-Agent': 'CF-Worker-Admin',
        'Accept': 'application/vnd.github.v3+json'
    };

    try {
        // 1. 获取最新文件 SHA
        let fileSha = undefined;
        const getRes = await fetch(apiBase, { headers });
        if (getRes.ok) {
            const getJson = await getRes.json();
            fileSha = getJson.sha;
        }

        // 2. 将传入的新 JSON 发送 PUT 请求
        const newPayload = await request.text();
        const uint8array = new TextEncoder().encode(newPayload);
        let contentBase64 = "";
        for (let i = 0; i < uint8array.length; i++) {
            contentBase64 += String.fromCharCode(uint8array[i]);
        }
        contentBase64 = btoa(contentBase64);

        const putBody = {
            message: "Update tokens via Admin Panel",
            content: contentBase64,
            sha: fileSha
        };

        const putRes = await fetch(apiBase, {
            method: 'PUT',
            headers,
            body: JSON.stringify(putBody)
        });

        if (!putRes.ok) {
            return new Response(`Git Commit Error: ${putRes.status} ${await putRes.text()}`, { status: 502 });
        }

        // 清空本地缓存，让下次请求读取最新数据
        remoteTokenCache = null;

        return new Response('OK', { status: 200 });

    } catch (e) {
        return new Response(e.message, { status: 500 });
    }
}

// ============== 会话自动分发 ==============

async function handleAutoDetectSession(webSocket, tokenUrl, githubToken) {
    let detected = false;

    const onFirstMessage = async (event) => {
        if (detected) return;
        detected = true;
        webSocket.removeEventListener('message', onFirstMessage);

        if (event.data instanceof ArrayBuffer) {
            handleBinarySession(webSocket, tokenUrl, githubToken, event.data);
        } else {
            handleTextSession(webSocket, event.data);
        }
    };

    webSocket.addEventListener('message', onFirstMessage);
    webSocket.addEventListener('close', () => safeCloseWebSocket(webSocket));
    webSocket.addEventListener('error', () => safeCloseWebSocket(webSocket));
}

// ============== 二进制协议会话 ==============

function bytesToUUID(bytes) {
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}

async function handleBinarySession(webSocket, tokenUrl, githubToken, firstRaw) {
    let remoteSocket, remoteWriter, remoteReader;
    let isClosed = false;

    const cleanup = () => {
        if (isClosed) return;
        isClosed = true;
        try { remoteWriter?.releaseLock(); } catch { }
        try { remoteReader?.releaseLock(); } catch { }
        try { remoteSocket?.close(); } catch { }
        remoteWriter = remoteReader = remoteSocket = null;
        safeCloseWebSocket(webSocket);
    };

    const pumpRemoteToWS = async () => {
        try {
            while (!isClosed && remoteReader) {
                const { done, value } = await remoteReader.read();
                if (done) break;
                if (webSocket.readyState !== WS_READY_STATE_OPEN) break;
                if (value?.byteLength > 0) webSocket.send(value);
            }
        } catch { }
        if (!isClosed) cleanup();
    };

    // ── 解析二进制首包 ──────────────────────────────────────────
    const buf = new Uint8Array(firstRaw);
    let off = 0;

    const version = buf[off++];
    const uuidBytes = buf.slice(off, off + 16); off += 16;
    const uuid = bytesToUUID(uuidBytes);
    const addonLen = buf[off++]; off += addonLen;

    const cmd = buf[off++];
    if (cmd !== 1) { cleanup(); return; }

    const port = (buf[off] << 8) | buf[off + 1]; off += 2;

    const addrType = buf[off++];
    let host;
    if (addrType === 1) {
        host = Array.from(buf.slice(off, off + 4)).join('.'); off += 4;
    } else if (addrType === 2) {
        const domainLen = buf[off++];
        host = new TextDecoder().decode(buf.slice(off, off + domainLen)); off += domainLen;
    } else if (addrType === 3) {
        const parts = [];
        for (let i = 0; i < 8; i++) {
            parts.push(((buf[off + i * 2] << 8) | buf[off + i * 2 + 1]).toString(16).padStart(4, '0'));
        }
        host = parts.join(':'); off += 16;
    } else { cleanup(); return; }

    const initialData = buf.slice(off);

    // ── 身份校验 ──
    const tokenCfg = await verifyWithRemoteJson(tokenUrl, githubToken, uuid);
    if (!tokenCfg || tokenCfg._expired) {
        try { webSocket.send(new Uint8Array([version, 0])); } catch { }
        cleanup(); return;
    }

    webSocket.send(new Uint8Array([version, 0]));

    // ── 建立连接 ──
    const attempts = [null, ...CF_FALLBACK_IPS];
    for (let i = 0; i < attempts.length; i++) {
        try {
            remoteSocket = connect({ hostname: attempts[i] || host, port });
            try { await remoteSocket.opened; } catch { }
            remoteWriter = remoteSocket.writable.getWriter();
            remoteReader = remoteSocket.readable.getReader();
            if (initialData.byteLength > 0) await remoteWriter.write(initialData);
            pumpRemoteToWS();
            break;
        } catch (err) {
            try { remoteWriter?.releaseLock(); } catch { }
            try { remoteReader?.releaseLock(); } catch { }
            try { remoteSocket?.close(); } catch { }
            remoteWriter = remoteReader = remoteSocket = null;
            const msg = err?.message?.toLowerCase() || '';
            const isRetryable = msg.includes('connect') || msg.includes('socket') || msg.includes('network');
            if (!isRetryable || i === attempts.length - 1) { cleanup(); return; }
        }
    }

    webSocket.addEventListener('message', async (event) => {
        if (isClosed) return;
        try {
            if (!remoteWriter) return;
            const raw = event.data;
            if (raw instanceof ArrayBuffer) {
                await remoteWriter.write(new Uint8Array(raw));
            } else {
                await remoteWriter.write(encoder.encode(raw));
            }
        } catch { cleanup(); }
    });

    webSocket.addEventListener('close', cleanup);
    webSocket.addEventListener('error', cleanup);
}

// ============== 文本协议会话 ==============

async function handleTextSession(webSocket, firstMessage) {
    let remoteSocket, remoteWriter, remoteReader;
    let isClosed = false;

    const cleanup = () => {
        if (isClosed) return;
        isClosed = true;
        try { remoteWriter?.releaseLock(); } catch { }
        try { remoteReader?.releaseLock(); } catch { }
        try { remoteSocket?.close(); } catch { }
        remoteWriter = remoteReader = remoteSocket = null;
        safeCloseWebSocket(webSocket);
    };

    const pumpRemoteToWebSocket = async () => {
        try {
            while (!isClosed && remoteReader) {
                const { done, value } = await remoteReader.read();
                if (done) break;
                if (webSocket.readyState !== WS_READY_STATE_OPEN) break;
                if (value?.byteLength > 0) webSocket.send(value);
            }
        } catch { }
        if (!isClosed) cleanup();
    };

    const parseAddress = (addr) => {
        if (addr[0] === '[') {
            const end = addr.indexOf(']');
            return { host: addr.substring(1, end), port: parseInt(addr.substring(end + 2), 10) };
        }
        const sep = addr.lastIndexOf(':');
        return { host: addr.substring(0, sep), port: parseInt(addr.substring(sep + 1), 10) };
    };

    const isCFError = (err) => {
        const msg = err?.message?.toLowerCase() || '';
        return msg.includes('connect') || msg.includes('socket') || msg.includes('network');
    };

    const connectToRemote = async (targetAddr, firstFrameData) => {
        const { host, port } = parseAddress(targetAddr);
        const attempts = [null, ...CF_FALLBACK_IPS];
        for (let i = 0; i < attempts.length; i++) {
            try {
                remoteSocket = connect({ hostname: attempts[i] || host, port });
                try { await remoteSocket.opened; } catch { }
                remoteWriter = remoteSocket.writable.getWriter();
                remoteReader = remoteSocket.readable.getReader();
                if (firstFrameData) await remoteWriter.write(encoder.encode(firstFrameData));
                webSocket.send('CONNECTED');
                pumpRemoteToWebSocket();
                return;
            } catch (err) {
                try { remoteWriter?.releaseLock(); } catch { }
                try { remoteReader?.releaseLock(); } catch { }
                try { remoteSocket?.close(); } catch { }
                remoteWriter = remoteReader = remoteSocket = null;
                if (!isCFError(err) || i === attempts.length - 1) throw err;
            }
        }
    };

    const processMessage = async (data) => {
        if (typeof data === 'string') {
            if (data.startsWith('CONNECT:')) {
                const sep = data.indexOf('|', 8);
                await connectToRemote(data.substring(8, sep), data.substring(sep + 1));
            } else if (data.startsWith('DATA:')) {
                if (remoteWriter) await remoteWriter.write(encoder.encode(data.substring(5)));
            } else if (data === 'CLOSE') {
                cleanup();
            }
        } else if (data instanceof ArrayBuffer && remoteWriter) {
            await remoteWriter.write(new Uint8Array(data));
        }
    };

    try { await processMessage(firstMessage); }
    catch (err) { try { webSocket.send('ERROR:' + err.message); } catch { } cleanup(); return; }

    webSocket.addEventListener('message', async (event) => {
        if (isClosed) return;
        try { await processMessage(event.data); }
        catch (err) { try { webSocket.send('ERROR:' + err.message); } catch { } cleanup(); }
    });

    webSocket.addEventListener('close', cleanup);
    webSocket.addEventListener('error', cleanup);
}

function safeCloseWebSocket(ws) {
    try {
        if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === WS_READY_STATE_CLOSING) {
            ws.close(1000, 'Server closed');
        }
    } catch { }
}