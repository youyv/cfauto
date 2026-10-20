import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_DEADLINE_MS, sendCoordinatorRpc } from '../../src/reliability/production-rpc';
import { CoordinatorRpc, GLOBAL_OBJECT_NAME, accountObjectName } from '../../src/reliability/coordinator-rpc';
import { MAX_SEALED_BYTES, MAX_SEALED_PLAINTEXT_BYTES } from '../../src/reliability/sealed-store';
import { businessAccount } from './production-fixture';
const rpc = new CoordinatorRpc('1'.repeat(64));
function fixture(reply: (r: Request) => Promise<Response>) {
    const calls: string[] = [], fetch = vi.fn(reply);
    const namespace = { idFromName: (name: string) => { calls.push(name); return name; }, get: () => ({fetch}) } as any;
    return { namespace, calls, fetch };
}
afterEach(() => vi.useRealTimers());
describe('production binding client', () => {
    it('uses only named bindings, signs messages and accepts bounded JSON', async () => {
        const f = fixture(async request => { const input = await request.json(); const verified = await rpc.verify(input, name=>name===accountObjectName(businessAccount)); expect(verified.role).toEqual({role:'account',account:businessAccount}); return Response.json({value:{duplicate:false}}); });
        expect(await sendCoordinatorRpc(f.namespace,rpc,'deliver',businessAccount,{})).toEqual({duplicate:false}); expect(f.calls).toEqual([accountObjectName(businessAccount)]);
    });
    it('routes account replies to the single global binding', async () => {
        const f = fixture(async () => Response.json({value:{acknowledged:true}})); await sendCoordinatorRpc(f.namespace,rpc,'complete',businessAccount,{}); expect(f.calls).toEqual([GLOBAL_OBJECT_NAME]);
    });
    it.each([new Response('secret upstream error',{status:503}),Response.json({value:true,secret:'must-not-leak'}),new Response('{broken',{headers:{'Content-Type':'application/json'}}),new Response(new Uint8Array([0xff]),{headers:{'Content-Type':'application/json'}})])('rejects invalid responses without raw diagnostics (%#)', async response => {
        const f = fixture(async ()=>response); await expect(sendCoordinatorRpc(f.namespace,rpc,'authorize',businessAccount,{})).rejects.toThrow('NOT_READY'); expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it.each([['snapshot',MAX_SEALED_PLAINTEXT_BYTES],['read_external',MAX_SEALED_PLAINTEXT_BYTES],['read_config',MAX_SEALED_BYTES]] as const)('caps streamed %s responses even when Content-Length lies', async (method,limit) => {
        const cancel = vi.fn(), f = fixture(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(limit+65537));},cancel}),{headers:{'Content-Type':'application/json','Content-Length':'2'}}));
        await expect(sendCoordinatorRpc(f.namespace,rpc,method,businessAccount,{})).rejects.toThrow('NOT_READY'); expect(cancel).toHaveBeenCalledTimes(1); expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('times out blocked response bodies and cancels without retry', async () => {
        vi.useFakeTimers();
        let bindingReached!: () => void;
        const reached = new Promise<void>(resolve => { bindingReached = resolve; });
        const cancel = vi.fn(), f = fixture(async()=>{
            bindingReached();
            return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"value":'));},cancel}),{headers:{'Content-Type':'application/json'}});
        });
        const pending = sendCoordinatorRpc(f.namespace,rpc,'snapshot',businessAccount,{}); const checked = expect(pending).rejects.toThrow('NOT_READY');
        // Native WebCrypto runs outside fake timers. Synchronize on the binding
        // event, not a CPU/load-dependent count of event-loop turns. Keep a real
        // deadline so a signing regression cannot silently hang this test.
        let waitTimer: ReturnType<typeof realTimeout> | undefined;
        try {
            await Promise.race([reached, new Promise<never>((_, reject) => {
                waitTimer = realTimeout(() => reject(new Error('binding was not reached')), 4000);
            })]);
        } finally { clearRealTimeout(waitTimer); }
        expect(f.fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(14999);
        expect(cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2); await checked;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('budgets a long business admission instead of cutting it off at the generic deadline', async () => {
        vi.useFakeTimers();
        let bindingReached!: () => void;
        const reached = new Promise<void>(resolve => { bindingReached = resolve; });
        const cancel = vi.fn(), f = fixture(async()=>{
            bindingReached();
            return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"value":'));},cancel}),{headers:{'Content-Type':'application/json'}});
        });
        const pending = sendCoordinatorRpc(f.namespace,rpc,'submit_task',businessAccount,{});
        const checked = expect(pending).rejects.toThrow('NOT_READY');
        let waitTimer: ReturnType<typeof realTimeout> | undefined;
        try {
            await Promise.race([reached, new Promise<never>((_, reject) => {
                waitTimer = realTimeout(() => reject(new Error('binding was not reached')), 4000);
            })]);
        } finally { clearRealTimeout(waitTimer); }
        expect(f.fetch).toHaveBeenCalledTimes(1);
        // A production admission that resolves and seals upstream source needs more
        // than the generic budget, but must still be bounded rather than hang.
        expect(RPC_DEADLINE_MS.submit_task).toBeGreaterThan(15000);
        expect(RPC_DEADLINE_MS.snapshot ?? 15000).toBe(15000);
        await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS.submit_task! - 1);
        expect(cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2); await checked;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('does not retry binding rejection', async () => {
        const f = fixture(async()=>{throw new Error('private diagnostic');}); await expect(sendCoordinatorRpc(f.namespace,rpc,'authorize',businessAccount,{})).rejects.toThrow('NOT_READY'); expect(f.fetch).toHaveBeenCalledTimes(1);
    });
    it('rejects invalid accounts before contacting any binding', async () => {
        const f = fixture(async()=>Response.json({value:true})); await expect(sendCoordinatorRpc(f.namespace,rpc,'authorize','../x',{})).rejects.toThrow('INVALID'); expect(f.fetch).not.toHaveBeenCalled();
    });
});


describe('safe business response refusals',()=>{
    it.each(['list_tasks','wake_task'] as const)('preserves whitelisted refusal for %s, never raw upstream text',async method=>{
        const f=fixture(async()=>Response.json({error:'CONFLICT'},{status:409}));await expect(sendCoordinatorRpc(f.namespace,rpc,method,businessAccount,{})).rejects.toMatchObject({code:'CONFLICT',status:409});expect(f.fetch).toHaveBeenCalledTimes(1);
        const unsafe=fixture(async()=>Response.json({error:'private diagnostic'},{status:409}));await expect(sendCoordinatorRpc(unsafe.namespace,rpc,method,businessAccount,{})).rejects.toThrow('NOT_READY');
    });
});

it.each(['probe_drain','release_drain'] as const)('routes %s only to the physically named account binding',async method=>{const f=fixture(async request=>{const verified=await rpc.verify(await request.json(),name=>name===accountObjectName(businessAccount));expect(verified.role).toEqual({role:'account',account:businessAccount});return Response.json({value:{ready:true}});});await sendCoordinatorRpc(f.namespace,rpc,method,businessAccount,{});expect(f.calls).toEqual([accountObjectName(businessAccount)]);});
