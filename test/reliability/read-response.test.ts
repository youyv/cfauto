import {describe,it,expect,vi,afterEach} from 'vitest';
import {boundedReadResponse} from '../../src/reliability/read-response';
import {withReadOnlyNetwork} from '../../src/reliability/read-only-network';
import {fetchWithTimeout} from '../../src/lib/cloudflare-api';
afterEach(()=>vi.unstubAllGlobals());
describe('bounded external response body',()=>{
 it('enforces streamed byte size even if content-length lies',async()=>{const response=new Response(new Uint8Array(101),{headers:{'content-length':'1'}});await expect(boundedReadResponse(response,Date.now()+1000,100)).rejects.toThrow('NOT_READY');});
 it('times out after headers without waiting forever for a stalled body',async()=>{const cancel=vi.fn(),stream=new ReadableStream({cancel});await expect(boundedReadResponse(new Response(stream),Date.now()+15,100)).rejects.toThrow('NOT_READY');expect(cancel).toHaveBeenCalled();});
 it('keeps the same full-body limit in ordinary helper calls under read-only scope',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array(2*1024*1024+1))));await expect(withReadOnlyNetwork({accounts:['a'.repeat(32)],assertCurrent:()=>{}},()=>fetchWithTimeout('https://api.cloudflare.com/client/v4/accounts/'+ 'a'.repeat(32)))).rejects.toThrow('NOT_READY');});
 it('preserves successful bytes/status without stale transport encoding headers',async()=>{const r=await boundedReadResponse(new Response('read-only',{headers:{'content-encoding':'gzip','content-length':'100'}}),Date.now()+1000);expect(await r.text()).toBe('read-only');expect(r.headers.has('content-encoding')).toBe(false);expect(r.headers.has('content-length')).toBe(false);});
});
