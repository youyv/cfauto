/** Configuration concurrency client. Drafts and lost-ACK request bytes stay only in
 * this tab's memory. No storage, credential digest, retry loop, or blind overwrite. */
export function createConfigProtocol({newKey,baseUrl}) {
    const accepted=new Map(),pins=new Map(),pending=new Map(),observed=new WeakMap();
    let enabled=false;
    const fail=(code,message)=>{const error=new Error(message);error.code=code;throw error;};
    const metadata=(generation,epoch,revision)=>{
        if(typeof generation!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(generation)||!Number.isSafeInteger(epoch)||epoch<0||!Number.isSafeInteger(revision)||revision<0)fail('AUTHORITY_REQUIRED','缺少有效的权威修订，未发送保存请求');
        return {generation,epoch,revision};
    };
    function domainFor(url,init={}) {
        const u=new URL(url,baseUrl());
        if(u.pathname==='/api/reliability/config'){
            const kind=u.searchParams.get('kind'),template=u.searchParams.get('template');
            if(kind&&template)return kind+':'+template;
            if(typeof init.body==='string'){try{const selector=JSON.parse(init.body)?.selector;if(selector&&typeof selector.kind==='string'){
                if(selector.kind==='template'&&typeof selector.template==='string')return 'template:'+selector.template;
                if(['variables','favorites','upstream','deploy'].includes(selector.kind)&&typeof selector.template==='string')return selector.kind+':'+selector.template;
                if(selector.kind==='accounts')return 'accounts';if(selector.kind==='auto')return 'autoConfig';if(selector.kind==='joey_nodes')return 'vars:joey';
            }}catch{ /* Server rejects the invalid body later. */ }}
            return null;
        }
        const types={ '/api/settings':'vars', '/api/favorites':'favorites', '/api/upstream':'upstream', '/api/deploy_config':'deploy' };
        if(u.pathname==='/api/accounts'||u.pathname==='/api/accounts/import')return 'accounts';
        if(u.pathname==='/api/auto_config')return 'autoConfig';
        if(Object.hasOwn(types,u.pathname))return types[u.pathname]+':'+u.searchParams.get('type');
        if(u.pathname==='/api/save_yxip'&&typeof init.body==='string'){try{if(JSON.parse(init.body).type==='joey_var')return 'vars:joey';}catch{ /* Server also rejects invalid JSON. */ }}
        return null;
    }
    function observe(url,data,headers) {
        if(data&&typeof data==='object'&&data.reliability?.protocol===1){
            enabled=true;const m=data.reliability;
            for(const [domain,rev] of Object.entries(m.revisions)){
                const value=domain==='accounts'?data.accounts:domain==='autoConfig'?data.autoConfig:domain.startsWith('vars:')?data.vars?.[domain.slice(5)]:domain.startsWith('deploy:')?data.deployConfigs?.[domain.slice(7)]:domain.startsWith('template:')?data.templateSettings?.[domain.slice(9)]:undefined;
                // Null values still have revision zero: retain their metadata on init.
                observed.set(data, {...observed.get(data),[domain]:metadata(m.generation,m.epoch,rev)});
                if(value&&typeof value==='object')observed.set(value,{[domain]:metadata(m.generation,m.epoch,rev)});
            }
            return;
        }
        const domain=domainFor(url);if(!domain)return;
        // Native authority config read returns its own CAS identity in the body.
        if(new URL(url,baseUrl()).pathname==='/api/reliability/config'&&data&&typeof data==='object'&&typeof data.generation==='string'&&Number.isSafeInteger(data.epoch)&&Number.isSafeInteger(data.revision)){
            enabled=true;const m=metadata(data.generation,data.epoch,data.revision);
            if(data.value&&typeof data.value==='object')observed.set(data.value,{[domain]:m});
            return;
        }
        if(headers.get('x-reliability-protocol')!=='1'){if(enabled)fail('AUTHORITY_REQUIRED','拒绝缺少权威修订的旧配置响应');return;}
        enabled=true;
        const generation=headers.get('x-config-generation'),epoch=headers.get('x-config-epoch'),revision=headers.get('x-config-revision');
        if(epoch===null||revision===null)fail('AUTHORITY_REQUIRED','缺少权威修订，保留当前草稿');
        const m=metadata(generation,Number(epoch),Number(revision));
        if(data&&typeof data==='object')observed.set(data,{[domain]:m});
        else fail('AUTHORITY_REQUIRED','配置视图格式不完整，保留当前草稿');
    }
    function accept(domain,data) {
        if(!enabled)return;
        const m=observed.get(data)?.[domain];if(!m)fail('AUTHORITY_REQUIRED','尚未读取该配置的权威修订');
        accepted.set(domain,{...m});
        if(pending.get(domain)?.conflict&&!pins.has(domain))pending.delete(domain); // Explicitly applied reload only.
    }
    function prepare(url,init={}) {
        const domain=domainFor(url,init);if(!enabled||!domain||(init.method||'GET').toUpperCase()!=='POST')return {init,ticket:null};
        const baseline=pins.get(domain)||accepted.get(domain);if(!baseline)fail('AUTHORITY_REQUIRED','请先读取配置再保存；不会猜测服务器修订');
        if(typeof init.body!=='string')fail('INVALID','保存请求必须使用冻结的 JSON');
        const path=new URL(url,baseUrl()).pathname+new URL(url,baseUrl()).search;
        let ticket=pending.get(domain);
        if(ticket&&(ticket.body!==init.body||ticket.path!==path))fail('SAVE_UNRESOLVED','上次保存结果尚未确认；请先重试原内容或读取并核对，不会替换未完成意图');
        if(ticket?.conflict)fail('CONFIG_CONFLICT','服务器配置已变化；草稿已保留，请明确重新读取并合并后保存');
        if(!ticket){ticket={domain,path,body:init.body,key:newKey(),baseline:{...baseline},conflict:false};pending.set(domain,ticket);}
        const headers=new Headers(init.headers||{});headers.set('X-Reliability-Protocol','1');headers.set('Idempotency-Key',ticket.key);headers.set('X-Config-Generation',ticket.baseline.generation);headers.set('X-Config-Epoch',String(ticket.baseline.epoch));headers.set('X-Config-Revision',String(ticket.baseline.revision));
        return {init:{...init,headers,body:ticket.body},ticket};
    }
    function finish(ticket,status,data) {
        if(!ticket||pending.get(ticket.domain)!==ticket)return;
        if(status===409){ticket.conflict=true;fail('CONFIG_CONFLICT','服务器配置已变化；草稿已保留，请明确重新读取并合并后保存');}
        if(status===428)fail('UPGRADE_REQUIRED','服务端要求新版配置协议；草稿已保留，请确认已部署版本');
        // These responses are validation/auth/method rejections before a config
        // transaction can commit. Unknown transport/server failures retain identity.
        if([400,401,403,405,413,415,422].includes(status)){if(pending.get(ticket.domain)===ticket)pending.delete(ticket.domain);return;}
        if(status<200||status>=300)return;
        if(!data||data.domain!==ticket.domain||data.generation!==ticket.baseline.generation||data.epoch!==ticket.baseline.epoch||data.revision!==ticket.baseline.revision+1)fail('SAVE_UNRESOLVED','保存回执不完整；请重试同一意图，不要改写配置');
        const next=metadata(data.generation,data.epoch,data.revision);accepted.set(ticket.domain,next);if(pins.has(ticket.domain))pins.set(ticket.domain,next);if(pending.get(ticket.domain)===ticket)pending.delete(ticket.domain);
    }
    function retry(domain) {
        const ticket=pending.get(domain);if(!ticket)fail('INVALID','没有待确认的配置保存');
        if(ticket.conflict)fail('CONFIG_CONFLICT','冲突不能重试覆盖，请明确重新读取并合并');
        return {url:ticket.path,init:{method:'POST',body:ticket.body}};
    }
    return {observe,accept,prepare,finish,retry,pending:()=>[...pending.values()].map(t=>({domain:t.domain,conflict:t.conflict})),isEnabled:()=>enabled,baseline:domain=>{const m=pins.get(domain)||accepted.get(domain);return m?{...m}:null;},pin:domain=>{if(accepted.has(domain))pins.set(domain,{...accepted.get(domain)});},release:domain=>pins.delete(domain)};
}
