/**
 * 路由: 版本检查 + 代码获取
 */

import { KV_KEYS } from '../config/templates';
import { getGithubUrls } from '../lib/github';
import { jsonError, json } from '../lib/cloudflare-api';

export async function handleGetCode(env: any, type: string) {
    try {
        const { scriptUrl } = getGithubUrls(type);
        const res = await fetch(scriptUrl);
        if (!res.ok) throw new Error("Fetch failed: " + res.status);
        const code = await res.text();
        return json({ success: true, code });
    } catch (e: any) { return jsonError(e.message); }
}

export async function handleCheckUpdate(env: any, type: string, mode?: string, limit = 10) {
    try {
        const DEPLOY_CONFIG_KEY = KV_KEYS.deployConfig(type);
        const deployConfig = JSON.parse(await env.CONFIG_KV.get(DEPLOY_CONFIG_KEY) || '{"mode":"latest"}');
        const localSha = deployConfig.currentSha;
        const localTime = deployConfig.deployTime;
        const { apiUrl, branch } = getGithubUrls(type);

        let fetchUrl = apiUrl + (mode === 'history' ? `?sha=${branch}&per_page=${limit}` : `?sha=${branch}&per_page=1`);
        const headers: Record<string, string> = { "User-Agent": "Cloudflare-Worker-Manager" };
        if (env.GITHUB_TOKEN) headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;

        const ghRes = await fetch(fetchUrl + `&t=${Date.now()}`, { headers });
        if (!ghRes.ok) throw new Error(`GitHub API Error: ${ghRes.status}`);
        const ghData = await ghRes.json();

        if (mode === 'history') return json({ history: ghData });

        const latestCommit = Array.isArray(ghData) ? ghData[0] : ghData;
        let localCommitInfo = null;
        if (localSha) {
            if (localSha === latestCommit.sha) {
                localCommitInfo = { sha: localSha, date: latestCommit.commit.committer.date };
            } else {
                localCommitInfo = { sha: localSha, date: localTime };
            }
        }

        return json({
            local: localCommitInfo,
            remote: { sha: latestCommit.sha, date: latestCommit.commit.committer.date, message: latestCommit.commit.message },
            mode: deployConfig.mode
        });
    } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
}

export async function handleStats(env: any, accountsKey: string) {
    try {
        const { fetchInternalStats } = await import('../lib/stats');
        const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
        const results = await fetchInternalStats(accounts);
        return json(results);
    } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
}
