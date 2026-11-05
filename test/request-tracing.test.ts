vi.mock('cloudflare:workers',()=>({DurableObject:class {constructor(public ctx:any,public env:any){}}}));
import { tracedEnv } from '../src/lib/trace';
import { prepareDeployCode, finalizeDeploy } from '../src/lib/auto-update';
import { uploadWorker } from '../src/lib/deploy-utils';
import { mockEnv, mockKV, readKV } from './helpers';
import { KV_KEYS } from '../src/config/templates';
import { describe, it, expect, vi } from 'vitest';
import { withErrorBoundary } from '../src/routes/register';
import { logger } from '../src/lib/logger';
import { jsonError, readApiJson } from '../src/lib/cloudflare-api';
import type { AppEnv } from '../src/config/env';
const env = { CONFIG_KV: {} } as AppEnv;
describe('request isolation and safe diagnostics', () => {
    it('uses unique server IDs across interleaved requests and attaches them to success and errors', async () => {
        const seen: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const route = withErrorBoundary(async (_req, scoped) => {
                const id = (scoped as any).traceContext.id;
                seen.push(id);
                await new Promise(r => setTimeout(r, seen.length === 1 ? 15 : 0));
                expect((scoped as any).traceContext.id).toBe(id);
                return new Response('ok');
            }, 'GET /test');
            const responses = await Promise.all([route(new Request('https://test/', { headers: { 'X-Request-ID': 'untrusted' } }), env), route(new Request('https://test/'), env)]);
            expect(new Set(seen).size).toBe(2);
            expect(responses.map(r => r.headers.get('X-Request-ID'))).toEqual(seen);
            expect((env as any).traceContext).toBeUndefined();
            const error = await withErrorBoundary(async () => { throw new Response('invalid', { status: 400 }); }, 'POST /test')(new Request('https://test/'), env);
            expect(error.status).toBe(400);
            expect(error.headers.get('X-Request-ID')).toMatch(/^req_[a-f0-9]{24}$/);
        } finally { log.mockRestore(); }
    });
    it('redacts structured log credentials, Secret bindings, error text and cycles without mutating inputs', () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const meta: any = { apiToken: 'short', nested: [{ type: 'secret_text', name: 'CUSTOM', text: 'hidden' }], safe: 42 };
        meta.loop = meta;
        try {
            logger.error('failed password="p"', new Error('Authorization: Bearer abc123 token="tiny"'), meta);
            const out = String(log.mock.calls[0][0]);
            for (const secret of ['short', 'hidden', 'abc123', 'tiny', 'password=\"p\"']) expect(out).not.toContain(secret);
            expect(JSON.parse(out).safe).toBe(42);
            expect(meta.apiToken).toBe('short');
        } finally { log.mockRestore(); }
    });
    it('sanitizes standard and upstream error details without altering success payloads', async () => {
        expect(await jsonError('apiToken="private"').text()).not.toContain('private');
        await expect(readApiJson(new Response(JSON.stringify({ errors: [{ message: 'token="leaked"' }] }), { status: 403 }), 'CF')).rejects.not.toThrow('leaked');
    });
});


describe('deployment trace stages', () => {
    it('keeps the same ID for source, upload and journal without persisting source or credentials', async () => {
        const env = tracedEnv(mockEnv(mockKV()), 'test-deploy');
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, result: {} }))));
        try {
            await prepareDeployCode(env, 'cmliu', 'fixed-sha', 'export default {};', [], false);
            await uploadWorker({ accountId: 'a'.repeat(32), email: '', globalKey: 'private-key' }, 'test-worker', 'export default {};', [], 'cmliu', env);
            await finalizeDeploy(env, 'cmliu', false, 'fixed-sha', [{ name: 'test-worker', success: false, msg: 'token="private-error"' }], '', 'partial', '');
            const entries = log.mock.calls.map(call => JSON.parse(String(call[0]))).filter(e => e.taskId);
            expect(entries.map(e => e.msg)).toEqual(expect.arrayContaining(['source resolution started', 'source resolved', 'upload started', 'upload completed', 'deployment completed']));
            expect(entries.every(e => e.taskId === env.traceContext?.id)).toBe(true);
            const journal = await readKV<any[]>(env.CONFIG_KV as any, KV_KEYS.DEPLOY_JOURNAL);
            expect(journal[0].taskId).toBe(env.traceContext?.id);
            expect(JSON.stringify(journal)).not.toContain('private-error');
            expect(JSON.stringify(entries)).not.toContain('private-key');
        } finally { log.mockRestore(); vi.unstubAllGlobals(); }
    });
});

describe('outer HTTP tracing', () => {
    it('attaches an ID even when middleware rejects the request and does not mutate env', async () => {
        const worker = (await import('../src/index')).default;
        const env = mockEnv(mockKV());
        const response = await worker.fetch(new Request('https://test/api/accounts'), env, {} as ExecutionContext);
        expect(response.status).toBe(401);
        expect(response.headers.get('X-Request-ID')).toMatch(/^req_[a-f0-9]{24}$/);
        expect(env.traceContext).toBeUndefined();
    });
});
