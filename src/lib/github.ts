/**
 * GitHub 交互 — 拉取代码、解析 SHA、模板特有转换
 */

import { TEMPLATES } from '../config/templates';
import { fetchWithTimeout } from './cloudflare-api';
import type { TemplateType } from '../config/templates';
import type { AppEnv } from "../config/env";

export function getGithubUrls(type: TemplateType, sha: string | null = null) {
    const t = TEMPLATES[type];
    const safePath = t.ghPath.split('/').map(p => encodeURIComponent(p)).join('/');
    const apiUrl = `https://api.github.com/repos/${t.ghUser}/${t.ghRepo}/commits`;
    const ref = sha || t.ghBranch;
    const scriptUrl = `https://raw.githubusercontent.com/${t.ghUser}/${t.ghRepo}/${ref}/${safePath}`;
    const repoApiBase = `https://api.github.com/repos/${t.ghUser}/${t.ghRepo}`;
    return { apiUrl, scriptUrl, repoApiBase, branch: t.ghBranch, safePath };
}

/** 从 GitHub 拉取代码 + 解析最新 SHA */
export async function fetchGithubCode(type: TemplateType, targetSha: string | null, env: AppEnv) {
    const isLatest = !targetSha || targetSha === 'latest';
    const { scriptUrl, apiUrl, safePath } = getGithubUrls(type, isLatest ? null : targetSha);
    
    const codeRes = await fetchWithTimeout(scriptUrl + `?t=${Date.now()}`);
    if (!codeRes.ok) throw new Error(`代码下载失败: ${codeRes.status}`);
    const code = await codeRes.text();
    
    let sha: string | null = isLatest ? null : targetSha;
    if (isLatest) {
        const headers: Record<string, string> = { "User-Agent": "CF-Worker" };
        if (env.GITHUB_TOKEN) headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
        try {
            const apiRes = await fetchWithTimeout(apiUrl + `?sha=${TEMPLATES[type].ghBranch}&per_page=1&path=${safePath}`, { headers });
            if (apiRes.ok) sha = (await apiRes.json())[0].sha;
        } catch (e) { console.warn('[GitHub] SHA fetch failed:', (e as Error).message); }
    }
    
    return { code, sha };
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
        // 使用回调函数避免 targetIP 中的 $ 被 String.replace 的替换语法解析
        const escapedTargetIP = targetIP.replace(/\$/g, '$$$$');
        result = result.replace(
            /const\s+CF_FALLBACK_IPS\s*=\s*\[.*?\];/s,
            () => `const CF_FALLBACK_IPS = ['${escapedTargetIP}'];`
        );
        if (result === beforeCF) {
            console.warn('[TemplateTransform] ECH CF_FALLBACK_IPS pattern not matched — upstream code may have changed, deploy uses unmodified code');
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
            console.warn('[TemplateTransform] ECH token pattern not matched — upstream code may have changed, token not injected');
        }
    }
    
    return result;
}
