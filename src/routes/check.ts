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
import { fetchInternalStats } from '../lib/stats';

export async function handleGetCode(env: AppEnv, type: TemplateType) {
    try {
        const { scriptUrl } = getGithubUrls(type);
        const res = await fetchWithTimeout(scriptUrl);
        if (!res.ok) throw new Error("Fetch failed: " + res.status);
        const code = await res.text();
        return json({ success: true, code });
    } catch (e: any) { console.error('[handleGetCode]', e); return jsonError('Code fetch failed'); }
}

export async function handleCheckUpdate(env: AppEnv, type: TemplateType, mode?: string, limit = 10) {
    try {
        if (mode === 'history') {
            const { apiUrl, branch, safePath } = getGithubUrls(type);
            const headers: Record<string, string> = { "User-Agent": "Cloudflare-Worker-Manager" };
            if (env.GITHUB_TOKEN) headers["Authorization"] = 'token ' + env.GITHUB_TOKEN;
            const ghRes = await fetch(apiUrl + '?sha=' + branch + '&per_page=' + limit + '&path=' + safePath + '&t=' + Date.now(), { headers });
            if (!ghRes.ok) throw new Error('GitHub API Error: ' + ghRes.status);
            return json({ success: true, history: await ghRes.json() });
        }

        const ver = await fetchGithubVersion(env, type);
        let localCommitInfo = null;
        if (ver.localSha) {
            localCommitInfo = ver.localSha === ver.remoteSha
                ? { sha: ver.localSha, date: ver.remoteDate }
                : { sha: ver.localSha, date: ver.commitDate || ver.localTime };
        }
        return json({
            success: true,
            local: localCommitInfo,
            remote: { sha: ver.remoteSha, date: ver.remoteDate, message: ver.remoteMsg },
            mode: ver.mode
        });
    } catch (e: any) {
        console.error('[handleCheckUpdate]', e); return jsonError('Version check failed', 500);
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

        // 使用 Commits API + path 过滤 + since 日期，避免 Compare API 返回全仓库 commit
        const deployConfig = await getJSON(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
        const sinceDate = deployConfig.commitDate || deployConfig.deployTime || ver.localTime;
        
        const headers: Record<string, string> = { 'User-Agent': 'Cloudflare-Worker-Manager' };
        if (env.GITHUB_TOKEN) headers['Authorization'] = 'token ' + env.GITHUB_TOKEN;

        const { apiUrl, branch, safePath } = getGithubUrls(type);
        const sinceParam = sinceDate ? '&since=' + encodeURIComponent(sinceDate) : '';
        const commitsRes = await fetch(apiUrl + '?sha=' + branch + '&per_page=30&path=' + safePath + sinceParam, { headers });

        if (!commitsRes.ok) throw new Error('GitHub API Error: ' + commitsRes.status);

        const commitsData = await commitsRes.json();
        const allCommits = Array.isArray(commitsData) ? commitsData : [];
        const count = allCommits.length;

        return json({
            status: count > 0 ? 'diverged' : 'up-to-date',
            aheadBy: 0,
            behindBy: count,
            totalCommits: count,
            commits: allCommits.slice(0, 15).map((cm: any) => ({
                sha: cm.sha?.substring(0, 7),
                message: cm.commit?.message?.split('\n')[0],
                author: cm.commit?.author?.name,
                date: cm.commit?.author?.date
            })),
            localSha: localSha?.substring(0, 7),
            remoteSha: remoteSha?.substring(0, 7)
        });
    } catch (e: any) { console.error('[handleDiff]', e); return jsonError('Diff failed'); }
}

export async function handleStats(env: AppEnv) {
    try {
        const accounts = await readAccounts(env);
        const results = await fetchInternalStats(accounts);
        return json(results);
    } catch (e: any) { console.error('[handleStats]', e); return jsonError('Stats fetch failed'); }
}
