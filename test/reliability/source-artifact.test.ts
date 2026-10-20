import { describe, expect, it, vi } from 'vitest';
import { loadSourceArtifact, MAX_SOURCE_BYTES } from '../../src/reliability/source-artifact';
import { sha256 } from '../../src/reliability/protocol';
const commit = 'a'.repeat(40), code = 'export default {fetch(){return new Response("fixed")}}';
const request = () => ({ template: 'cmliu', selection: { path: 'src/my worker.js', branch: 'release/stable' }, ref: 'latest' });
function transport() { return vi.fn().mockResolvedValueOnce(Response.json({ sha: commit })).mockResolvedValueOnce(new Response(code)); }
describe('fixed-repository immutable source download', () => {
    it('resolves full commit, encodes path/ref, never sends token to raw host', async () => {
        const fetcher = transport(); const result = await loadSourceArtifact(request(), { transport: fetcher, token: 'never-print-this' });
        expect(result).toEqual({ template:'cmliu',repository:'cmliu/edgetunnel',path:'src/my worker.js',commit,code,digest:await sha256(code) });
        expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['https://api.github.com/repos/cmliu/edgetunnel/commits/release%2Fstable','https://raw.githubusercontent.com/cmliu/edgetunnel/'+commit+'/src/my%20worker.js']);
        expect(fetcher.mock.calls[0][1]).toMatchObject({method:'GET',redirect:'manual',headers:{Authorization:'Bearer never-print-this'}});
        expect(fetcher.mock.calls[1][1].headers.Authorization).toBeUndefined();
    });
    it('freezes input before the first await and uses explicit defaults without cache fallback', async () => {
        const input = request(), fetcher = transport(); const pending = loadSourceArtifact(input, {transport:fetcher}); input.selection.path = 'other.js';input.template='ech';
        expect((await pending).path).toBe('src/my worker.js');
        const defaults=transport(); await loadSourceArtifact({template:'joey',selection:{path:'',branch:''},ref:commit},{transport:defaults});
        expect(defaults.mock.calls[1][0]).toContain('/byJoey/cfnew/'+commit+'/');
    });
    it.each([
        {template:'__proto__'}, {template:'other'}, {repository:'evil/repo'}, {ref:'abc123'}, {ref:['a'.repeat(40)]},
        {selection:{path:'https://evil.test/code',branch:'main'}}, {selection:{path:'../code',branch:'main'}}, {selection:{path:'%2fsecret',branch:'main'}}, {selection:{path:'safe',branch:'../main'}}
    ])('rejects invalid or attacker-selected source before network: %j', async patch => {
        const fetcher=vi.fn(); await expect(loadSourceArtifact({...request(),...patch} as any,{transport:fetcher})).rejects.toThrow('INVALID');expect(fetcher).not.toHaveBeenCalled();
    });
    it.each([null,{}, {sha:'a'.repeat(7)},{sha:'b'.repeat(40)}])('rejects invalid/mismatched explicit commit %j', async value=>{
        const fetcher=vi.fn().mockResolvedValueOnce(Response.json(value));await expect(loadSourceArtifact({...request(),ref:commit},{transport:fetcher})).rejects.toThrow('NOT_READY');expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each([new Response(null,{status:302,headers:{location:'https://evil.test'}}),new Response('error',{status:500})])('does not follow redirects or fallback after upstream errors',async response=>{
        const fetcher=vi.fn().mockResolvedValueOnce(response);await expect(loadSourceArtifact(request(),{transport:fetcher})).rejects.toThrow('NOT_READY');expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['','  ','<!DOCTYPE html><html>not code</html>'])('rejects empty/HTML download %j',async body=>{
        const fetcher=vi.fn().mockResolvedValueOnce(Response.json({sha:commit})).mockResolvedValueOnce(new Response(body));await expect(loadSourceArtifact(request(),{transport:fetcher})).rejects.toThrow('NOT_READY');
    });
    it('bounds streamed bytes with absent/lying Content-Length',async()=>{
        const fetcher=vi.fn().mockResolvedValueOnce(Response.json({sha:commit})).mockResolvedValueOnce(new Response('x'.repeat(MAX_SOURCE_BYTES+1),{headers:{'content-length':'1'}}));
        await expect(loadSourceArtifact(request(),{transport:fetcher})).rejects.toThrow('NOT_READY');
    });
    it('rejects invalid UTF-8 instead of silently changing deployed bytes',async()=>{
        const fetcher=vi.fn().mockResolvedValueOnce(Response.json({sha:commit})).mockResolvedValueOnce(new Response(new Uint8Array([0xff])));
        await expect(loadSourceArtifact(request(),{transport:fetcher})).rejects.toThrow('NOT_READY');
    });
    it('deadline covers an uncooperative response body and does not leak upstream text',async()=>{
        const fetcher=vi.fn().mockResolvedValue(new Response(new ReadableStream({start(){}})));
        await expect(loadSourceArtifact(request(),{transport:fetcher,timeoutMs:10})).rejects.toThrow(/^NOT_READY$/);
    });
});

describe('legacy short commit input resolves before immutable download',()=>{
 it.each(['a'.repeat(7),'A'.repeat(12),'a'.repeat(39),'A'.repeat(40)])('expands %s through GitHub and never downloads from an abbreviated ref',async ref=>{const fetcher=transport();const result=await loadSourceArtifact({...request(),ref},{transport:fetcher});expect(result.commit).toBe(commit);expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/cmliu/edgetunnel/commits/'+ref.toLowerCase());expect(fetcher.mock.calls[1][0]).toContain('/'+commit+'/');});
 it('rejects a full response that does not match the requested prefix',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(Response.json({sha:'b'.repeat(40)}));await expect(loadSourceArtifact({...request(),ref:'a'.repeat(7)},{transport:fetcher})).rejects.toThrow('NOT_READY');expect(fetcher).toHaveBeenCalledTimes(1);});
 it('rejects ambiguous prefixes before any raw download',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(Response.json({message:'ambiguous'},{status:422}));await expect(loadSourceArtifact({...request(),ref:'a'.repeat(7)},{transport:fetcher})).rejects.toThrow('NOT_READY');expect(fetcher).toHaveBeenCalledTimes(1);});
});

describe('source reference validation remains strict', () => {
    it.each(['', 'abc123', 'a'.repeat(41), 'abcdefg', 'main', '../aaaaaaa', 'aaaaaaa/..', ' aaaaaaa', 'aaaaaaa ', 'LATEST'])('rejects invalid ref %j without network', async ref => {
        const fetcher = vi.fn();
        await expect(loadSourceArtifact({...request(), ref}, {transport:fetcher})).rejects.toThrow('INVALID');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('rejects an uppercase GitHub SHA response rather than weakening artifact identity', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(Response.json({sha:commit.toUpperCase()}));
        await expect(loadSourceArtifact({...request(), ref:commit.slice(0,7)}, {transport:fetcher})).rejects.toThrow('NOT_READY');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
