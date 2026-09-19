/**
 * GitHub 交互 — 拉取代码、解析 SHA、模板特有转换
 */

import { TEMPLATES, KV_KEYS } from '../config/templates';
import { fetchWithTimeout } from './cloudflare-api';
import { logger } from './logger';
import type { TemplateType } from '../config/templates';
import type { GithubCommit } from './types';
import type { AppEnv } from "../config/env";

export interface GithubTarget { branch: string; path: string; }

/**
 * 探测结果缓存时长。
 *
 * 上游改名是低频事件，而这个缓存每失效一次就要多打 2 个 GitHub API 请求（仓库信息 + 文件树）；
 * 未配置 GITHUB_TOKEN 时限额只有 60/小时，15 分钟一轮 × 3 个模板就吃掉近一半配额。
 * 因此放长到 6 小时，并由 fetchGithubCode 的 404 失效重探来兜住「缓存过期后上游改名」的窗口。
 */
export const GH_INFO_CACHE_TTL_SECONDS = 6 * 60 * 60;

const GH_API = 'https://api.github.com';

/** 解析探测响应体；失败返回 null，调用方据此回落到配置值（verify.js 要求 json() 有局部兜底） */
async function readJsonOrNull<T>(res: Response): Promise<T | null> {
    try { return await res.json() as T; }
    catch (e) { logger.warn('resolveGithubTarget: 响应体解析失败', { status: res.status, error: (e as Error).message }); return null; }
}

/**
 * 从仓库文件清单里挑出目标脚本路径。
 *
 * 优先级：配置路径本身 → 以 `filePattern` 结尾 → 包含 `filePattern`。
 * 纯函数，导出供测试覆盖。
 */
export function pickScriptPath(type: TemplateType, paths: string[]): string | null {
    const t = TEMPLATES[type];
    if (!Array.isArray(paths) || paths.length === 0) return null;
    if (paths.includes(t.ghPath)) return t.ghPath;
    const pattern = t.filePattern || t.ghPath;
    const endsWith = paths.filter(p => p.endsWith(pattern));
    if (endsWith.length > 0) return endsWith[0];
    const contains = paths.filter(p => p.includes(pattern));
    if (contains.length > 0) return contains[0];
    return null;
}

/**
 * 解析某模板当前可用的「默认分支 + 脚本路径」。
 *
 * 上游可能改默认分支（main ↔ master）或重命名脚本文件，硬编码任一者都会让拉取静默
 * 拿到 404 HTML 页面并当作代码上传。这里先读缓存（TTL 见 GH_INFO_CACHE_TTL_SECONDS），
 * 未命中再用 GitHub API 探测并回写；**任何一步失败都回落到配置值**，绝不因为探测本身失败而中断部署。
 */
export async function resolveGithubTarget(env: AppEnv, type: TemplateType): Promise<GithubTarget> {
    const t = TEMPLATES[type];
    const fallback: GithubTarget = { branch: t.ghBranch || 'main', path: t.ghPath };
    if (!env || !env.CONFIG_KV) return fallback;

    const cacheKey = KV_KEYS.ghInfoCache(type);
    try {
        const cachedRaw = await env.CONFIG_KV.get(cacheKey);
        if (cachedRaw) {
            const cached = JSON.parse(cachedRaw) as Partial<GithubTarget>;
            if (cached && typeof cached.branch === 'string' && typeof cached.path === 'string') {
                return { branch: cached.branch, path: cached.path };
            }
        }
    } catch (e) {
        logger.warn('resolveGithubTarget: 缓存读取失败，改为现场探测', { type, error: (e as Error).message });
    }

    const headers: Record<string, string> = { 'User-Agent': 'Cloudflare-Worker-Manager' };
    if (env.GITHUB_TOKEN) headers['Authorization'] = 'token ' + env.GITHUB_TOKEN;

    let branch = fallback.branch;
    let path = fallback.path;
    try {
        const repoRes = await fetchWithTimeout(`${GH_API}/repos/${t.ghUser}/${t.ghRepo}`, { headers });
        if (repoRes.ok) {
            const repoData = await readJsonOrNull<{ default_branch?: string }>(repoRes);
            if (repoData && typeof repoData.default_branch === 'string' && repoData.default_branch) {
                branch = repoData.default_branch;
            }
        }
        const treeRes = await fetchWithTimeout(
            `${GH_API}/repos/${t.ghUser}/${t.ghRepo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
            { headers }
        );
        if (treeRes.ok) {
            const treeData = await readJsonOrNull<{ tree?: Array<{ type?: string; path?: string }> }>(treeRes);
            // 文件树解析不出来（或上游返回空树）时保留配置路径
            if (treeData) {
                const paths = (treeData.tree || [])
                    .filter(x => x && x.type === 'blob' && typeof x.path === 'string')
                    .map(x => x.path as string);
                const matched = pickScriptPath(type, paths);
                if (matched) path = matched;
            }
        }
        await env.CONFIG_KV.put(cacheKey, JSON.stringify({ branch, path }), { expirationTtl: GH_INFO_CACHE_TTL_SECONDS });
        if (path !== t.ghPath || branch !== t.ghBranch) {
            logger.audit('github target resolved', { type, branch, path, configured: { branch: t.ghBranch, path: t.ghPath } });
        }
    } catch (e) {
        logger.warn('resolveGithubTarget: 探测失败，回落到配置值', { type, error: (e as Error).message });
    }
    return { branch, path };
}

/**
 * 丢弃探测缓存，使下一次 resolveGithubTarget 重新探测。
 *
 * 用于「缓存里的路径已过期 → 拉取拿到 404」这一情形：长 TTL 降低了 API 压力，
 * 但也意味着改名后可能用到过期路径，这里给一次主动失效的机会。
 */
export async function invalidateGithubTarget(env: AppEnv, type: TemplateType): Promise<void> {
    if (!env || !env.CONFIG_KV) return;
    try {
        await env.CONFIG_KV.delete(KV_KEYS.ghInfoCache(type));
        logger.audit('github target cache invalidated', { type });
    } catch (e) {
        logger.warn('invalidateGithubTarget failed', { type, error: (e as Error).message });
    }
}

export function getGithubUrls(type: TemplateType, sha: string | null = null, override?: GithubTarget) {
    const t = TEMPLATES[type];
    const rawPath = override?.path || t.ghPath;
    const branch = override?.branch || t.ghBranch;
    const safePath = rawPath.split('/').map(p => encodeURIComponent(p)).join('/');
    const apiUrl = `${GH_API}/repos/${t.ghUser}/${t.ghRepo}/commits`;
    const ref = sha || branch;
    const scriptUrl = `https://raw.githubusercontent.com/${t.ghUser}/${t.ghRepo}/${ref}/${safePath}`;
    const repoApiBase = `${GH_API}/repos/${t.ghUser}/${t.ghRepo}`;
    return { apiUrl, scriptUrl, repoApiBase, branch, safePath, rawPath };
}

/** 从 GitHub 拉取代码 + 解析最新 SHA */
export async function fetchGithubCode(type: TemplateType, targetSha: string | null, env: AppEnv) {
    const isLatest = !targetSha || targetSha === 'latest';
    // 动态解析当前默认分支与脚本路径（带缓存与回落），避免上游改名后拉到 404 页面
    let target = await resolveGithubTarget(env, type);
    const urlFor = (tg: GithubTarget) => getGithubUrls(type, isLatest ? null : targetSha, tg).scriptUrl;

    let codeRes = await fetchWithTimeout(urlFor(target) + `?t=${Date.now()}`);
    // 缓存里的路径可能已过期（上游改名）：丢掉缓存重探一次再试一回。
    // 只对 404 触发、且只重试一次，避免把额外的 GitHub 调用变成常态。
    if (codeRes.status === 404) {
        logger.warn('fetchGithubCode: 404，丢弃探测缓存后重探', { type, path: target.path });
        await invalidateGithubTarget(env, type);
        target = await resolveGithubTarget(env, type);
        codeRes = await fetchWithTimeout(urlFor(target) + `?t=${Date.now()}`);
    }
    if (!codeRes.ok) throw new Error(`代码下载失败: ${codeRes.status}`);
    const code = await codeRes.text();
    
    let sha: string | null = isLatest ? null : targetSha;
    if (isLatest) {
        try {
            const commits = await fetchGithubCommits(type, env, { perPage: 1 });
            if (commits.length > 0) sha = commits[0].sha;
        } catch (e) { logger.warn('SHA fetch failed', { error: (e as Error).message, module: 'github' }); }
    }
    
    return { code, sha };
}

/** 查询文件的提交历史 — 封装 URL 拼接 + 认证头，消除多处重复 */
export async function fetchGithubCommits(
    type: TemplateType, env: AppEnv,
    opts: { perPage?: number; since?: string; cacheBust?: boolean } = {}
): Promise<GithubCommit[]> {
    const target = await resolveGithubTarget(env, type);
    const { apiUrl, branch, rawPath } = getGithubUrls(type, null, target);
    const headers: Record<string, string> = { 'User-Agent': 'Cloudflare-Worker-Manager' };
    if (env.GITHUB_TOKEN) headers['Authorization'] = 'token ' + env.GITHUB_TOKEN;

    const params = new URLSearchParams();
    params.set('sha', branch);
    params.set('per_page', String(opts.perPage || 10));
    params.set('path', rawPath);
    if (opts.since) params.set('since', opts.since);
    if (opts.cacheBust) params.set('t', String(Date.now()));

    const res = await fetchWithTimeout(`${apiUrl}?${params.toString()}`, { headers });
    if (!res.ok) throw new Error('GitHub API Error: ' + res.status);
    return res.json();
}

/** 应用模板特有转换 */
export function applyTemplateTransform(
    type: TemplateType,
    code: string,
    variables: Array<{ key: string; value: string }> | null,
    options: { echTokenEnabled?: boolean } = {}
) {
    let result = code;
    
    if (type === 'joey') {
        result = 'var window = globalThis;\n' + result;
    }
    
    if (type === 'ech') {
        const proxyVar = variables ? variables.find(v => v.key === 'PROXYIP') : null;
        const targetIP = (proxyVar && proxyVar.value) ? proxyVar.value.trim() : 'ProxyIP.CMLiussss.net';
        const beforeCF = result;
        // 回调函数返回值不会被 String.replace 解析 $ 特殊符号，需转义的是单引号和反斜杠
        const escapedTargetIP = targetIP.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        result = result.replace(
            /const\s+CF_FALLBACK_IPS\s*=\s*\[.*?\];/s,
            () => `const CF_FALLBACK_IPS = ['${escapedTargetIP}'];`
        );
        if (result === beforeCF) {
            logger.warn('ECH CF_FALLBACK_IPS pattern not matched — upstream code may have changed, deploy uses unmodified code', { module: 'github' });
        }
        
        const tokenVar = variables ? variables.find(v => v.key === 'TOKEN') : null;
        const tokenVal = (tokenVar && tokenVar.value && tokenVar.value.trim() && options.echTokenEnabled)
            ? tokenVar.value.trim() : '';
        const beforeToken = result;
        const escapedTokenVal = tokenVal.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        result = result.replace(
            /const\s+token\s*=\s*['"]{1}.*?['"]{1};/,
            () => `const token = '${escapedTokenVal}';`
        );
        if (result === beforeToken) {
            logger.warn('ECH token pattern not matched — upstream code may have changed, token not injected', { module: 'github' });
        }
    }
    
    return result;
}
