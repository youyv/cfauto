// Related checks run in one suite; scoped fixtures preserve isolation. No browser is launched.
import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createTaskProtocol} from '../frontend/modules/task-protocol.js';
import { getRoute } from '../src/routes/register';
import { mockEnv, mockKV, jsonReq, stubFetch } from './helpers';
import { KV_KEYS } from '../src/config/templates';

describe('Task admission, confirmation and observation', () => {
    describe('task-frontend', () => {
        const receipt={id:'task-1',status:'accepted',protocol:1,statusUrl:'/api/reliability/tasks/task-1',duplicate:false};
        function protocol(){let n=0;return createTaskProtocol({newKey:()=> 'key-'+(++n),baseUrl:()=> 'https://panel.test/',enabled:()=>true});}
        describe('task submission client without a browser',()=>{
         it.each(['/api/deploy?type=cmliu','/api/batch_deploy','/api/fix_1101','/api/delete_worker','/api/change_subdomain','/api/save_yxip'])('freezes original body/key for %s and clears only on durable accepted ACK',url=>{const p=protocol(),a=p.prepare(url,{method:'POST',body:'{}'});p.finish(a.ticket,503,{});const retry=p.retry(url),b=p.prepare(retry.url,retry.init);expect(b.init.headers.get('idempotency-key')).toBe(a.init.headers.get('idempotency-key'));expect(b.init.headers.get('x-reliability-protocol')).toBe('1');expect(()=>p.prepare(url,{method:'POST',body:'{"changed":true}'})).toThrow('原任务');p.finish(a.ticket,202,receipt);expect(p.pending()).toEqual([]);expect(p.prepare(url,{method:'POST',body:'{}'}).ticket.key).not.toBe(a.ticket.key);});
         it('does not mistake config-only Joey save or cancellation for a new business admission',()=>{const p=protocol();expect(p.prepare('/api/save_yxip',{method:'POST',body:'{"type":"joey_var"}'}).ticket).toBeNull();expect(p.prepare('/api/reliability/tasks/task-1/cancel',{method:'POST',body:'{}'}).ticket).toBeNull();});
         it.each([{}, {...receipt,status:'succeeded'}, {...receipt,statusUrl:'https://evil.test/'}, {...receipt,id:'../escape'}])('retains malformed receipt identity without a new task %j',value=>{const p=protocol(),a=p.prepare('/api/delete_worker',{method:'POST',body:'{}'});expect(()=>p.finish(a.ticket,202,value)).toThrow('不完整');expect(p.pending()).toHaveLength(1);});
         it('keeps a conflict identity, but definitive validation refusal allows a corrected intent',()=>{const p=protocol(),a=p.prepare('/api/deploy',{method:'POST',body:'{}'});p.finish(a.ticket,409,{});expect(()=>p.prepare('/api/deploy',{method:'POST',body:'[]'})).toThrow();p.finish(a.ticket,400,{});expect(p.prepare('/api/deploy',{method:'POST',body:'[]'}).ticket.key).not.toBe(a.ticket.key);});
        });
        function element(){return {textContent:'',children:[] as any[],listeners:{} as Record<string,Function>,hidden:false,disabled:false,attributes:{} as Record<string,string>,focus:vi.fn(),setAttribute(k:string,v:string){this.attributes[k]=v;},getAttribute(k:string){return this.attributes[k]??null;},appendChild(x:any){this.children.push(x);},replaceChildren(){this.children=[];},addEventListener(k:string,f:Function){this.listeners[k]=f;}};}
        function ui(){const ids=Object.fromEntries(['task_panel','task_pending','task_detail','task_list','task_more','task_toggle','task_badge'].map(id=>[id,element()])),responses:any[]=[],api=vi.fn(async()=>{if(!responses.length)throw Error('missing mock');return responses.shift();}),actions:any={},timers:Function[]=[],c:any={document:{createElement:()=>element()},$: (id:string)=>ids[id],apiFetch:api,wbLog:vi.fn(),Swal:{fire:vi.fn(async()=>({isConfirmed:true}))},registerActions:(map:any)=>Object.assign(actions,map),setTimeout:(fn:Function)=>{timers.push(fn);return timers.length;},clearTimeout:vi.fn(),taskProtocol:protocol(),console};vm.createContext(c);vm.runInContext(readFileSync('frontend/js/tasks.js','utf8'),c);return {c,ids,responses,api,actions,timers,text:(el:any):string=>[el.textContent,...el.children.map((child:any)=>uiText(child))].join(' ')};}
        function uiText(el:any):string{return [el.textContent,...el.children.map(uiText)].join(' ');}
        const task={id:'task-1',state:'running',terminal:false,trigger:'manual',targets:[{account:'a'.repeat(32),state:'accepted',outcome:null,steps:[{ordinal:0,kind:'upload',state:'verified',result:{worker:'demo'}}]}],deployments:[]};
        describe('task panel callbacks in Node VM, no browser execution',()=>{
         it('renders accepted as not completed, resumes persisted detail and permits only explicit cancel/wake calls',async()=>{const f=ui();f.responses.push(task);expect(f.c.trackAcceptedTask(receipt)).toBe(true);await vi.waitFor(()=>expect(f.ids.task_detail.children.length).toBeGreaterThan(0));expect(f.c.wbLog).toHaveBeenCalledWith(expect.stringContaining('尚未完成'),expect.any(String));expect(uiText(f.ids.task_detail)).toContain('仍未收到全部终态');expect(f.api.mock.calls.every((args:any[])=>!args[1])).toBe(true);const cancel=f.ids.task_detail.children.find((x:any)=>x.textContent==='请求取消');f.responses.push({cancellationRequested:true},task);await cancel.listeners.click();expect(f.api).toHaveBeenCalledWith('/api/reliability/tasks/task-1/cancel',{method:'POST',body:'{}'});});
         it('unknown stays needs_review, has no automatic wake or polling, and does not show terminal success',async()=>{const f=ui();f.responses.push({...task,state:'needs_review'});await f.c.showTask('task-1');expect(uiText(f.ids.task_detail)).toContain('需安全对账');expect(uiText(f.ids.task_detail)).not.toContain('已验证完成');expect(f.timers).toHaveLength(0);expect(f.api).toHaveBeenCalledTimes(1);});
         it('successful deployment with unknown webhook is explicitly shown without auto-resending',async()=>{const f=ui();f.responses.push({...task,state:'succeeded',terminal:true,trigger:'automation',notification:'unknown'});await f.c.showTask('task-1');expect(uiText(f.ids.task_detail)).toContain('已验证完成');expect(uiText(f.ids.task_detail)).toContain('结果未知，不自动重发');expect(f.timers).toHaveLength(0);expect(f.api).toHaveBeenCalledTimes(1);});
         it('uses signed cursor for next page and refresh reconnect does not submit work',async()=>{const f=ui();f.responses.push({items:[task],cursor:'v2.2.signed'});await f.actions.showTaskCatalog();f.responses.push({items:[{...task,id:'task-2'}],cursor:null});await f.actions.moreTasks();expect(f.api).toHaveBeenLastCalledWith('/api/reliability/tasks?limit=20&cursor=v2.2.signed');expect(f.ids.task_list.children).toHaveLength(2);expect(f.ids.task_more.disabled).toBe(true);});
        });

        it('shows manual closure as unverified failure with no retry or maintenance mutation control',async()=>{const f=ui();f.responses.push({...task,state:'failed',terminal:true,humanSettlements:1,targets:[{account:'a'.repeat(32),state:'terminal',outcome:'failed',steps:[{ordinal:0,kind:'upload',state:'failed',result:{code:'OPERATOR_CLOSED_UNCONFIRMED',adjudication:'decision_1',machineVerified:false,externalSuccessClaimed:false}}]}]});await f.c.showTask('task-1');const text=uiText(f.ids.task_detail);expect(text).toContain('人工结案（未验证成功）');expect(text).toContain('不是程序验证');expect(text).toContain('不代表原操作成功或已回滚');expect(text).toContain('decision_1');expect(text).not.toContain('已验证完成');expect(f.ids.task_detail.children.filter((e:any)=>e.type==='button').map((e:any)=>e.textContent)).toEqual(['重新连接','停止本页轮询（不取消任务）']);expect(f.timers).toHaveLength(0);expect(f.api).toHaveBeenCalledTimes(1);});

        it('shows configured but unsupported notification as not sent, with no resend or polling',async()=>{const f=ui();f.responses.push({...task,state:'succeeded',terminal:true,trigger:'automation',notification:'unsupported'});await f.c.showTask('task-1');const text=uiText(f.ids.task_detail);expect(text).toContain('已验证完成');expect(text).toContain('通知地址不受支持，未发送');expect(text).not.toContain('未配置');expect(f.timers).toHaveLength(0);expect(f.api).toHaveBeenCalledTimes(1);});

        it.each(['failed','partial_failed','cancelled','partial_cancelled'])('does not poll or offer notification retry for terminal %s automation',async state=>{const f=ui();f.responses.push({...task,state,terminal:true,trigger:'automation',notification:'not_sent'});await f.c.showTask('task-1');expect(uiText(f.ids.task_detail)).toContain('部署未全部成功，未发送通知');expect(uiText(f.ids.task_detail)).not.toContain('待完成后确认');expect(f.timers).toHaveLength(0);expect(f.api).toHaveBeenCalledTimes(1);});


        describe('collapsible task drawer, no browser execution',()=>{
         it('starts collapsed under the header with an accessible local-icon toolbar toggle',()=>{const html=readFileSync('frontend/index.html','utf8');const panel=html.match(/<section id="task_panel"[^>]*>/)![0];expect(panel).toContain('hidden');expect(html.indexOf('id="task_panel"')).toBeGreaterThan(html.indexOf('<header'));expect(html).toMatch(/id="task_toggle"[^>]*aria-controls="task_panel"[^>]*aria-expanded="false"/);expect(html).toContain('class="task-toggle"');expect(readFileSync('frontend/css/style.css','utf8')).toContain('.task-panel[hidden], .task-toggle-dot[hidden] { display: none; }');});
         it('keeps accepted work collapsed with an indicator until explicitly opened',async()=>{const f=ui();f.ids.task_panel.hidden=true;f.c.trackAcceptedTask(receipt);expect(f.ids.task_panel.hidden).toBe(true);expect(f.ids.task_badge.hidden).toBe(false);expect(f.api).not.toHaveBeenCalled();f.responses.push({items:[task],cursor:null},task);await f.actions.toggleTaskPanel();expect(f.ids.task_panel.hidden).toBe(false);expect(f.ids.task_toggle.getAttribute('aria-expanded')).toBe('true');expect(uiText(f.ids.task_detail)).toContain('仍未收到全部终态');expect(f.ids.task_badge.hidden).toBe(true);f.actions.closeTaskPanel();expect(f.ids.task_panel.hidden).toBe(true);expect(f.ids.task_toggle.getAttribute('aria-expanded')).toBe('false');expect(f.ids.task_toggle.focus).toHaveBeenCalled();expect(f.api.mock.calls.every((a:any[])=>!a[1])).toBe(true);});
         it('closing invalidates in-flight detail reads without cancelling server work or restarting polling',async()=>{const f=ui();let resolve!:(v:any)=>void;f.api.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const pending=f.c.showTask('task-1');f.actions.closeTaskPanel();resolve(task);await pending;expect(f.ids.task_panel.hidden).toBe(true);expect(f.ids.task_detail.children).toHaveLength(0);expect(f.timers).toHaveLength(0);expect(f.api).toHaveBeenCalledTimes(1);});
         it('a late catalog response cannot reopen a drawer closed during loading',async()=>{const f=ui();f.ids.task_panel.hidden=true;let resolve!:(v:any)=>void;f.api.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const pending=f.actions.toggleTaskPanel();f.actions.closeTaskPanel();resolve({items:[task],cursor:null});await pending;expect(f.ids.task_panel.hidden).toBe(true);expect(f.ids.task_list.children).toHaveLength(0);expect(f.ids.task_panel.getAttribute('aria-busy')).toBe('false');});
         it('pending receipts show an indicator without forcing the panel open or discarding the original intent',()=>{const f=ui();f.ids.task_panel.hidden=true;f.c.taskProtocol.prepare('/api/deploy?type=cmliu',{method:'POST',body:'{}'});f.c.renderPendingTaskSubmissions();expect(f.ids.task_panel.hidden).toBe(true);expect(f.ids.task_badge.hidden).toBe(false);expect(uiText(f.ids.task_pending)).toContain('原请求保留');f.actions.closeTaskPanel();expect(f.c.taskProtocol.pending()).toHaveLength(1);expect(f.api).not.toHaveBeenCalled();});
        });
    });

    describe('repair-frontend', () => {
        function ui(){const account='a'.repeat(32),restore=vi.fn(),button={},responses:any[]=[{targets:[{accountId:account,alias:'local',workerName:'demo',subdomainRotationAllowed:false}]}],apiFetch=vi.fn(async()=>{const r=responses.shift();if(r instanceof Error)throw r;return r;}),Swal={fire:vi.fn(async()=>({isConfirmed:true}))},c:any={$:()=>button,apiFetch,Swal,beginButtonBusy:vi.fn(()=>restore),setUiContent:vi.fn(),openWorkbench:vi.fn(),wbLog:vi.fn(),safeHtml:(s:string)=>s,trackAcceptedTask:vi.fn(()=>true),registerActions:()=>{},console:{error:vi.fn()},setTimeout:vi.fn()};vm.createContext(c);vm.runInContext(readFileSync('frontend/js/deploy.js','utf8'),c);return {c,account,restore,apiFetch,Swal,responses};}
        describe('1101 confirmation and accepted-task button cleanup, no browser',()=>{
         it('explicitly confirms preserving protected subdomains and restores the button after accepted ACK',async()=>{const f=ui();f.responses.push({status:'accepted',id:'task-1'});await f.c.fix1101('cmliu');expect(f.Swal.fire.mock.calls[0][0].html).toContain('保留中控账号子域名');expect(f.Swal.fire.mock.calls[0][0].html).toContain('含中控等受保护资源的账号保留原子域名');const body=JSON.parse(f.apiFetch.mock.calls[1][1].body);expect(body).toEqual({type:'cmliu',expectedTargets:[{accountId:f.account,workerName:'demo'}],preserveProtectedSubdomains:true});expect(f.restore).toHaveBeenCalledTimes(1);expect(f.c.trackAcceptedTask).toHaveBeenCalledTimes(1);expect(f.c.setTimeout).not.toHaveBeenCalled();});
         it('does not send any repair command when confirmation is cancelled',async()=>{const f=ui();f.Swal.fire.mockResolvedValue({isConfirmed:false});await f.c.fix1101('cmliu');expect(f.apiFetch).toHaveBeenCalledTimes(1);expect(f.c.beginButtonBusy).not.toHaveBeenCalled();});
         it('restores busy state on refusal and permits another explicitly confirmed attempt',async()=>{const f=ui();f.responses.push(new Error('INVALID'));await f.c.fix1101('cmliu');expect(f.restore).toHaveBeenCalledTimes(1);expect(f.c.wbLog).toHaveBeenCalledWith(expect.stringContaining('INVALID'),expect.any(String));});
        });
    });

    describe('repair-targets', () => {
        describe('repair target confirmation', () => {
            it('requires an explicit target inventory on HTTP requests', async () => {
                const response = await getRoute('POST', '/api/fix_1101')!(jsonReq('POST', 'https://test/api/fix_1101', { type: 'cmliu' }), mockEnv(mockKV()));
                expect(response.status).toBe(400);
            });
            it('rejects stale and malformed targets before upstream reads or mutations', async () => {
                const kv = mockKV({ [KV_KEYS.ACCOUNTS]: [{ accountId: 'a'.repeat(32), alias: 'target', apiToken: 'credential', workers_cmliu: ['new-worker'] }] });
                const fetcher = stubFetch([]);
                try {
                    for (const [expectedTargets, status] of [[[{ accountId: 'a'.repeat(32), workerName: 'old-worker' }], 409], [[null], 400]] as const) {
                        const response = await getRoute('POST', '/api/fix_1101')!(jsonReq('POST', 'https://test/api/fix_1101', { type: 'cmliu', expectedTargets }), mockEnv(kv));
                        expect(response.status).toBe(status);
                    }
                    expect(fetcher.calls).toHaveLength(0);
                    expect(kv._puts).toBe(0);
                    expect(kv._deletes).toEqual([]);
                } finally { fetcher.restore(); }
            });
        });
    });
});
