/**
 * 路由: 版本检查 + 代码获取
 */

import { KV_KEYS } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { getGithubUrls } from '../lib/github';
import { jsonError, json, fetchWithTimeout } from '../lib/cloudflare-api';
import { getJSON, putJSON } from "../lib/kv-utils";
import { readAccounts } from "../lib/account-store";
import type { AppEnv } from "../config/env";
import { fetchGithubVersion } from '../lib/auto-update';
import { decryptKey } from '../lib/crypto-utils';
import { fetchInternalStats } from '../lib/stats';

export async function handleGetCode(env: AppEnv, type: TemplateType) {
    try {
        const { scriptUrl } = getGithubUrls(type);
        const res = await fetch(scriptUrl);
        if (!res.ok) throw new Error("Fetch failed: " + res.status);
        const code = await res.text();
        return json({ success: true, code });
    } catch (e: any) { return jsonError(e.message || 'Fetch failed'); }
}

export async function handleCheckUpdate(env: AppEnv, type: TemplateType, mode?: string, limit = 10) {
    try {
        if (mode === 'history') {
            const { apiUrl, branch } = getGithubUrls(type);
            const headers: Record<string, string> = { "User-Agent": "Cloudflare-Worker-Manager" };
            if (env.GITHUB_TOKEN) headers["Authorization"] = 'token ' + env.GITHUB_TOKEN;
            const ghRes = await fetch(apiUrl + '?sha=' + branch + '&per_page=' + limit + '&t=' + Date.now(), { headers });
            if (!ghRes.ok) throw new Error('GitHub API Error: ' + ghRes.status);
            return json({ success: true, history: await ghRes.json() });
        }

        const ver = await fetchGithubVersion(env, type);
        let localCommitInfo = null;
        if (ver.localSha) {
            localCommitInfo = ver.localSha === ver.remoteSha
                ? { sha: ver.localSha, date: ver.remoteDate }
                : { sha: ver.localSha, date: ver.localTime };
        }
        return json({
            success: true,
            local: localCommitInfo,
            remote: { sha: ver.remoteSha, date: ver.remoteDate, message: ver.remoteMsg },
            mode: ver.mode
        });
    } catch (e: any) {
        return jsonError(e.message || 'GitHub API unreachable', 500);
    }
}

export async function handleDiff(env: AppEnv, type: TemplateType) {
    try {
        const ver = await fetchGithubVersion(env, type);
        const localSha = ver.localSha;
        const remoteSha = ver.remoteSha;

        if (!localSha || localSha === remoteSha) {
            return json({
                status: localSha ? 'up-to-date' : 'no_data',
                commits: [],
                localSha: localSha?.substring(0, 7) || 'none',
                remoteSha: remoteSha?.substring(0, 7),
                message: localSha ? '已是最新版本' : '暂无部署记录'
            });
        }

        const headers: Record<string, string> = { 'User-Agent': 'Cloudflare-Worker-Manager' };
        if (env.GITHUB_TOKEN) headers['Authorization'] = 'token ' + env.GITHUB_TOKEN;

        const { repoApiBase } = getGithubUrls(type);
        const compareRes = await fetch(repoApiBase + '/compare/' + localSha + '...' + remoteSha, { headers });

        if (!compareRes.ok) {
            if (compareRes.status === 404) {
                return json({ status: 'no_compare', commits: [], localSha: localSha.substring(0, 7), remoteSha: remoteSha.substring(0, 7), message: '版本差异过大，请查看 GitHub' });
            }
            throw new Error('GitHub Compare API error: ' + compareRes.status);
        }

        const compareData = await compareRes.json();
        return json({
            status: compareData.status || 'diverged',
            aheadBy: compareData.ahead_by || 0,
            behindBy: compareData.behind_by || 0,
            totalCommits: compareData.total_commits || 0,
            commits: (compareData.commits || []).slice(0, 15).map((cm: any) => ({
                sha: cm.sha?.substring(0, 7),
                message: cm.commit?.message?.split('\n')[0],
                author: cm.commit?.author?.name,
                date: cm.commit?.author?.date
            })),
            localSha: localSha?.substring(0, 7),
            remoteSha: remoteSha?.substring(0, 7)
        });
    } catch (e: any) { return jsonError('diff failed: ' + (e.message || 'Unknown')); }
}

export async function handleStats(env: AppEnv) {
    try {
        const accounts = await readAccounts(env);
        const results = await fetchInternalStats(accounts);
        return json(results);
    } catch (e: any) { return jsonError(e.message); }
}
