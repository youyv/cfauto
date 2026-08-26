/**
 * 路由: 版本检查 + 代码获取
 */

import { KV_KEYS } from '../config/templates';
import type { TemplateType } from '../config/templates';
import { getGithubUrls, fetchGithubCommits } from '../lib/github';
import { jsonError, json, fetchWithTimeout } from '../lib/cloudflare-api';
import { getJSON } from "../lib/kv-utils";
import { readAccounts } from "../lib/account-store";
import { requireTemplateType } from '../lib/validate';
import type { DeployConfig } from '../lib/types';
import type { AppEnv } from "../config/env";
import { fetchGithubVersion } from '../lib/auto-update';
import { logger } from '../lib/logger';
import { fetchInternalStats } from '../lib/stats';

/** history 模式的 per_page 上限（GitHub API 最大 100） */
const MAX_HISTORY_LIMIT = 100;

export async function handleGetCode(env: AppEnv, type: TemplateType) {
    const templateErr = requireTemplateType(type); if (templateErr) return templateErr;
    try {
        const { scriptUrl } = getGithubUrls(type);
        const res = await fetchWithTimeout(scriptUrl);
        if (!res.ok) throw new Error("上游返回 HTTP " + res.status);
        const code = await res.text();
        return json({ success: true, code });
    } catch (e: any) {
        logger.error('handleGetCode failed', e instanceof Error ? e : new Error(String(e)), { module: 'check' });
        return jsonError('源码拉取失败: ' + (e?.message || 'unknown'), 502, 'GITHUB_API_ERROR');
    }
}

export async function handleCheckUpdate(env: AppEnv, type: TemplateType, mode?: string, limit = 10) {
    const templateErr = requireTemplateType(type); if (templateErr) return templateErr;
    try {
        if (mode === 'history') {
            const perPage = Math.min(Math.max(1, Number.isFinite(limit) ? limit : 10), MAX_HISTORY_LIMIT);
            const ghData = await fetchGithubCommits(type, env, { perPage, cacheBust: true });
            return json({ success: true, history: ghData });
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
            mode: ver.mode,
            // 上一轮部分失败的目标：前端据此提示「N 个 Worker 仍落后」，而非误显示「已是最新」
            pending: ver.pendingTargets || [],
            lastAttempt: ver.lastAttempt || null
        });
    } catch (e: any) {
        logger.error('handleCheckUpdate failed', e instanceof Error ? e : new Error(String(e)), { module: 'check' });
        return jsonError('版本检查失败: ' + (e?.message || 'unknown'), 502, 'GITHUB_API_ERROR');
    }
}

export async function handleDiff(env: AppEnv, type: TemplateType) {
    const templateErr = requireTemplateType(type); if (templateErr) return templateErr;
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
                pending: ver.pendingTargets || [],
                message: localSha
                    ? ((ver.pendingTargets || []).length > 0
                        ? '版本号已是最新，但有 ' + ver.pendingTargets!.length + ' 个目标上一轮部署失败，仍在重试'
                        : '已是最新版本')
                    : '暂无部署记录'
            });
        }

        // 使用 Commits API + path 过滤 + since 日期，避免 Compare API 返回全仓库 commit
        const deployConfig = await getJSON<DeployConfig>(env.CONFIG_KV, KV_KEYS.deployConfig(type), { mode: 'latest' });
        const sinceDate = deployConfig.commitDate || deployConfig.deployTime || ver.localTime || undefined;
        const commitsData = await fetchGithubCommits(type, env, { perPage: 30, since: sinceDate });
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
            remoteSha: remoteSha?.substring(0, 7),
            pending: ver.pendingTargets || []
        });
    } catch (e: any) {
        logger.error('handleDiff failed', e instanceof Error ? e : new Error(String(e)), { module: 'check' });
        return jsonError('差异对比失败: ' + (e?.message || 'unknown'), 502, 'GITHUB_API_ERROR');
    }
}

export async function handleStats(env: AppEnv) {
    try {
        const accounts = await readAccounts(env);
        const results = await fetchInternalStats(accounts);
        return json(results);
    } catch (e: any) { logger.error('handleStats failed', e instanceof Error ? e : new Error(String(e)), { module: 'check' }); return jsonError('用量查询失败: ' + (e?.message || 'unknown')); }
}
