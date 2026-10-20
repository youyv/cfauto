import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteFixture } from './sqlite-fixture';
import { AccountQueue } from '../../src/reliability/account-queue';
import { SealedStore } from '../../src/reliability/sealed-store';
import { AccountRunner, type RunnerOptions } from '../../src/reliability/account-runner';
import { fetchWithTimeout } from '../../src/lib/cloudflare-api';
import { pooledMap } from '../../src/lib/concurrency';
import { executionNow, executionUUID, frozenSubdomain } from '../../src/reliability/execution-context';
import { fetchGithubCode } from '../../src/lib/github';
import { ExecutionJournal } from '../../src/reliability/execution-journal';
const open: ReturnType<typeof sqliteFixture>[] = [];
const url = 'https://api.cloudflare.com/client/v4/accounts/account1/workers/scripts/demo';
const input = { now: 1000, uuids: ['11111111-1111-4111-8111-111111111111'], subdomains: ['frozen-subdomain'], sources: { cmliu: { code: 'fixed-code', sha: 'a'.repeat(40) } } };
function fixture() {
    const db = sqliteFixture(); open.push(db); const queue = new AccountQueue(db.db);
    const sealed = new SealedStore(db.db, { currentId: 'key1', keys: { key1: 'local-test-key-material-at-least-32-bytes' } });
    const transport = vi.fn(async () => Response.json({ success: true, result: { uploaded: true } }));
    const authorize = vi.fn(async () => {}), loadSnapshot = vi.fn(async () => ({ input, operation: null }));
    const execute = vi.fn(async () => { await fetchWithTimeout(url, { method: 'PUT', body: 'code' }); return { outcome: 'verified' as const, result: { uploaded: true } }; });
    const options: RunnerOptions = { account: 'account1', generation: 'gen1', digestSecret: 'local-test-digest-key-at-least-32-bytes', transport, authorize, loadSnapshot, execute };
    const make = () => new AccountRunner(db.db, queue, sealed, options);
    queue.enqueue('job1', 'a'.repeat(64), 'snapshot1', ['upload']);
    return { ...db, queue, sealed, transport, authorize, loadSnapshot, execute, options, make };
}
afterEach(() => { for (const db of open.splice(0)) db.sql.close(); vi.restoreAllMocks(); });
describe('account execution through actual business fetch wrapper', () => {
    it('journals real fetchWithTimeout calls and checks permit again before mutation', async () => {
        const { make, authorize, transport, queue } = fixture();
        expect(await make().tick()).toEqual({ job: 'job1', state: 'succeeded' });
        expect(authorize).toHaveBeenCalledTimes(2); expect(transport).toHaveBeenCalledTimes(1);
        expect(queue.inspect('job1').steps[0].evidence).toMatch(/^[a-f0-9]{64}$/);
    });
    it('coalesces concurrent passes instead of running the same account twice', async () => {
        const { make, transport } = fixture(); const runner = make();
        const results = await Promise.all([runner.tick(), runner.tick(), runner.tick()]);
        expect(results.every(r => r?.state === 'succeeded')).toBe(true); expect(transport).toHaveBeenCalledTimes(1);
    });
    it('blocks subsequent jobs when a handler catches a lost write response', async () => {
        const { make, execute, transport, queue } = fixture();
        transport.mockRejectedValueOnce(new Error('lost-response'));
        execute.mockImplementationOnce(async () => { try { await fetchWithTimeout(url, { method: 'PUT' }); } catch {} return { outcome: 'verified', result: { uploaded: true } }; });
        queue.enqueue('job2', 'b'.repeat(64), 'snapshot2', ['upload']);
        expect(await make().tick()).toEqual({ job: 'job1', state: 'needs_review' });
        expect(await make().tick()).toBe(null); expect(queue.inspect('job2').state).toBe('queued'); expect(transport).toHaveBeenCalledTimes(1);
    });
    it('reuses a durable handler result after outer queue acknowledgement was interrupted', async () => {
        const { make, sql, transport, execute } = fixture(); await make().tick();
        sql.exec("UPDATE account_jobs SET state='running'; UPDATE account_steps SET state='in_flight',evidence=NULL");
        execute.mockRejectedValueOnce(new Error('must not run'));
        expect(await make().tick()).toEqual({ job: 'job1', state: 'succeeded' }); expect(transport).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
    });
    it('replays a completed network journal after crash before result persistence', async () => {
        const { make, sql, transport, execute } = fixture(); await make().tick();
        sql.exec("DELETE FROM sealed_chunks WHERE id='result_job1_0'; DELETE FROM sealed_objects WHERE id='result_job1_0'; UPDATE account_jobs SET state='running'; UPDATE account_steps SET state='in_flight',evidence=NULL");
        expect(await make().tick()).toEqual({ job: 'job1', state: 'succeeded' }); expect(transport).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(2);
    });
    it('keeps clocks, random choices and upstream source fixed inside the execution context', async () => {
        const { make, options, transport } = fixture(); const seen: unknown[] = [];
        options.execute = async () => {
            seen.push(executionNow(), executionUUID(), frozenSubdomain());
            seen.push(await fetchGithubCode('cmliu', 'latest', {} as any));
            return { outcome: 'verified', result: true };
        };
        expect((await make().tick())?.state).toBe('succeeded');
        expect(seen).toEqual([1000, input.uuids[0], input.subdomains[0], input.sources.cmliu]); expect(transport).not.toHaveBeenCalled();
        expect(executionNow()).not.toBe(1000); expect(frozenSubdomain()).toBeUndefined();
    });
    it('forces legacy pooledMap to one lane in a job to preserve request ordering', async () => {
        const { make, options } = fixture(); let active = 0, peak = 0;
        options.execute = async () => {
            await pooledMap([1, 2, 3], async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; }, 3);
            return { outcome: 'verified', result: true };
        };
        await make().tick(); expect(peak).toBe(1);
    });
    it('does not download a moving upstream when the admitted snapshot lacks code', async () => {
        const { make, options, transport } = fixture();
        options.execute = async () => { await fetchGithubCode('joey', 'latest', {} as any); return { outcome: 'verified', result: true }; };
        expect((await make().tick())?.state).toBe('needs_review'); expect(transport).not.toHaveBeenCalled();
    });
    it('checks revocation before calling handler or transport and retains blocked state', async () => {
        const { make, authorize, transport, execute } = fixture(); authorize.mockRejectedValueOnce(new Error('revoked'));
        expect((await make().tick())?.state).toBe('needs_review'); expect(transport).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    });
    it('does not interpret a corrupt saved result as an absent result eligible for rerun', async () => {
        const { make, sql, transport } = fixture(); await make().tick();
        sql.exec("UPDATE account_jobs SET state='running'; UPDATE account_steps SET state='in_flight'; UPDATE sealed_chunks SET ciphertext='AAAA' WHERE id='result_job1_0'");
        expect((await make().tick())?.state).toBe('needs_review'); expect(transport).toHaveBeenCalledTimes(1);
    });
    it('settles an unknown step that provably issued no mutation as a definite write-free failure', async () => {
        const { db, make, sql, queue, sealed, options, transport } = fixture();
        // Create the journal tables without recording any call: a pre-mutation failure.
        new ExecutionJournal(db, sealed, { job: 'job1_0', account: 'account1', generation: 'gen1' }, { digestSecret: options.digestSecret, transport, authorizeMutation: async () => {} });
        const claimed = queue.claim()!;
        expect(claimed.job).toBe('job1');
        queue.finish('job1', claimed.ordinal, claimed.token, 'unknown', 'e'.repeat(64));
        expect(queue.inspect('job1').state).toBe('needs_review');
        expect(await make().tick()).toBe(null);
        const settled = queue.inspect('job1');
        expect(settled.state).toBe('failed');
        expect(settled.steps[0].state).toBe('failed');
        expect(sql.prepare('SELECT COUNT(*) AS n FROM no_mutation_settlements').get()).toEqual({ n: 1 });
        expect(await sealed.get({ id: 'result_job1_0', kind: 'task_snapshot', account: 'account1', generation: 'gen1' }))
            .toEqual({ outcome: 'failed', result: { kind: 'upload', code: 'NO_MUTATION_RECORDED' } });
        expect(transport).not.toHaveBeenCalled();
        expect(queue.unresolved()).toEqual([]);
    });
    it('never auto-settles an unknown step that does carry a journaled mutation', async () => {
        const { db, make, sql, queue, sealed, options, transport } = fixture();
        // A journaled write-ahead mutation is the case the unknown barrier exists for.
        new ExecutionJournal(db, sealed, { job: 'job1_0', account: 'account1', generation: 'gen1' }, { digestSecret: options.digestSecret, transport, authorizeMutation: async () => {} });
        sql.exec("INSERT INTO execution_calls VALUES ('job1_0',0,'" + 'a'.repeat(64) + "',1,'unknown')");
        const claimed = queue.claim()!;
        queue.finish('job1', claimed.ordinal, claimed.token, 'unknown', 'e'.repeat(64));
        expect(sql.prepare('SELECT COUNT(*) AS n FROM execution_calls WHERE mutation=1').get()).toEqual({ n: 1 });
        expect(await make().tick()).toBe(null);
        expect(queue.inspect('job1').state).toBe('needs_review');
        expect(sql.prepare('SELECT COUNT(*) AS n FROM no_mutation_settlements').get()).toEqual({ n: 0 });
    });
});
