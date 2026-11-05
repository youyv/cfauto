import { TEMPLATES } from '../config/templates';
import { normalizeUpstream } from '../lib/upstream';
import { canonical, ReliabilityError, sha256 } from './protocol';

// Upstream code may exceed 2 MiB. Logical source bounds are independent of the
// unchanged 5 MiB ciphertext/packet budget; large sealed JSON is framed/compressed.
import { MAX_SOURCE_BYTES } from './payload-limits';
export { MAX_SOURCE_BYTES } from './payload-limits';
export interface SourceArtifact { template: string; repository: string; path: string; commit: string; code: string; digest: string }
/** Explicit user-supplied bytes, never disguised as an official upstream commit. */
export interface CustomSourceArtifact { kind: 'custom'; template: string; code: string; digest: string }
export type DeploymentArtifact = SourceArtifact | CustomSourceArtifact;
export function customSourceCode(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > MAX_SOURCE_BYTES || /[\uD800-\uDFFF]/u.test(value) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(value)) invalid();
}
export function artifactIdentity(artifact: DeploymentArtifact): { kind: 'custom'; digest: string } | { kind: 'upstream'; digest: string; commit: string } {
    return 'kind' in artifact ? { kind: 'custom', digest: artifact.digest } : { kind: 'upstream', digest: artifact.digest, commit: artifact.commit };
}
export interface SourceRequest { template: string; selection: unknown; ref: 'latest' | string }
export interface SourceOptions { token?: string; transport?: typeof fetch; timeoutMs?: number }
/** Legacy input may abbreviate a commit; executable artifacts still require the full SHA. */
export function isSourceReference(value: unknown): value is string {
    return typeof value === 'string' && (value === 'latest' || /^[a-f0-9]{7,40}$/i.test(value));
}
const invalid = (): never => { throw new ReliabilityError('INVALID', 400); };
const unavailable = (): never => { throw new ReliabilityError('NOT_READY', 503); };
/** Read-only planner dependency. Never uses discovery caches, branch raw URLs, redirects,
 * or an arbitrary repository/host from a caller. Resolve a full commit BEFORE download. */
export async function loadSourceArtifact(input: SourceRequest, options: SourceOptions = {}): Promise<SourceArtifact> {
    let request: SourceRequest;
    try { request = JSON.parse(canonical(input)); } catch { return invalid(); }
    if (!request || Object.keys(request).sort().join(',') !== 'ref,selection,template' || !Object.hasOwn(TEMPLATES, request.template)) invalid();
    if (!isSourceReference(request.ref)) invalid();
    let selection: { path: string; branch: string };
    try { selection = normalizeUpstream(request.selection); } catch { return invalid(); }
    const template = TEMPLATES[request.template];
    const selectedPath = selection.path || template.ghPath, branch = selection.branch || template.ghBranch;
    const repository = template.ghUser + '/' + template.ghRepo;
    const transport = options.transport ?? fetch, token = options.token;
    const timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) invalid();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ReliabilityError('NOT_READY', 503)); }, timeoutMs); });
    async function text(url: string, limit: number, authenticated: boolean): Promise<string> {
        const headers: Record<string, string> = { 'User-Agent': 'Cloudflare-Worker-Manager', Accept: authenticated ? 'application/vnd.github+json' : 'text/plain' };
        if (authenticated && token) headers.Authorization = 'Bearer ' + token;
        const response = await Promise.race([transport(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal }), deadline]);
        if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > limit) { void response.body?.cancel().catch(() => {}); return unavailable(); }
        const reader = response.body?.getReader(); if (!reader) return unavailable();
        const chunks: Uint8Array[] = []; let bytes = 0;
        try {
            while (true) {
                const item = await Promise.race([reader.read(), deadline]); if (item.done) break;
                bytes += item.value.length; if (bytes > limit) return unavailable(); chunks.push(item.value);
            }
            const buffer = new Uint8Array(bytes); let offset = 0;
            for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
            return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
        } finally { void reader.cancel().catch(() => {}); }
    }
    try {
        const ref = request.ref === 'latest' ? branch : request.ref.toLowerCase();
        const resolved = JSON.parse(await text('https://api.github.com/repos/' + repository + '/commits/' + encodeURIComponent(ref), 65536, true));
        if (!resolved || typeof resolved.sha !== 'string' || !/^[a-f0-9]{40}$/.test(resolved.sha) || (request.ref !== 'latest' && !resolved.sha.startsWith(ref))) return unavailable();
        const commit = resolved.sha as string;
        const code = await text('https://raw.githubusercontent.com/' + repository + '/' + commit + '/' + selectedPath.split('/').map(encodeURIComponent).join('/'), MAX_SOURCE_BYTES, false);
        if (!code.trim() || /^\s*(?:<!doctype\s+html|<html\b)/i.test(code)) return unavailable();
        return { template: request.template, repository, path: selectedPath, commit, code, digest: await sha256(code) };
    } catch { return unavailable(); }
    finally { clearTimeout(timer!); controller.abort(); }
}
