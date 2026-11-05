import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AccountQueue } from '../../src/reliability/account-queue';
import type { SqlDatabase } from '../../src/reliability/config-store';
function fixture() {
    const sql = new DatabaseSync(':memory:');
    const db: SqlDatabase = {
        rows: (query, ...params) => sql.prepare(query).all(...params) as any,
        transaction(fn) { sql.exec('BEGIN IMMEDIATE'); try { const result = fn(); sql.exec('COMMIT'); return result; } catch(e) { sql.exec('ROLLBACK'); throw e; } }
    };
    return { sql, db, queue: new AccountQueue(db) };
}
const digest = 'a'.repeat(64), proof = 'b'.repeat(64);
describe('account execution ledger', () => {
    it('deduplicates inbox deliveries and rejects changed snapshots or steps', () => {
        const { sql, queue } = fixture();
        try {
            expect(queue.enqueue('t1', digest, 'snap1', ['upload'])).toEqual({ duplicate: false });
            expect(queue.enqueue('t1', digest, 'snap1', ['upload'])).toEqual({ duplicate: true });
            expect(() => queue.enqueue('t1', digest, 'snap2', ['upload'])).toThrow('CONFLICT');
            expect(() => queue.enqueue('t1', digest, 'snap1', ['delete_worker'])).toThrow('CONFLICT');
        } finally { sql.close(); }
    });
    it('commits the inbox hook atomically, checks duplicate deliveries and rejects non-void hooks', () => {
        const { sql, db, queue } = fixture();
        try {
            db.rows('CREATE TABLE inbox_test (id TEXT PRIMARY KEY)');
            queue.enqueue('t1', digest, 'snap1', ['upload'], () => { db.rows("INSERT INTO inbox_test VALUES ('t1')"); });
            expect(db.rows('SELECT * FROM inbox_test')).toHaveLength(1);
            expect(() => queue.enqueue('t1', digest, 'snap1', ['upload'], () => { throw new Error('inbox conflict'); })).toThrow('inbox conflict');
            expect(() => queue.enqueue('t2', digest, 'snap2', ['upload'], () => { db.rows("INSERT INTO inbox_test VALUES ('t2')"); return 1; })).toThrow('INVALID');
            expect(db.rows('SELECT * FROM inbox_test')).toHaveLength(1);
            expect(() => queue.inspect('t2')).toThrow('NOT_READY');
            expect(queue.inspect('t1').state).toBe('queued');
        } finally { sql.close(); }
    });
    it('serializes all worker and account operations, even after reconstruction', () => {
        const { sql, db, queue } = fixture();
        try {
            queue.enqueue('t1', digest, 'snap1', ['upload', 'configure_domain']);
            queue.enqueue('t2', digest, 'snap2', ['change_subdomain']);
            const first = queue.claim()!;
            const restarted = new AccountQueue(db);
            expect(restarted.claim()).toBe(null);
            expect(restarted.unresolved()).toHaveLength(1);
            restarted.reconcile(first.job, first.ordinal, first.token, 'verified', proof);
            const next = restarted.claim()!;
            expect(next.job).toBe('t1'); expect(next.ordinal).toBe(1);
            restarted.finish(next.job, next.ordinal, next.token, 'verified', proof);
            expect(restarted.inspect('t1').state).toBe('succeeded');
            expect(restarted.claim()!.job).toBe('t2');
        } finally { sql.close(); }
    });
    it('unknown blocks the account and cannot be blindly retried or released by cancellation', () => {
        const { sql, queue } = fixture();
        try {
            queue.enqueue('t1', digest, 'snap1', ['delete_worker', 'delete_kv']);
            queue.enqueue('t2', digest, 'snap2', ['upload']);
            const step = queue.claim()!;
            queue.finish(step.job, step.ordinal, step.token, 'unknown', proof);
            queue.cancel('t1');
            expect(queue.inspect('t1').state).toBe('needs_review');
            expect(queue.claim()).toBe(null);
            expect(() => queue.finish(step.job, step.ordinal, step.token, 'verified', proof)).toThrow('CONFLICT');
            queue.reconcile(step.job, step.ordinal, step.token, 'verified', proof);
            expect(queue.inspect('t1').state).toBe('partial_cancelled');
            expect(queue.claim()!.job).toBe('t2');
        } finally { sql.close(); }
    });
    it('cancel preserves an in-flight result and skips only unstarted steps', () => {
        const { sql, queue } = fixture();
        try {
            queue.enqueue('t1', digest, 'snap1', ['upload', 'configure_domain']);
            const step = queue.claim()!; queue.cancel('t1');
            expect(queue.inspect('t1').state).toBe('running');
            expect(queue.claim()).toBe(null);
            queue.finish(step.job, step.ordinal, step.token, 'verified', proof);
            expect(queue.inspect('t1').state).toBe('partial_cancelled');
            expect(queue.inspect('t1').steps.map(s => s.state)).toEqual(['verified', 'skipped']);
        } finally { sql.close(); }
    });
    it('confirmed failure skips dependent steps; late callbacks cannot change receipts', () => {
        const { sql, queue } = fixture();
        try {
            queue.enqueue('t1', digest, 'snap1', ['upload', 'configure_domain']);
            const step = queue.claim()!;
            expect(() => queue.finish(step.job, step.ordinal, 'stale', 'verified', proof)).toThrow('CONFLICT');
            queue.finish(step.job, step.ordinal, step.token, 'failed', proof);
            queue.finish(step.job, step.ordinal, step.token, 'failed', proof);
            expect(queue.inspect('t1').state).toBe('failed');
            expect(queue.claim()).toBe(null);
            expect(() => queue.finish(step.job, step.ordinal, step.token, 'verified', proof)).toThrow('CONFLICT');
            expect(sql.prepare('SELECT * FROM account_receipts').all()).toHaveLength(1);
        } finally { sql.close(); }
    });
    it('queued cancellation performs no step and capacity remains bounded', () => {
        const { sql, queue } = fixture();
        try {
            for (let n = 0; n < 50; n++) queue.enqueue('t' + n, digest, 'snap', ['upload']);
            expect(() => queue.enqueue('overflow', digest, 'snap', ['upload'])).toThrow('CONFLICT');
            queue.cancel('t0'); expect(queue.inspect('t0').state).toBe('cancelled');
            queue.enqueue('replacement', digest, 'snap', ['upload']);
            expect(queue.claim()!.job).toBe('t1');
        } finally { sql.close(); }
    });
});


describe('atomic cancellation on delivery',()=>{
    it('persists initial cancellation with the inbox and never makes its steps claimable',()=>{
        const {sql,db,queue}=fixture();try{
            db.rows('CREATE TABLE test_inbox(id TEXT PRIMARY KEY)');
            queue.enqueue('t1',digest,'snap1',['upload','configure_domain'],()=>{db.rows("INSERT INTO test_inbox VALUES ('t1')");},true);
            expect(queue.inspect('t1')).toMatchObject({state:'cancelled',cancelRequested:true});expect(queue.inspect('t1').steps.map(s=>s.state)).toEqual(['skipped','skipped']);expect(queue.claim()).toBeNull();
            const restarted=new AccountQueue(db);expect(restarted.inspect('t1').state).toBe('cancelled');
        }finally{sql.close();}
    });
    it('treats cancellation as monotone without changing immutable delivery identity',()=>{
        const {sql,queue}=fixture();try{
            queue.enqueue('t1',digest,'snap1',['upload']);expect(queue.enqueue('t1',digest,'snap1',['upload'],undefined,true)).toEqual({duplicate:true});
            queue.enqueue('t1',digest,'snap1',['upload'],undefined,false);expect(queue.inspect('t1').state).toBe('cancelled');
            expect(()=>queue.enqueue('t1',digest,'snap2',['upload'],undefined,true)).toThrow('CONFLICT');
        }finally{sql.close();}
    });
    it('rolls back inbox and admission together when cancellation persistence fails',()=>{
        const {sql,db,queue}=fixture();try{
            sql.exec("CREATE TABLE test_inbox(id TEXT PRIMARY KEY); CREATE TRIGGER reject_cancel BEFORE UPDATE OF cancel_requested ON account_jobs BEGIN SELECT RAISE(ABORT,'storage failure'); END;");
            expect(()=>queue.enqueue('t1',digest,'snap1',['upload'],()=>{db.rows("INSERT INTO test_inbox VALUES ('t1')");},true)).toThrow('storage failure');
            expect(db.rows('SELECT * FROM account_jobs')).toEqual([]);expect(db.rows('SELECT * FROM account_steps')).toEqual([]);expect(db.rows('SELECT * FROM test_inbox')).toEqual([]);
        }finally{sql.close();}
    });
    it('does not reset in-flight/unknown when a cancelled delivery is replayed',()=>{
        const {sql,queue}=fixture();try{
            queue.enqueue('t1',digest,'snap1',['upload','configure_domain']);const step=queue.claim()!;
            queue.finish('t1',0,step.token,'unknown',proof);queue.enqueue('t1',digest,'snap1',['upload','configure_domain'],undefined,true);
            expect(queue.inspect('t1')).toMatchObject({state:'needs_review',cancelRequested:true});expect(queue.inspect('t1').steps.map(s=>s.state)).toEqual(['unknown','skipped']);expect(queue.claim()).toBeNull();
        }finally{sql.close();}
    });
});


it('upgrades retained queue history with indexed state lookups while preserving unknown barriers', () => {
 const f=fixture();
 try {
  f.db.rows('DROP INDEX account_jobs_state_cancel_seq');f.db.rows('DROP INDEX account_steps_state_job_ordinal');
  f.db.transaction(()=>{for(let n=0;n<500;n++){
   f.db.rows("INSERT INTO account_jobs(id,digest,snapshot,state) VALUES (?,?,?,'succeeded')",'old_'+n,digest,'snapshot_'+n);
   f.db.rows("INSERT INTO account_steps VALUES (?,0,'upload','verified',?,?)",'old_'+n,'old_token_'+n,proof);
  }});
  f.queue.enqueue('pending',digest,'pending_snapshot',['upload']);
  const claimed=f.queue.claim()!;f.queue.finish(claimed.job,claimed.ordinal,claimed.token,'unknown',proof);
  const before=f.queue.inspect('pending');
  const query="SELECT * FROM account_steps WHERE state IN ('in_flight','unknown') ORDER BY job,ordinal";
  expect(f.db.rows<{detail:string}>('EXPLAIN QUERY PLAN '+query).some(r=>/SCAN account_steps/.test(r.detail))).toBe(true);
  const rebuilt=new AccountQueue(f.db);
  expect(f.db.rows<{detail:string}>('EXPLAIN QUERY PLAN '+query).some(r=>/SEARCH account_steps USING/.test(r.detail))).toBe(true);
  expect(f.db.rows<{detail:string}>("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM account_jobs WHERE state IN ('queued','running','needs_review')").some(r=>/SEARCH account_jobs USING/.test(r.detail))).toBe(true);
  expect(rebuilt.inspect('pending')).toEqual(before);expect(rebuilt.claim()).toBeNull();
  expect(f.db.rows<{n:number}>('SELECT COUNT(*) AS n FROM account_jobs')[0].n).toBe(501);
  expect(rebuilt.unresolved()).toHaveLength(1);
 } finally {f.sql.close();}
});
