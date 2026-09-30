import { KV_KEYS, TEMPLATES } from '../config/templates';
import type { AppEnv } from '../config/env';

export interface UpstreamSelection { path: string; branch: string; }
/** Only repository-relative paths and refs; never accept arbitrary download hosts. */
export function normalizeUpstream(input: unknown): UpstreamSelection {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('需要 JSON 对象');
    const { path, branch } = input as Record<string, unknown>;
    if (typeof path !== 'string' || typeof branch !== 'string') throw new Error('文件路径和分支必须是字符串');
    const p = path.trim(), b = branch.trim();
    if (!p && !b) return { path: '', branch: '' };
    if (!p || p.length > 512 || /[\\?#%:\x00-\x1f\x7f]/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('请输入仓库内的相对文件路径，不要填写 URL 或 ../');
    if (!b || b.length > 200 || !/^[a-zA-Z0-9_./-]+$/.test(b) || b.includes('..') || b.split('/').some(s => !s || s === '.')) throw new Error('请输入有效分支或标签，如 main');
    return { path: p, branch: b };
}
export async function readUpstream(env: AppEnv, type: string): Promise<UpstreamSelection> {
    const raw = await env.CONFIG_KV.get(KV_KEYS.upstream(type));
    const saved: unknown = raw === null ? { path: '', branch: '' } : JSON.parse(raw);
    return normalizeUpstream(saved); // Corrupt/restored settings must fail closed, not silently deploy another file.
}
export async function upstreamView(env: AppEnv, type: string) {
    const t = TEMPLATES[type];
    return { ...await readUpstream(env, type), repository: t.ghUser + '/' + t.ghRepo, defaultPath: t.ghPath, defaultBranch: t.ghBranch };
}

export async function upstreamIdentity(env: AppEnv, type: string): Promise<string> {
    const selection = await readUpstream(env, type);
    return selection.path ? JSON.stringify(selection) : '';
}
