import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionJournal } from '../../src/reliability/execution-journal';
import { SealedStore } from '../../src/reliability/sealed-store';
import { sqliteFixture } from './sqlite-fixture';
const open: ReturnType<typeof sqliteFixture>[] = [];
const identity = { job: 'job1', account: 'account1', generation: 'gen1' };
const ring = { currentId: 'key1', keys: { key1: 'test-secret-material-at-least-32-bytes' } };
const url = 'https://api.cloudflare.com/client/v4/accounts/account1/workers/scripts/test';
function fixture(account = identity.account) {
    const f = sqliteFixture(); open.push(f); const sealed = new SealedStore(f.db, ring);
    const transport = vi.fn(async () => Response.json({ success: true, result: { id: 'remote-created' } }));
    const authorizeMutation = vi.fn(async () => {});
    const options = { digestSecret: ring.keys.key1, transport, authorizeMutation };
    const make = () => new ExecutionJournal(f.db, sealed, {...identity,account}, options);
    return { ...f, sealed, transport, authorizeMutation, make };
}
afterEach(() => { for (const f of open.splice(0)) f.sql.close(); });
describe('durable HTTP execution journal', () => {
    it.each([200,204])('replays a documented empty Worker DELETE %i without repeating HTTP',async status=>{
        const f=fixture('a'.repeat(32)),target='https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/demo';f.transport.mockResolvedValueOnce(new Response(null,{status}));
        const first=f.make();const response=await first.request(target,{method:'DELETE'});expect(response.status).toBe(status);expect(await response.text()).toBe('');await first.finish();
        const restart=f.make();expect((await restart.request(target,{method:'DELETE'})).status).toBe(status);await restart.finish();expect(f.transport).toHaveBeenCalledTimes(1);expect(f.authorizeMutation).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/demo','DELETE',202,''],
        ['https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/demo','DELETE',200,' '],
        ['https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/demo','PUT',200,''],
        ['https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/subdomain','DELETE',200,''],
        ['https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/storage/kv/namespaces/'+'b'.repeat(32),'DELETE',200,''],
        ['https://hooks.example.test/test','POST',200,''],
        ['https://other.test/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/demo','DELETE',200,''],
        ['https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/workers/scripts/demo?force=true','DELETE',200,''],
    ])('does not generalize empty success for %s %s %i',async(target,method,status,body)=>{
        const f=fixture('a'.repeat(32));f.transport.mockResolvedValueOnce(new Response(body,{status}));await expect(f.make().request(target,{method})).rejects.toThrow('EXECUTION_NEEDS_REVIEW');await expect(f.make().request(target,{method})).rejects.toThrow('EXECUTION_NEEDS_REVIEW');expect(f.transport).toHaveBeenCalledTimes(target.startsWith('https://api.cloudflare.com/')?1:0);
    });
    it('replays successful writes and reads from encrypted receipts after reconstruction', async () => {
        const { make, transport, sql } = fixture(); const journal = make();
        expect((await (await journal.request(url, { method: 'PUT', body: 'secret' })).json() as any).success).toBe(true);
        await journal.request(url); await journal.finish();
        const restarted = make(); await restarted.request(url, { method: 'PUT', body: 'secret' }); await restarted.request(url); await restarted.finish();
        expect(transport).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(sql.prepare('SELECT * FROM execution_calls').all())).not.toContain('secret');
    });
    it('response loss marks a write unknown and even a handler catch cannot release it', async () => {
        const { make, transport } = fixture(); transport.mockRejectedValueOnce(new Error('private auth value'));
        const journal = make(); await expect(journal.request(url, { method: 'DELETE' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        await expect(journal.request(url, { method: 'PUT' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        await expect(journal.finish()).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        await expect(make().request(url, { method: 'DELETE' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('recovers the response-durable/state-not-committed crash window without repeating a write', async () => {
        const { make, sql, transport } = fixture(); await make().request(url, { method: 'DELETE' });
        sql.prepare("UPDATE execution_calls SET state='in_flight'").run();
        const restarted = make(); expect((await restarted.request(url, { method: 'DELETE' })).ok).toBe(true); await restarted.finish();
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('does not replay a changed request, credentials, body or target', async () => {
        for (const change of [{ body: 'different' }, { headers: { Authorization: 'changed' } }, { method: 'POST' }]) {
            const { make, transport } = fixture(); await make().request(url, { method: 'PUT', body: 'original' });
            await expect(make().request(url, { method: 'PUT', body: 'original', ...change })).rejects.toThrow('EXECUTION_NEEDS_REVIEW'); expect(transport).toHaveBeenCalledTimes(1);
        }
    });
    it('uses stable multipart fingerprints rather than random multipart boundaries', async () => {
        const { make, transport } = fixture();
        const form = () => { const f = new FormData(); f.append('metadata', '{}'); f.append('script', new Blob(['export default {};'], { type: 'application/javascript' }), 'worker.js'); return f; };
        await make().request(url, { method: 'PUT', body: form() }); await make().request(url, { method: 'PUT', body: form() }); expect(transport).toHaveBeenCalledTimes(1);
    });
    it('freezes request bodies and headers before asynchronous hashing', async () => {
        const { make, transport } = fixture(); const headers = new Headers({ Authorization: 'original' }); const form = new FormData(); form.append('name', 'original');
        const pending = make().request(url, { method: 'PUT', headers, body: form }); headers.set('Authorization', 'changed'); form.set('name', 'changed'); await pending;
        const init = (transport.mock.calls as any)[0][1]; expect(init.headers.get('Authorization')).toBe('original'); expect(init.body.get('name')).toBe('original'); expect(init.redirect).toBe('manual');
    });
    it('refuses cross-account writes and verifies authorization before transport', async () => {
        const { make, transport, authorizeMutation } = fixture();
        await expect(make().request(url.replace('account1', 'other'), { method: 'DELETE' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW'); expect(transport).not.toHaveBeenCalled();
        authorizeMutation.mockRejectedValueOnce(new Error('revoked'));
        await expect(make().request(url, { method: 'PUT' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW'); expect(transport).not.toHaveBeenCalled();
    });
    it('never treats gateway failures or malformed success responses as confirmed outcomes', async () => {
        for (const response of [new Response('bad gateway', { status: 502 }), new Response('timeout', { status: 408 }), new Response('not-json'), Response.json({ result: {} })]) {
            const { make, transport } = fixture(); transport.mockResolvedValueOnce(response);
            await expect(make().request(url, { method: 'PUT' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
            await expect(make().request(url, { method: 'PUT' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW'); expect(transport).toHaveBeenCalledTimes(1);
        }
    });
    it('preserves a confirmed rejection for the handler without repeating it on replay', async () => {
        const { make, transport } = fixture(); transport.mockResolvedValueOnce(Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 403 }));
        expect((await make().request(url, { method: 'PUT' })).status).toBe(403);
        expect((await make().request(url, { method: 'PUT' })).status).toBe(403); expect(transport).toHaveBeenCalledTimes(1);
    });
    it('replays failed reads deterministically and only retries genuinely interrupted reads', async () => {
        const { make, transport, sql } = fixture(); transport.mockRejectedValueOnce(new Error('network'));
        await expect(make().request(url)).rejects.toThrow('EXECUTION_READ_FAILED'); await expect(make().request(url)).rejects.toThrow('EXECUTION_READ_FAILED'); expect(transport).toHaveBeenCalledTimes(1);
        sql.prepare("UPDATE execution_calls SET state='in_flight'").run();
        const restarted = make(); await restarted.request(url); await restarted.finish(); expect(transport).toHaveBeenCalledTimes(2);
    });
    it('detects early-return replay drift and corrupted receipts instead of claiming completion', async () => {
        const { make, sql, transport } = fixture(); const first = make(); await first.request(url); await first.request(url + '/bindings'); await first.finish();
        const short = make(); await short.request(url); await expect(short.finish()).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        sql.prepare("UPDATE sealed_chunks SET ciphertext='AAAA'").run(); await expect(make().request(url)).rejects.toThrow('EXECUTION_NEEDS_REVIEW'); expect(transport).toHaveBeenCalledTimes(2);
    });
    it('serializes concurrent calls and does not issue a second write after the first becomes unknown', async () => {
        const { make, transport } = fixture(); transport.mockRejectedValueOnce(new Error('lost'));
        const journal = make(); const result = await Promise.allSettled([journal.request(url, { method: 'PUT' }), journal.request(url, { method: 'DELETE' })]);
        expect(result.every(r => r.status === 'rejected')).toBe(true); expect(transport).toHaveBeenCalledTimes(1);
    });
    it('bounds a stalled response body even when cancellation never resolves', async () => {
        const { make, transport } = fixture();
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        transport.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
        const journal = make();
        await expect(journal.request(url, { method: 'PUT' }, 20)).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        await expect(journal.finish()).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        await expect(make().request(url, { method: 'PUT' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        expect(cancel).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
    });
    it('bounds a transport that ignores its timeout and never returns headers', async () => {
        const { make, transport } = fixture();
        transport.mockImplementationOnce(() => new Promise<Response>(() => {}));
        const journal = make();
        await expect(journal.request(url, { method: 'DELETE' }, 20)).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        await expect(make().request(url, { method: 'DELETE' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        expect((transport.mock.calls as any)[0][1].signal.aborted).toBe(true);
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('rejects invalid timeout budgets without issuing external calls', async () => {
        for (const timeout of [0, -1, Infinity, NaN, 120001]) {
            const { make, transport } = fixture(); const journal = make();
            await expect(journal.request(url, { method: 'PUT' }, timeout)).rejects.toThrow('INVALID');
            await expect(journal.finish()).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
            expect(transport).not.toHaveBeenCalled();
        }
    });

    it('retains authenticated original request evidence for unknown calls without rerunning them', async () => {
        const f = fixture(); f.transport.mockRejectedValueOnce(new Error('lost'));
        const j = f.make();
        await expect(j.request(url, { method: 'PUT', headers: { Authorization: 'private-token' }, body: 'private-body' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        const before = f.db.rows('SELECT * FROM execution_calls');
        const evidence = await f.make().readCallEvidence(0);
        expect(evidence).toMatchObject({ identity, ordinal: 0, mutation: true, state: 'unknown' });
        expect(evidence.request).toEqual([url, 'PUT', [['authorization', 'private-token']], ['text', 'private-body']]);
        expect(f.db.rows('SELECT * FROM execution_calls')).toEqual(before);
        expect(f.transport).toHaveBeenCalledTimes(1);
        const rows = JSON.stringify(f.db.rows('SELECT * FROM sealed_chunks')) + JSON.stringify(before);
        expect(rows).not.toContain('private-token'); expect(rows).not.toContain('private-body');
        await expect(new ExecutionJournal(f.db, f.sealed, { ...identity, generation: 'other' }, { digestSecret: ring.keys.key1, transport: f.transport, authorizeMutation: f.authorizeMutation }).readCallEvidence(0)).rejects.toThrow();
    });
    it('does not send when original request evidence cannot be sealed, and rechecks authorization after sealing', async () => {
        const f = fixture(); const original = f.sealed.put.bind(f.sealed);
        vi.spyOn(f.sealed, 'put').mockImplementationOnce(async () => { throw new Error('storage'); });
        await expect(f.make().request(url, { method: 'PUT' })).rejects.toThrow();
        expect(f.transport).not.toHaveBeenCalled(); expect(f.db.rows('SELECT * FROM execution_calls')).toEqual([]);
        vi.spyOn(f.sealed, 'put').mockImplementation(async (...args) => {
            const result = await original(...args);
            f.authorizeMutation.mockRejectedValue(new Error('revoked during crypto'));
            return result;
        });
        await expect(f.make().request(url, { method: 'PUT' })).rejects.toThrow('EXECUTION_NEEDS_REVIEW');
        expect(f.transport).not.toHaveBeenCalled(); expect(f.db.rows('SELECT * FROM execution_calls')).toEqual([]);
    });
    it('refuses missing historical, tampered and stale request evidence without changing calls', async () => {
        const f = fixture(); f.transport.mockRejectedValueOnce(new Error('lost'));
        await expect(f.make().request(url, { method: 'DELETE' })).rejects.toThrow();
        f.sql.prepare("UPDATE execution_calls SET digest=?").run('0'.repeat(64));
        const before = f.db.rows('SELECT * FROM execution_calls');
        await expect(f.make().readCallEvidence(0)).rejects.toThrow(/^CONFLICT$/);
        expect(f.db.rows('SELECT * FROM execution_calls')).toEqual(before);
        const g = fixture(); g.make(); g.db.rows("INSERT INTO execution_calls VALUES ('job1',0,?,1,'unknown')", 'a'.repeat(64));
        await expect(g.make().readCallEvidence(0)).rejects.toThrow(/^NOT_READY$/);
        expect(g.transport).not.toHaveBeenCalled();
        for (const ordinal of [-1, 1.5, 500, NaN]) await expect(f.make().readCallEvidence(ordinal)).rejects.toThrow(/^INVALID$/);
    });

});
