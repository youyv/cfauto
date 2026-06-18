/**
 * GitHub 交互 — 拉取代码、解析 SHA、模板特有转换
 */

import { TEMPLATES } from '../config/templates';

export function getGithubUrls(type: string, sha: string | null = null) {
    const t = TEMPLATES[type];
    const safePath = t.ghPath.split('/').map(p => encodeURIComponent(p)).join('/');
    const apiUrl = `https://api.github.com/repos/${t.ghUser}/${t.ghRepo}/commits`;
    const ref = sha || t.ghBranch;
    const scriptUrl = `https://raw.githubusercontent.com/${t.ghUser}/${t.ghRepo}/${ref}/${safePath}`;
    return { apiUrl, scriptUrl, branch: t.ghBranch };
}

/** 从 GitHub 拉取代码 + 解析最新 SHA */
export async function fetchGithubCode(type: string, targetSha: string | null, env: any) {
    const isLatest = !targetSha || targetSha === 'latest';
    const { scriptUrl, apiUrl } = getGithubUrls(type, isLatest ? null : targetSha);
    
    const codeRes = await fetch(scriptUrl + `?t=${Date.now()}`);
    if (!codeRes.ok) throw new Error(`代码下载失败: ${codeRes.status}`);
    const code = await codeRes.text();
    
    let sha: string | null = isLatest ? null : targetSha;
    if (isLatest) {
        const headers: Record<string, string> = { "User-Agent": "CF-Worker" };
        if (env.GITHUB_TOKEN) headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
        try {
            const apiRes = await fetch(apiUrl + `?sha=${TEMPLATES[type].ghBranch}&per_page=1`, { headers });
            if (apiRes.ok) sha = (await apiRes.json())[0].sha;
        } catch (e) { console.warn('[GitHub] SHA fetch failed:', (e as Error).message); }
    }
    
    return { code, sha };
}

/** 应用模板特有转换 */
export function applyTemplateTransform(
    type: string,
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
        result = result.replace(
            /const\s+CF_FALLBACK_IPS\s*=\s*\[.*?\];/s,
            `const CF_FALLBACK_IPS = ['${targetIP}'];`
        );
        
        const tokenVar = variables ? variables.find(v => v.key === 'TOKEN') : null;
        const tokenVal = (tokenVar && tokenVar.value && tokenVar.value.trim() && options.echTokenEnabled)
            ? tokenVar.value.trim() : '';
        result = result.replace(
            /const\s+token\s*=\s*['"]{1}.*?['"]{1};/,
            `const token = '${tokenVal}';`
        );
    }
    
    return result;
}
