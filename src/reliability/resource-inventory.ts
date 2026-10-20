import { cf, fetchWithTimeout, getAuthHeaders } from '../lib/cloudflare-api';
import { accountId, invalid, workerName, type BusinessOperation } from './business-command';
import { ReliabilityError } from './protocol';

/** A binding proves a reference, not ownership. Never infer absence from malformed rows. */
export function bindingNamespaces(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 256) return invalid();
    const names = new Set<string>(), ids = new Set<string>();
    for (const row of value) {
        if (!row || typeof row !== 'object' || typeof row.name !== 'string' || !row.name || names.has(row.name) || typeof row.type !== 'string') invalid();
        names.add(row.name);
        if (row.type === 'kv_namespace') { accountId(row.namespace_id); ids.add(row.namespace_id); }
        else if (row.type === 'durable_object_namespace') {
            // The real bindings API returns namespace_id for DOs too. It is not a
            // KV reference and must never authorize (or prevent unrelated) KV deletion.
            if (typeof row.class_name !== 'string' || !row.class_name || row.class_name.length > 256 || /[\x00-\x1f\x7f]/.test(row.class_name)) invalid();
            if (Object.hasOwn(row,'namespace_id')) accountId(row.namespace_id);
            for (const key of ['script_name','environment']) if (Object.hasOwn(row,key) && (typeof row[key] !== 'string' || row[key].length > 256 || /[\x00-\x1f\x7f]/.test(row[key]))) invalid();
        } else if (Object.hasOwn(row,'namespace_id')) invalid();
    }
    return [...ids].sort();
}
export type InventoryTransport = (url: string, init: RequestInit, timeout: number) => Promise<Response>;
/** Fixed Cloudflare GET only; redirects cannot send credentials to an arbitrary host. */
export async function planRemovalNamespaces(account: string, worker: string, credential: BusinessOperation['credential'], transport: InventoryTransport = fetchWithTimeout): Promise<string[]> {
    accountId(account); workerName(worker);
    const controller=new AbortController(); let reader:ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>{});reject(new ReliabilityError('NOT_READY',503));},15000);});
    try { return await Promise.race([timeout,(async()=>{
    const response = await transport(cf.workerBindings(account,worker), {method:'GET',headers:getAuthHeaders(credential),redirect:'error',signal:controller.signal},15000);
    if (!response.ok || !response.body) throw new ReliabilityError('NOT_READY',503);
    reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
    try {
        for (;;) {
            const {done,value}=await reader.read(); if(done) break;
            size+=value.byteLength; if(size>262144) throw new ReliabilityError('NOT_READY',503);
            chunks.push(value);
        }
    } finally { void reader.cancel().catch(()=>{}); }
    const bytes=new Uint8Array(size); let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let body:any;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}catch{throw new ReliabilityError('NOT_READY',503);}
    if(body?.success!==true) throw new ReliabilityError('NOT_READY',503);
    const ids=bindingNamespaces(body.result); if(ids.length>49) invalid(); return ids;
    })()]); } catch { throw new ReliabilityError('NOT_READY',503); } finally { clearTimeout(timer!);controller.abort();void reader?.cancel().catch(()=>{}); }
}
