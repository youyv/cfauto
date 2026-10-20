import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteFixture } from './sqlite-fixture';
import { ConfigStore } from '../../src/reliability/config-store';
import { SealedStore } from '../../src/reliability/sealed-store';
import { TaskDispatch } from '../../src/reliability/task-dispatch';
import { TaskPreparation, type PreparedTaskInput } from '../../src/reliability/task-preparation';
import { manifestDigest } from '../../src/reliability/protocol';
const open: ReturnType<typeof sqliteFixture>[] = [];
const secret = new Uint8Array(32).fill(21);
async function fixture() {
    const db = sqliteFixture(); open.push(db);
    const config = new ConfigStore(db.db), sealed = new SealedStore(db.db, { currentId: 'key1', keys: { key1: 'test-material-longer-than-thirty-two-bytes' } });
    const dispatch = new TaskDispatch(db.db, secret);
    const records = [{ domain: 'accounts', revision: 1, value: ['a1'] }, { domain: 'vars:cmliu', revision: 2, value: { UUID: 'old' } }];
    config.beginImport('gen1', await manifestDigest(records), records.length); records.forEach(r => config.stage('gen1', r));
    await config.activateInitial('gen1', 0); const { epoch } = config.setMaintenance(false, 1);
    const input: PreparedTaskInput = { scope: 'admin', key: 'request1', generation: 'gen1', epoch, expected: records.map(({ domain, revision }) => ({ domain, revision })), targets: [{ account: 'a1', steps: ['upload'], operation: { code: 'frozen-worker-code', apiToken: 'private-secret' } }] };
    return { ...db, config, sealed, dispatch, input, service: new TaskPreparation(config, sealed, dispatch, secret) };
}
afterEach(() => { for (const db of open.splice(0)) db.sql.close(); });
describe('encrypted task preparation and atomic config barrier', () => {
    it('creates a stable immutable snapshot and deduplicates concurrent preparations', async () => {
        const { service, input, sql, sealed, dispatch } = await fixture();
        const results = await Promise.all([service.submit(input), service.submit(input)]);
        expect(results[0].id).toBe(results[1].id); expect(results.filter(r => r.duplicate)).toHaveLength(1);
        expect(sql.prepare('SELECT * FROM sealed_objects').all()).toHaveLength(1);
        expect(JSON.stringify(sql.prepare('SELECT * FROM sealed_chunks').all())).not.toContain('private-secret');
        const delivery = dispatch.reserve()[0];
        expect(await sealed.get({ id: delivery.snapshot, kind: 'task_snapshot', account: 'a1', generation: 'gen1' })).toMatchObject({ operation: input.targets[0].operation });
    });
    it('rejects a config edit during asynchronous snapshot preparation without inserting a task', async () => {
        const { service, input, config, sql } = await fixture();
        const pending = service.submit(input);
        config.compareAndSet('gen1', [{ domain: 'vars:cmliu', expectedRevision: 2, value: { UUID: 'new' } }]);
        await expect(pending).rejects.toThrow('CONFLICT');
        expect(sql.prepare('SELECT * FROM dispatch_tasks').all()).toHaveLength(0);
        expect(sql.prepare('SELECT * FROM dispatch_outbox').all()).toHaveLength(0);
    });
    it('rejects maintenance and maintenance enter/exit ABA during preparation', async () => {
        for (const reopen of [false, true]) {
            const { service, input, config, sql } = await fixture();
            const pending = service.submit(input); config.setMaintenance(true, input.epoch);
            if (reopen) config.setMaintenance(false, input.epoch + 1);
            await expect(pending).rejects.toThrow(reopen ? 'CONFLICT' : 'MAINTENANCE');
            expect(sql.prepare('SELECT * FROM dispatch_tasks').all()).toHaveLength(0);
        }
    });
    it('returns an existing receipt after config changes but refuses changed intent with the same key', async () => {
        const { service, input, config } = await fixture(); const first = await service.submit(input);
        config.compareAndSet('gen1', [{ domain: 'accounts', expectedRevision: 1, value: ['a1', 'a2'] }]);
        expect(await service.submit(input)).toEqual({ id: first.id, duplicate: true });
        input.targets[0].operation = { code: 'different' };
        await expect(service.submit(input)).rejects.toThrow('CONFLICT');
    });
    it('freezes inputs before yielding and separates scopes', async () => {
        const { service, input, sealed, dispatch } = await fixture();
        const pending = service.submit(input); (input.targets[0].operation as any).apiToken = 'changed'; input.expected[0].revision = 999;
        await pending;
        const delivery = dispatch.reserve()[0];
        expect(await sealed.get({ id: delivery.snapshot, kind: 'task_snapshot', account: 'a1', generation: 'gen1' })).toMatchObject({ operation: { apiToken: 'private-secret' } });
        input.expected[0].revision = 1; input.scope = 'another_admin';
        await expect(service.submit(input)).resolves.toMatchObject({ duplicate: false });
    });
    it('does not silently accept an existing corrupt snapshot', async () => {
        const { service, input, sql } = await fixture(); await service.submit(input);
        sql.prepare("UPDATE sealed_chunks SET ciphertext='AAAA'").run();
        await expect(service.submit(input)).rejects.toThrow('INVALID');
    });
    it('rolls back task and outbox together if the insertion fails after the barrier', async () => {
        const { service, input, sql, config } = await fixture();
        const check = vi.spyOn(config, 'assertBarrier');
        sql.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON dispatch_outbox BEGIN SELECT RAISE(ABORT,'injected'); END");
        await expect(service.submit(input)).rejects.toThrow('injected'); expect(check).toHaveBeenCalledTimes(1);
        expect(sql.prepare('SELECT * FROM dispatch_tasks').all()).toHaveLength(0);
        expect(sql.prepare('SELECT * FROM sealed_objects').all()).toHaveLength(1); // retained, never auto-cleaned
        sql.exec('DROP TRIGGER fail_delivery'); await expect(service.submit(input)).resolves.toMatchObject({ duplicate: false });
    });
    it('requires credential/account revisions and validates malformed dependency lists', async () => {
        const { service, input, sql } = await fixture();
        for (const expected of [[], [{ domain: 'vars:cmliu', revision: 2 }], [{ domain: 'accounts', revision: 0 }], [...input.expected, input.expected[0]]]) {
            await expect(service.submit({ ...input, expected })).rejects.toThrow('INVALID');
        }
        expect(sql.prepare('SELECT * FROM dispatch_tasks').all()).toHaveLength(0);
    });
});


describe('task and user-intent configuration atomicity',()=>{
    it('rolls back config and projection when delivery insertion fails and retries exactly once',async()=>{
        const f=await fixture();f.input.changes=[{domain:'vars:cmliu',expectedRevision:2,value:{UUID:'rotated'}}];
        f.sql.exec("CREATE TRIGGER reject_task BEFORE INSERT ON dispatch_outbox BEGIN SELECT RAISE(ABORT,'injected'); END");
        await expect(f.service.submit(f.input)).rejects.toThrow('injected');
        expect(f.config.read(['vars:cmliu']).records[0]).toMatchObject({revision:2,value:{UUID:'old'}});
        expect(f.db.rows("SELECT * FROM config_outbox WHERE domain='vars:cmliu' AND revision>2")).toHaveLength(0);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toHaveLength(0);
        expect(f.db.rows('SELECT * FROM sealed_objects')).toHaveLength(1);
        f.sql.exec('DROP TRIGGER reject_task');const first=await f.service.submit(f.input);
        f.config.setMaintenance(true,2);expect(await f.service.submit(f.input)).toEqual({id:first.id,duplicate:true});
        expect(f.config.read(['vars:cmliu']).records[0]).toMatchObject({revision:3,value:{UUID:'rotated'}});
        expect(f.db.rows("SELECT * FROM config_outbox WHERE domain='vars:cmliu' AND revision>2")).toHaveLength(1);
    });
    it('rejects config changes without exact dependencies before any task is created',async()=>{
        const f=await fixture();
        for(const changes of [[],[{domain:'autoConfig',expectedRevision:0,value:{}}],[{domain:'vars:cmliu',expectedRevision:1,value:{}}],[{domain:'vars:cmliu',expectedRevision:2,value:{},extra:true}]]){
            await expect(f.service.submit({...f.input,changes})).rejects.toThrow('INVALID');
        }
        expect(f.db.rows("SELECT * FROM config_outbox WHERE domain='vars:cmliu' AND revision>2")).toHaveLength(0);expect(f.db.rows('SELECT * FROM dispatch_tasks')).toHaveLength(0);
    });
    it('seals config changes into the task identity and rejects changed values under the same key',async()=>{
        const f=await fixture();f.input.changes=[{domain:'vars:cmliu',expectedRevision:2,value:{UUID:'rotated'}}];
        await f.service.submit(f.input);f.input.changes[0].value={UUID:'other'};
        await expect(f.service.submit(f.input)).rejects.toThrow('CONFLICT');expect(f.config.read(['vars:cmliu']).records[0].value).toEqual({UUID:'rotated'});
    });
});
