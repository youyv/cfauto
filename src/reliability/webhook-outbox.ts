import { fetchDirectWithTimeout } from '../lib/cloudflare-api';
import type { SqlDatabase } from './config-store';
import { SealedStore, type SealedContext } from './sealed-store';
import { canonical, identifier, ReliabilityError, sha256, type Json } from './protocol';

type State='queued'|'in_flight'|'delivered'|'rejected'|'unknown';
interface Notice extends Record<string,unknown> {id:string;task:string;generation:string;state:State;key_id:string}
interface Destination {url:string;provider:'wechat'|'dingtalk'|'feishu'}
const invalid=():never=>{throw new ReliabilityError('INVALID',400);};
const unavailable=():never=>{throw new ReliabilityError('NOT_READY',503);};
const ctx=(row:Pick<Notice,'id'|'generation'>,response=false):SealedContext=>({id:(response?'response_':'')+row.id,kind:'artifact',account:'webhook',generation:row.generation});
/** Explicit, narrow webhook contracts. Arbitrary hosts, redirects and 2xx-without-
 * provider acknowledgement are NOT supported. Never share the CF mutation journal. */
export function webhookDestination(value:string):Destination {
    if(typeof value!=='string' || value.length>8192)return invalid();
    let u:URL;try{u=new URL(value);}catch{return invalid();}
    if(u.protocol!=='https:' || u.username || u.password || u.hash || u.port)return invalid();
    const keys=[...u.searchParams.keys()];
    if(u.hostname==='qyapi.weixin.qq.com' && u.pathname==='/cgi-bin/webhook/send' && keys.length===1 && keys[0]==='key' && u.searchParams.get('key'))return {url:u.href,provider:'wechat'};
    if(u.hostname==='oapi.dingtalk.com' && u.pathname==='/robot/send' && keys.length===1 && keys[0]==='access_token' && u.searchParams.get('access_token'))return {url:u.href,provider:'dingtalk'};
    if(u.hostname==='open.feishu.cn' && /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(u.pathname) && !u.search)return {url:u.href,provider:'feishu'};
    return invalid();
}
/** Global-DO, internal-only completion notification outbox. All referenced snapshots,
 * responses and keys are retained. No retries or cleanup for uncertain external writes.
 * This component is deliberately not yet registered as a production Cron entry point. */
export class WebhookOutbox {
    private readonly transport:typeof fetch;
    private readonly timeoutMs:number;
    constructor(private readonly db:SqlDatabase,private readonly sealed:SealedStore,options:{transport?:typeof fetch;timeoutMs?:number}={}) {
        this.timeoutMs=options.timeoutMs??15000;
        if(!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs<1 || this.timeoutMs>60000)invalid();
        this.transport=options.transport??((url,init)=>fetchDirectWithTimeout(String(url),init,this.timeoutMs));
        db.rows('CREATE TABLE IF NOT EXISTS webhook_outbox (id TEXT PRIMARY KEY, task TEXT NOT NULL, generation TEXT NOT NULL, state TEXT NOT NULL, key_id TEXT NOT NULL, UNIQUE(task,generation))');
    }
    private completed(task:string,generation:string):void {
        const runs=this.db.rows<{generation:string;status:string;finished:number|null}>('SELECT generation,status,finished FROM deployment_runs WHERE task=?',task);
        const targets=this.db.rows<{state:string}>('SELECT state FROM dispatch_outbox WHERE task=?',task);
        if(!runs.length || !targets.length || runs.some(r=>r.generation!==generation || r.status!=='succeeded' || r.finished===null) || targets.some(t=>t.state!=='terminal'))unavailable();
    }
    private active(generation:string):boolean {
        const meta=this.db.rows<{generation:string;maintenance:number}>('SELECT generation,maintenance FROM config_meta WHERE id=1')[0];
        return meta?.generation===generation && meta.maintenance===0;
    }
    async enqueue(task:string,generation:string,url:string):Promise<{id:string;duplicate:boolean}> {
        identifier(task);identifier(generation);const destination=webhookDestination(url);
        this.completed(task,generation);
        const id='notice_'+await sha256(canonical([generation,task]));
        const text='[Worker中控] 部署任务 '+task+' 已验证完成。';
        const payload=destination.provider==='feishu'?{msg_type:'text',content:{text}}:{msgtype:'text',text:{content:text}};
        const value={destination,payload};
        const row={id,generation};
        // Encrypted immutable intent binds destination and message before queuing.
        await this.sealed.put(ctx(row),value as unknown as Json);
        if(canonical(await this.sealed.get(ctx(row)))!==canonical(value))throw new ReliabilityError('CONFLICT',409);
        return this.db.transaction(()=>{
            this.completed(task,generation);
            const old=this.db.rows<Notice>('SELECT * FROM webhook_outbox WHERE id=?',id)[0];
            if(old)return {id,duplicate:true};
            if(!this.active(generation))unavailable();
            const info=this.sealed.info(ctx(row));
            this.db.rows("INSERT INTO webhook_outbox VALUES (?,?,?,'queued',?)",id,task,generation,info.keyId);
            return {id,duplicate:false};
        });
    }
    private row(id:string):Notice {identifier(id);const row=this.db.rows<Notice>('SELECT * FROM webhook_outbox WHERE id=?',id)[0];if(!row)unavailable();return row;}
    inspect(id:string):{id:string;task:string;state:State} {const row=this.row(id);return {id:row.id,task:row.task,state:row.state};}
    /** Called on process recovery, never resets an uncertain send to queued. An
     * original still-live sender may subsequently persist its authenticated response. */
    recover():void {this.db.rows("UPDATE webhook_outbox SET state='unknown' WHERE state='in_flight'");}
    async send(id:string):Promise<ReturnType<WebhookOutbox['inspect']>> {
        const row=this.row(id);if(row.state!=='queued' || !this.active(row.generation))return this.inspect(id);
        const value=await this.sealed.get(ctx(row)) as any;
        const destination=webhookDestination(value?.destination?.url);
        if(destination.provider!==value.destination.provider || !value.payload)unavailable();
        const body=canonical(value.payload);
        const claimed=this.db.transaction(()=>{
            if(this.row(id).state!=='queued' || !this.active(row.generation))return false;
            this.completed(row.task,row.generation);
            this.db.rows("UPDATE webhook_outbox SET state='in_flight' WHERE id=?",id);return true;
        });
        if(!claimed)return this.inspect(id);
        const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
        const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('WEBHOOK_TIMEOUT'));},this.timeoutMs);});
        let state:State='unknown';
        try {
            const response=await Promise.race([this.transport(destination.url,{method:'POST',headers:{'Content-Type':'application/json'},body,redirect:'manual',signal:controller.signal}),deadline]);
            if(response.redirected || response.status!==200 || Number(response.headers.get('content-length'))>16384){void response.body?.cancel().catch(()=>{});throw new Error('WEBHOOK_RESPONSE');}
            const reader=response.body?.getReader();if(!reader)throw new Error('WEBHOOK_RESPONSE');
            let bytes=0;const parts:Uint8Array[]=[];
            try{while(true){const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;bytes+=chunk.value.length;if(bytes>16384)throw new Error('WEBHOOK_RESPONSE');parts.push(chunk.value);}}finally{void reader.cancel().catch(()=>{});}
            const buffer=new Uint8Array(bytes);let offset=0;for(const part of parts){buffer.set(part,offset);offset+=part.length;}
            const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer);
            let parsed:any;try{parsed=JSON.parse(text);}catch{throw new Error('WEBHOOK_RESPONSE');}
            const code=parsed?.[destination.provider==='feishu'?'code':'errcode'];
            if(!Number.isSafeInteger(code))throw new Error('WEBHOOK_RESPONSE');
            await this.sealed.put(ctx(row,true),{status:200,body:text});
            state=code===0?'delivered':'rejected';
        } catch { state='unknown'; }
        finally {if(timer!==undefined)clearTimeout(timer);controller.abort();}
        this.db.rows("UPDATE webhook_outbox SET state=? WHERE id=? AND state IN ('in_flight','unknown')",state,id);
        return this.inspect(id);
    }
}
