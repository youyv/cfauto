import { describe, expect, it, afterEach, vi } from 'vitest';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME, accountObjectName, readRpcRequest, type RpcMethod } from '../../src/reliability/coordinator-rpc';
import { CoordinatorEndpoint } from '../../src/reliability/coordinator-endpoint';
import { sqliteFixture } from './sqlite-fixture';
const secret = 'test-only-rpc-key-not-a-real-secret-32';
const open: ReturnType<typeof sqliteFixture>[] = [];
afterEach(() => { for (const f of open.splice(0)) f.sql.close(); vi.restoreAllMocks(); });
describe('coordinator binding authentication', () => {
    it.each(['deliver', 'authorize', 'snapshot', 'complete'] as RpcMethod[])('authenticates direction, account and physical target for %s', async method => {
        const rpc = new CoordinatorRpc(secret, () => 1000), signed = await rpc.sign(method, 'a1', { task: 't1' });
        const target = method === 'deliver' ? accountObjectName('a1') : GLOBAL_OBJECT_NAME;
        expect((await rpc.verify(signed, name => name === target)).role).toEqual(method === 'deliver' ? { role: 'account', account: 'a1' } : { role: 'global' });
        await expect(rpc.verify(signed, () => false)).rejects.toThrow(/^INVALID$/);
    });
    it.each([{ account: 'a2' }, { method: 'snapshot' }, { direction: 'account-global' }, { body: { task: 'stolen' } }, { nonce: 'changed' }, { at: 1001 }, { signature: '0'.repeat(64) }, { extra: true }, { version: 2 }])('rejects modified signed messages %j', async patch => {
        const rpc = new CoordinatorRpc(secret, () => 1000), signed = await rpc.sign('deliver', 'a1', {});
        await expect(rpc.verify({ ...signed, ...patch }, () => true)).rejects.toThrow(/^INVALID$/);
    });
    it('rejects a wrong secret without exposing any body or key', async () => {
        const signed = await new CoordinatorRpc(secret).sign('authorize', 'a1', { token: 'mock-sensitive' });
        await expect(new CoordinatorRpc('different-test-only-secret-32bytes').verify(signed, () => true)).rejects.toThrow(/^INVALID$/);
        expect(() => new CoordinatorRpc('short')).toThrow(/^INVALID$/);
    });
    it('checks past/future skew and time after async signature verification', async () => {
        let now = 1000; const rpc = new CoordinatorRpc(secret, () => now), signed = await rpc.sign('deliver', 'a1', {});
        for (const clock of [-60000, 61001]) { now = clock; await expect(rpc.verify(signed, () => true)).rejects.toThrow(/^INVALID$/); }
        now = 1000; const pending = rpc.verify(signed, () => true); now = 61001;
        await expect(pending).rejects.toThrow(/^INVALID$/);
    });
    it('freezes caller data before sign and verify awaits', async () => {
        const rpc = new CoordinatorRpc(secret), body = { value: ['original'] }; const pending = rpc.sign('deliver', 'a1', body); body.value[0] = 'changed';
        const signed = await pending; expect(signed.body).toEqual({ value: ['original'] });
        const verification = rpc.verify(signed, () => true); (signed.body as any).value[0] = 'after';
        expect((await verification).message.body).toEqual({ value: ['original'] });
    });
    it('allows identical authenticated retry but leaves durable deduplication to the receiver', async () => {
        const rpc = new CoordinatorRpc(secret), signed = await rpc.sign('deliver', 'a1', {});
        expect(await rpc.verify(signed, () => true)).toEqual(await rpc.verify(signed, () => true));
    });
    it('enforces an exact private transport route and a streaming size limit', async () => {
        const rpc = new CoordinatorRpc(secret);
        expect(await readRpcRequest(await rpc.request('deliver', 'a1', {}))).toHaveProperty('method', 'deliver');
        for (const request of [new Request('https://public.example/v1', { method: 'POST', body: '{}' }), new Request('https://coordinator.internal/v1?q=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), new Request('https://coordinator.internal/v1'), new Request('https://coordinator.internal/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), new Request('https://coordinator.internal/v1', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' }, body: 'a'.repeat(131073) })]) await expect(readRpcRequest(request)).rejects.toThrow(/^INVALID$/);
    });
    it('rejects non-submit raw bytes over 128KiB even when canonical JSON is small', async () => {
        const rpc = new CoordinatorRpc(secret);
        for (const method of ['deliver', 'inspect_task', 'progress'] as RpcMethod[]) {
            const signed = JSON.stringify(await rpc.sign(method, 'a1', {}));
            const request = (size: number) => new Request('https://coordinator.internal/v1', {
                method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1' },
                body: signed + ' '.repeat(size - signed.length)
            });
            expect(await readRpcRequest(request(131072))).toHaveProperty('method', method);
            await expect(readRpcRequest(request(131073))).rejects.toThrow(/^INVALID$/);
        }
    });
    it('does not create business stores before authentication and pins a role across reconstruction', async () => {
        const f = sqliteFixture(); open.push(f); const rpc = new CoordinatorRpc(secret), create = vi.fn(() => ({ handle: async () => ({ ok: true }), tick: async () => {} }));
        const endpoint = new CoordinatorEndpoint(f.db, rpc, name => name === accountObjectName('a1'), create);
        expect((await endpoint.fetch(new Request('https://public.invalid/'))).status).toBe(403); expect(create).not.toHaveBeenCalled();
        expect(f.db.rows('SELECT * FROM coordinator_identity')).toEqual([]);
        expect((await endpoint.fetch(await rpc.request('deliver', 'a2', {}))).status).toBe(403);
        expect((await endpoint.fetch(await rpc.request('deliver', 'a1', {}))).status).toBe(200);
        expect(create).toHaveBeenCalledWith({ role: 'account', account: 'a1' });
        const rebuilt = new CoordinatorEndpoint(f.db, rpc, () => true, create);
        expect(() => rebuilt.bindTrusted({ role: 'global' })).toThrow(/^CONFLICT$/);
        await rebuilt.alarm(); expect(create).toHaveBeenLastCalledWith({ role: 'account', account: 'a1' });
    });
    it('sanitizes unexpected executor exceptions at the endpoint', async () => {
        const f = sqliteFixture(); open.push(f); const rpc = new CoordinatorRpc(secret);
        const endpoint = new CoordinatorEndpoint(f.db, rpc, () => true, () => ({ handle: async () => { throw new Error('mock-secret-do-not-leak'); }, tick: async () => {} }));
        const response = await endpoint.fetch(await rpc.request('authorize', 'a1', {}));
        expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'NOT_READY' });
    });
});


describe('gateway-global and cancellation RPC separation',()=>{
    it.each(['submit_task','inspect_task','cancel_task','list_tasks','wake_task'] as const)('domain-separates %s from account callbacks',async method=>{
        const rpc=new CoordinatorRpc(secret),signed=await rpc.sign(method,'manager',{});
        expect((await rpc.verify(signed,name=>name===GLOBAL_OBJECT_NAME)).message.direction).toBe('gateway-global');
        await expect(rpc.verify({...signed,direction:'account-global'},()=>true)).rejects.toThrow('INVALID');
        await expect(rpc.verify({...signed,method:'authorize',direction:'account-global'},()=>true)).rejects.toThrow('INVALID');
        await expect(rpc.verify(signed,name=>name===accountObjectName('manager'))).rejects.toThrow('INVALID');
    });
    it('sends cancellation only to its signed account and rejects an edited permit',async()=>{
        const rpc=new CoordinatorRpc(secret),signed=await rpc.sign('cancel','a1',{task:'task1',token:'permit'});
        expect((await rpc.verify(signed,name=>name===accountObjectName('a1'))).role).toEqual({role:'account',account:'a1'});
        await expect(rpc.verify(signed,name=>name===GLOBAL_OBJECT_NAME)).rejects.toThrow('INVALID');
        await expect(rpc.verify({...signed,body:{task:'task2',token:'permit'}},()=>true)).rejects.toThrow('INVALID');
    });
});


describe('custom source RPC byte budgets',()=>{
    it('accepts a signed >128KiB submit_task while retaining scope and address checks',async()=>{
        const rpc=new CoordinatorRpc(secret),body={request:{source:'x'.repeat(180000)}};const signed=await rpc.sign('submit_task','manager',body);
        expect((await rpc.verify(signed,name=>name===GLOBAL_OBJECT_NAME)).message.body).toEqual(body);
        expect(await readRpcRequest(await rpc.request('submit_task','manager',body))).toHaveProperty('method','submit_task');
        await expect(rpc.verify({...signed,body:{request:{source:'y'.repeat(180000)}}},()=>true)).rejects.toThrow('INVALID');
        await expect(rpc.verify(signed,name=>name===accountObjectName('manager'))).rejects.toThrow('INVALID');
    });
    it.each(['deliver','progress','inspect_task','list_tasks'] as const)('retains original small limit for %s signing and reading',async method=>{
        const rpc=new CoordinatorRpc(secret),body={data:'x'.repeat(131073)};await expect(rpc.sign(method,'manager',body)).rejects.toThrow('INVALID');
        const request=new Request('https://coordinator.internal/v1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,body})});await expect(readRpcRequest(request)).rejects.toThrow('INVALID');
    });
    it('rejects >2MiB plus envelope before signing or verifying',async()=>{
        const rpc=new CoordinatorRpc(secret),body={data:'x'.repeat(2*1024*1024+16384)};await expect(rpc.sign('submit_task','manager',body)).rejects.toThrow('INVALID');
        const request=new Request('https://coordinator.internal/v1',{method:'POST',headers:{'content-type':'application/json','content-length':'1'},body:JSON.stringify({method:'submit_task',body})});await expect(readRpcRequest(request)).rejects.toThrow('INVALID');
    });
});
