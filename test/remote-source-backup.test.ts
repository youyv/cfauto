import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const {backup,active,stringField}=createRequire(import.meta.url)('../scripts/backup-worker-readonly.cjs');
const account='a'.repeat(32),version='12345678-abcd-1234-abcd-123456789012';
const deployment={deployments:[{id:'deployment1',versions:[{version_id:version,percentage:100}]}]};
const envelope=(result:unknown)=>Response.json({success:true,result});
async function fixture(changed=false) {
    const dir=await mkdtemp(path.join(tmpdir(),'cfauto-source-backup-test-'));
    const form=new FormData();form.append('../untrusted/worker.js',new Blob(['export default {};'],{type:'application/javascript'}),'../worker.js');
    const transport=vi.fn().mockResolvedValueOnce(envelope(deployment)).mockResolvedValueOnce(envelope({id:version,resources:{script_runtime:{compatibility_date:'2026-07-16'}}})).mockResolvedValueOnce(new Response(form)).mockResolvedValueOnce(envelope(changed?{deployments:[{...deployment.deployments[0],id:'new-deployment'}]}:deployment));
    const out=path.join(dir,'source');return {out,transport,options:{account,worker:'manager',out,transport,headers:{Authorization:'Bearer never-written-to-evidence'}}};
}
describe('remote source release preflight is read-only and non-destructive',()=>{
    it('extracts only named TOML strings',()=>{expect(stringField('name = "manager"','name')).toBe('manager');expect(stringField('oauth_token = "abc="','oauth_token')).toBe('abc=');expect(stringField('other = "not-token"','oauth_token')).toBeUndefined();});
    it('requires a single 100% active version',()=>{expect(()=>active({deployments:[{versions:[{version_id:version,percentage:50}]}]})).toThrow('ACTIVE_VERSION_NOT_UNAMBIGUOUS');});
    it('uses only fixed-host GET, saves all modules under safe names and verifies saved hashes',async()=>{
        const f=await fixture();const result=await backup(f.options);expect(result).toMatchObject({version,modules:1,localMatchesModule:false});
        for(const [url,init] of f.transport.mock.calls){expect(url).toMatch(/^https:\/\/api.cloudflare.com\/client\/v4\/accounts\//);expect(init).toMatchObject({method:'GET',redirect:'manual'});expect(init.body).toBeUndefined();}
        const manifest=JSON.parse(await readFile(path.join(f.out,'manifest.json'),'utf8'));expect(manifest.modules[0].file).toBe('module-000.bin');expect(await readFile(path.join(f.out,'module-000.bin'),'utf8')).toBe('export default {};');expect(JSON.stringify(manifest)).not.toContain('never-written');
        await expect(backup(f.options)).rejects.toThrow();expect(f.transport).toHaveBeenCalledTimes(4);
    });
    it('retains downloaded evidence but does not certify a drifting deployment',async()=>{
        const f=await fixture(true);await expect(backup(f.options)).rejects.toThrow('REMOTE_CHANGED_DURING_BACKUP');expect((await readFile(path.join(f.out,'content.multipart'))).length).toBeGreaterThan(0);await expect(readFile(path.join(f.out,'manifest.json'))).rejects.toThrow();
    });
    it('does not follow redirects or expose provider bodies as errors',async()=>{
        const f=await fixture();f.transport.mockReset().mockResolvedValue(new Response('sensitive-provider-text',{status:302,headers:{location:'https://evil.test'}}));await expect(backup(f.options)).rejects.toThrow(/^READ_FAILED_HTTP_302$/);expect(f.transport).toHaveBeenCalledTimes(1);
    });
});
