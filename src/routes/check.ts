/**
 * 路由: 版本检查 + 代码获取
 */

import { KV_KEYS } from '../config/templates';
import { getGithubUrls } from '../lib/github';
import { jsonError, json } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import type { AppEnv } from "../config/env";
import { fetchGithubVersion } from '../lib/auto-update';

export async function handleGetCode(env: AppEnv, type: string) {
    try {
        const { scriptUrl } = getGithubUrls(type);
        const res = await fetch(scriptUrl);
        if (!res.ok) throw new Error("Fetch failed: " + res.status);
        const code = await res.text();
        return json({ success: true, code });
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleCheckUpdate(env: AppEnv, type: string, mode?: string, limit = 10) {
    try {
        if (mode === 'history') {
            const { apiUrl, branch } = getGithubUrls(type);
            const headers: Record<string, string> = { "User-Agent": "Cloudflare-Worker-Manager" };
            if (env.GITHUB_TOKEN) headers["Authorization"] = 'token ' + env.GITHUB_TOKEN;
            const ghRes = await fetch(apiUrl + '?sha=' + branch + '&per_page=' + limit + '&t=' + Date.now(), { headers });
            if (!ghRes.ok) throw new Error('GitHub API Error: ' + ghRes.status);
            return json({ history: await ghRes.json() });
        }

        const ver = await fetchGithubVersion(env, type);
        let localCommitInfo = null;
        if (ver.localSha) {
            localCommitInfo = ver.localSha === ver.remoteSha
                ? { sha: ver.localSha, date: ver.remoteDate }
                : { sha: ver.localSha, date: ver.localTime };
        }
        return json({
            local: localCommitInfo,
            remote: { sha: ver.remoteSha, date: ver.remoteDate, message: ver.remoteMsg },
            mode: ver.mode
        });
    } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
}

export async function handleStats(env: AppEnv) {
    try {
        const { fetchInternalStats } = await import('../lib/stats');
        const accounts = await getJSON(env.CONFIG_KV, KV_KEYS.ACCOUNTS, []);
        const results = await fetchInternalStats(accounts);
        return json(results);
    } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
}
