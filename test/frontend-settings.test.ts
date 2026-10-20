// Related checks run in one suite; scoped fixtures preserve isolation. No browser is launched.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { automationSummary } from '../frontend/modules/automation-summary.js';
import vm from 'node:vm';
import { getRoute } from '../src/routes/register';
import { KV_KEYS } from '../src/config/templates';
import { mockKV, mockEnv, readKV, jsonReq } from './helpers';
import {createConfigProtocol} from '../frontend/modules/config-protocol.js';

describe('Settings edit and save workflow', () => {
    describe('control-toolbar', () => {
        const html = fs.readFileSync('frontend/index.html', 'utf8');
        describe('header automation drawer', () => {
            it('defaults to collapsed with all configuration controls and save inside', () => {
                expect(html).toContain('<details class="automation-drawer">');
                const drawer = html.split('<details class="automation-drawer">')[1].split('</details>')[0];
                for (const id of ['auto_update_toggle', 'auto_update_interval', 'auto_cmliu_toggle', 'auto_joey_toggle', 'auto_ech_toggle', 'fuse_threshold', 'fuse_webhook']) {
                    expect(drawer).toContain(`id="${id}"`);
                    expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
                }
                expect(drawer).toContain('data-act="saveAutoConfig"');
            });
            it('keeps frequent actions outside the drawer', () => {
                const quick = html.split('<details class="automation-drawer">')[0];
                for (const action of ['toggleTheme', 'logout', 'openWorkbench', 'openBatchDeployModal', 'openYxipGuarded']) {
                    expect(quick).toContain(`data-act="${action}"`);
                }
            });
        });
    });

    describe('automation-summary', () => {
        function summary(config: unknown) {
            return automationSummary(config, { cmliu: { name: 'CMliu' }, joey: { name: 'Joey' } });
        }
        describe('saved automation summary', () => {
            it('distinguishes unloaded, never-run, disabled and invalid dates', () => {
                expect(summary(null).brief).toContain('尚未读取');
                expect(summary({ enabled: true }).brief).toContain('从未检查');
                expect(summary({ enabled: false, lastCheck: 'bad' }).brief).toContain('已关闭');
                expect(summary({ enabled: true, lastCheck: Number.MAX_VALUE }).brief).toContain('时间无效');
            });
            it('describes saved interval and participants, without promising exact cron execution', () => {
                const s = summary({ enabled: true, interval: 45, lastCheck: 1790784000000, autoJoey: false });
                expect(s.brief).toContain('45 分钟');
                expect(s.details).toContain('CMliu');
                expect(s.details).not.toContain('Joey');
                expect(s.details).toContain('不是上次成功部署');
                expect(s.details).toContain('Cron');
            });
        });
    });

    describe('config-drafts', () => {
        function harness() {
            const elements: Record<string, any> = {};
            const listeners: Record<string, Function> = {};
            const field = { id: 'auto_update_interval', value: '30', type: 'number', disabled: true };
            const badge = { textContent: '', dataset: {}, setAttribute() {} };
            elements[field.id] = field;
            elements.auto_config_status = badge;
            const context = vm.createContext({
                $: (id: string) => elements[id], TEMPLATES: {},
                document: { addEventListener: (name: string, fn: Function) => { listeners[name] = fn; }, querySelectorAll: () => [field] },
                window: { addEventListener: (name: string, fn: Function) => { listeners[name] = fn; } },
                Swal: { fire: async () => ({ isConfirmed: false }) }
            });
            vm.runInContext(fs.readFileSync('frontend/js/config-drafts.js', 'utf8'), context);
            return { field, badge, listeners, run: (js: string) => vm.runInContext(js, context) };
        }

        describe('configuration draft snapshots', () => {
            it('initial load is clean; editing and reverting updates status without storing drafts', () => {
                const h = harness();
                expect(h.run("configDrafts.isDirty('auto')")).toBe(false);
                h.run("configDrafts.accept('auto')");
                expect(h.badge.textContent).toBe('已保存');
                h.field.value = '45'; h.listeners.input({ target: h.field });
                expect(h.badge.textContent).toBe('未保存');
                h.field.value = '30'; h.listeners.change({ target: h.field });
                expect(h.badge.textContent).toBe('已保存');
            });
            it('does not replace unchanged live-region text on each keystroke or busy update', () => {
                const h = harness();
                let text = '', writes = 0;
                Object.defineProperty(h.badge, 'textContent', { get: () => text, set: value => { text = value; writes++; } });
                h.run("configDrafts.accept('auto')");
                h.field.value = '45'; h.listeners.input({ target: h.field });
                expect(writes).toBe(2);
                h.field.value = '46'; h.listeners.input({ target: h.field });
                h.run("configDrafts.setBusy('auto', true); configDrafts.setBusy('auto', false)");
                expect(writes).toBe(2);
                h.field.value = '30'; h.listeners.input({ target: h.field });
                expect(writes).toBe(3);
            });
            it('busy/failed saves preserve the snapshot and draft; success alone accepts it', () => {
                const h = harness(); h.run("configDrafts.accept('auto')");
                h.field.value = '60'; h.run("configDrafts.setBusy('auto', true)");
                expect(h.field.disabled).toBe(true);
                h.run("configDrafts.setBusy('auto', false)");
                expect(h.field.value).toBe('60');
                expect(h.run("configDrafts.isDirty('auto')")).toBe(true);
                h.run("configDrafts.accept('auto')");
                expect(h.run("configDrafts.isDirty('auto')")).toBe(false);
            });
            it('only guards navigation with unsaved edits; cancelling discard retains them', async () => {
                const h = harness(); h.run("configDrafts.accept('auto')");
                let prevented = false;
                const event = { preventDefault() { prevented = true; }, returnValue: undefined };
                h.listeners.beforeunload(event); expect(prevented).toBe(false);
                h.field.value = '42'; h.listeners.beforeunload(event); expect(prevented).toBe(true);
                expect(await h.run("configDrafts.confirmDiscard('auto')")).toBe(false);
                expect(h.run("configDrafts.isDirty('auto')")).toBe(true);
            });
        });

        describe('auto config save response', () => {
            it('returns the canonical saved config without losing scheduler state', async () => {
                const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: { lastCheck: 101, lastGc: 202 } });
                const handler = getRoute('POST', '/api/auto_config')!;
                const response = await handler(jsonReq('POST', 'https://panel.test/api/auto_config', {
                    enabled: true, interval: 45.9, fuseThreshold: 8.7, fuseWebhook: ' https://example.invalid/hook ', autoJoey: false
                }), mockEnv(kv));
                const body = await response.json() as any;
                expect(body.success).toBe(true);
                expect(body.config).toMatchObject({ interval: 45, fuseThreshold: 8, fuseWebhook: 'https://example.invalid/hook', autoJoey: false, lastCheck: 101 });
                expect(readKV(kv, KV_KEYS.GLOBAL_CONFIG)).toEqual({ ...body.config, lastGc: 202 });
            });
            it('rejects invalid drafts without changing saved config', async () => {
                const saved = { interval: 30, enabled: true };
                const kv = mockKV({ [KV_KEYS.GLOBAL_CONFIG]: saved });
                const response = await getRoute('POST', '/api/auto_config')!(jsonReq('POST', 'https://panel.test/api/auto_config', { interval: 0 }), mockEnv(kv));
                expect(response.status).toBe(400);
                expect(readKV(kv, KV_KEYS.GLOBAL_CONFIG)).toEqual(saved);
            });
        });
    });

    describe('config-protocol', () => {
        function fixture(){let n=0;const protocol=createConfigProtocol({newKey:()=> 'intent-'+(++n),baseUrl:()=> 'https://panel.test/'}),data={enabled:true};const read=(revision=1)=>{const v={...data};protocol.observe('/api/auto_config',v,new Headers({'x-reliability-protocol':'1','x-config-generation':'g1','x-config-epoch':'2','x-config-revision':String(revision)}));return v;};protocol.accept('autoConfig',read());const prepare=(value=data)=>protocol.prepare('/api/auto_config',{method:'POST',body:JSON.stringify(value)});return {protocol,read,prepare,data};}
        describe('configuration frontend protocol without a browser',()=>{
         it('sends the displayed revision and reuses the exact key/body after lost ACK',()=>{const f=fixture(),one=f.prepare(),two=f.prepare();expect(two.init.headers.get('Idempotency-Key')).toBe(one.init.headers.get('Idempotency-Key'));expect(two.init.body).toBe(one.init.body);expect(two.init.headers.get('X-Config-Revision')).toBe('1');});
         it('does not let a background read silently upgrade the revision of an old form',()=>{const f=fixture();f.read(3);expect(f.prepare().init.headers.get('X-Config-Revision')).toBe('1');});
         it('pins an open editor while other views accept newer snapshots',()=>{const f=fixture();f.protocol.pin('autoConfig');f.protocol.accept('autoConfig',f.read(4));expect(f.prepare().init.headers.get('X-Config-Revision')).toBe('1');});
         it('refuses a different intent while the previous response is unknown, even after another read',()=>{const f=fixture();f.prepare();f.protocol.accept('autoConfig',f.read(2));expect(()=>f.prepare({enabled:false})).toThrow('上次保存');});
         it('keeps conflicts blocked until an explicitly accepted reload, never retries automatically',()=>{const f=fixture(),one=f.prepare();expect(()=>f.protocol.finish(one.ticket,409,{error:'CONFLICT'})).toThrow('草稿已保留');f.read(2);expect(()=>f.prepare()).toThrow('服务器配置');f.protocol.accept('autoConfig',f.read(2));const next=f.prepare();expect(next.init.headers.get('Idempotency-Key')).not.toBe(one.init.headers.get('Idempotency-Key'));expect(next.init.headers.get('X-Config-Revision')).toBe('2');});
         it('advances only from an exact server receipt, then creates a new identity for the next edit',()=>{const f=fixture(),one=f.prepare();f.protocol.finish(one.ticket,200,{domain:'autoConfig',generation:'g1',epoch:2,revision:2});const next=f.prepare({enabled:false});expect(next.init.headers.get('X-Config-Revision')).toBe('2');expect(next.ticket.key).not.toBe(one.ticket.key);});
         it('does not accept a malformed success and does not silently switch back to legacy reads',()=>{const f=fixture(),one=f.prepare();expect(()=>f.protocol.finish(one.ticket,200,{success:true})).toThrow('回执不完整');expect(()=>f.protocol.observe('/api/auto_config',{},new Headers())).toThrow('旧配置');expect(f.prepare().ticket.key).toBe(one.ticket.key);});
         it('accepts explicit revision zero in init for a missing variable domain',()=>{let n=0;const p=createConfigProtocol({newKey:()=>String(++n),baseUrl:()=> 'https://panel.test'}),data={accounts:[],autoConfig:{},vars:{joey:null},deployConfigs:{},reliability:{protocol:1,generation:'g1',epoch:2,revisions:{accounts:1,autoConfig:0,'vars:joey':0}}};p.observe('/api/init_data',data,new Headers());p.accept('vars:joey',data);expect(p.prepare('/api/settings?type=joey',{method:'POST',body:'[]'}).init.headers.get('X-Config-Revision')).toBe('0');});
         it('requires explicit revision metadata, never guesses from an old read',()=>{const f=fixture();expect(()=>f.protocol.prepare('/api/settings?type=cmliu',{method:'POST',body:'[]'})).toThrow('先读取');});
         it('observes, prepares and commits the editable template compatibility domain',()=>{let n=0;const p=createConfigProtocol({newKey:()=> 'key-'+(++n),baseUrl:()=> 'https://panel.test'});const url='/api/reliability/config?kind=template&template=joey',data={generation:'g1',epoch:2,revision:0,value:{compatibilityDate:'2026-01-20'}};p.observe(url,data,new Headers());p.accept('template:joey',data.value);expect(p.baseline('template:joey')).toEqual({generation:'g1',epoch:2,revision:0});const body=JSON.stringify({key:'edit-once',generation:'g1',epoch:2,revision:0,selector:{kind:'template',template:'joey'},value:{compatibilityDate:'2025-12-01'}}),prepared=p.prepare(url,{method:'POST',body});expect(prepared.ticket?.domain).toBe('template:joey');expect(prepared.init.headers.get('X-Config-Revision')).toBe('0');expect(prepared.init.headers.get('Idempotency-Key')).toBe('key-1');p.finish(prepared.ticket,200,{domain:'template:joey',generation:'g1',epoch:2,revision:1});expect(p.baseline('template:joey')).toEqual({generation:'g1',epoch:2,revision:1});});
        });

        describe('configuration rejected and unknown save recovery',()=>{
         it.each([400,401,403,405,413,415,422])('a definitive %i refusal permits correcting the draft with a new key',status=>{const f=fixture(),one=f.prepare();f.protocol.finish(one.ticket,status,{error:'INVALID'});const two=f.prepare({enabled:false});expect(two.ticket.key).not.toBe(one.ticket.key);expect(two.init.headers.get('X-Config-Revision')).toBe('1');});
         it('explicit retry returns original account bytes even after a statistics refresh or changed draft',()=>{let n=0;const p=createConfigProtocol({newKey:()=> 'key-'+(++n),baseUrl:()=> 'https://panel.test'}),accounts=[{alias:'a',stats:{total:1}}];p.observe('/api/accounts',accounts,new Headers({'x-reliability-protocol':'1','x-config-generation':'g1','x-config-epoch':'2','x-config-revision':'1'}));p.accept('accounts',accounts);const one=p.prepare('/api/accounts',{method:'POST',body:JSON.stringify(accounts)});accounts[0].stats.total=2;expect(()=>p.prepare('/api/accounts',{method:'POST',body:JSON.stringify(accounts)})).toThrow('上次保存');const retry=p.retry('accounts');const next=p.prepare(retry.url,retry.init);expect(next.ticket.key).toBe(one.ticket.key);expect(next.init.body).toBe(one.init.body);expect(JSON.stringify(p.pending())).not.toMatch(/alias|stats|total/);});
         it('never offers replay as a conflict override',()=>{const f=fixture(),one=f.prepare();expect(()=>f.protocol.finish(one.ticket,409,{})).toThrow();expect(()=>f.protocol.retry('autoConfig')).toThrow('重新读取');});
        });

        describe('overlapping retry receipts and pinned conflicts',()=>{
         it('a late receipt from an earlier confirmed save cannot regress a newer revision',()=>{const f=fixture(),one=f.prepare();f.protocol.finish(one.ticket,200,{domain:'autoConfig',generation:'g1',epoch:2,revision:2});const two=f.prepare({enabled:false});f.protocol.finish(two.ticket,200,{domain:'autoConfig',generation:'g1',epoch:2,revision:3});f.protocol.finish(one.ticket,200,{domain:'autoConfig',generation:'g1',epoch:2,revision:2});expect(f.prepare().init.headers.get('X-Config-Revision')).toBe('3');});
         it('a list reload does not unlock a conflicting pinned editor',()=>{const f=fixture();f.protocol.pin('autoConfig');const one=f.prepare();expect(()=>f.protocol.finish(one.ticket,409,{})).toThrow();f.protocol.accept('autoConfig',f.read(3));expect(()=>f.prepare()).toThrow('服务器配置');f.protocol.release('autoConfig');f.protocol.accept('autoConfig',f.read(3));expect(f.prepare().init.headers.get('X-Config-Revision')).toBe('3');});
        });
    });

    describe('account save payload', () => {
        it('keeps runtime statistics out of the authoritative account configuration', () => {
            const source = fs.readFileSync('frontend/js/accounts.js', 'utf8');
            // both single-account save and batch/confirm removal must send the stripped payload
            expect(source).toContain('JSON.stringify(accountSavePayload(state.accounts))');
            expect(source).toContain('JSON.stringify(accountSavePayload(remaining))');
            expect(source).not.toMatch(/body: JSON\.stringify\((state\.accounts|remaining)\)/);
            // the table keeps only the display fields returned by /api/stats
            expect(source).toContain('a.stats = { total: s.total, max: s.max');
            expect(fs.readFileSync('frontend/modules/account-payload.js', 'utf8')).toContain('export function accountSavePayload');
        });
    });
});
