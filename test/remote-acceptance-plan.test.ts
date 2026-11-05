import {describe,it,expect,vi,afterEach} from 'vitest';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const {prepareRemoteAcceptance}=createRequire(import.meta.url)('../scripts/prepare-remote-acceptance.cjs');
const worker='cfauto-accept-0123456789abcdef';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
async function fixture(code='class ProductionCoordinator {}; export {ProductionCoordinator}; export default {};'){
 const root=await mkdtemp(path.join(tmpdir(),'cfauto-acceptance-plan-')),validationDir=path.join(root,'.wrangler','validation'),out=path.join(root,'.wrangler','candidate');
 await mkdir(path.join(root,'dist'));await mkdir(validationDir,{recursive:true});await writeFile(path.join(root,'dist','worker.js'),code);
 await writeFile(path.join(validationDir,'artifact-hashes.json'),JSON.stringify({'dist/worker.js':hash(code)}));
 for(const name of ['type-final-2.json','build-final-2.json','verify-final-2.json','credentials-final.json','full-final-2.json','runtime-final.json'])await writeFile(path.join(validationDir,name),JSON.stringify({code:0,stdout:name==='build-final-2.json'?hash(code):'local fixture validation'}));
 return {root,validationDir,out,worker,code};
}
afterEach(()=>vi.unstubAllGlobals());
describe('isolated remote acceptance preparation is not permission to deploy',()=>{
 it('pins the exact validated production artifact, protects manager resources and performs no network',async()=>{const f=await fixture(),transport=vi.fn(()=>{throw Error('NETWORK_NOT_ALLOWED');});vi.stubGlobal('fetch',transport);const result=await prepareRemoteAcceptance(f);expect(result).toMatchObject({worker,artifactSha256:hash(f.code),localGateLogs:6,remotePublicationAllowed:false,productionDeploymentAllowed:false});const plan=JSON.parse(await readFile(path.join(f.out,'acceptance-plan.json'),'utf8'));expect(plan.target).toMatchObject({worker,namespace:null,mustCreateFreshWorker:true,mustCreateFreshNamespace:true});expect(plan.protectedProduction).toEqual({account:'fb86300faed47e7052b380db19fe844d',worker:'manager',namespace:'4c1c769926a740c996b42bbba137f824'});expect(plan.runtime).toMatchObject({compatibility_date:'2026-07-16',compatibility_flags:['nodejs_als'],class_name:'ProductionCoordinator'});expect(plan.runtimePolicy).toMatchObject({initialGeneration:null,maintenance:true,cron:[],customRoutes:[],customDomains:[],versionURLs:false});expect(plan.secretPolicy.maintenancePermissions).toEqual(['inspect']);expect(plan.allowedMaintenanceActions).toEqual(['status','audit','audit_list']);expect(await readFile(path.join(f.out,'candidate-worker.js'),'utf8')).toBe(f.code);expect(transport).not.toHaveBeenCalled();expect(await readdir(f.out)).not.toContain('wrangler.toml');});
 it.each(['manager','other-production-worker','cfauto-accept-local-test'])('rejects nonisolated worker target %s',async name=>{const f=await fixture();await expect(prepareRemoteAcceptance({...f,worker:name})).rejects.toThrow('INVALID_ISOLATED_WORKER');await expect(readdir(f.out)).rejects.toThrow();});
 it('rejects an artifact changed after its recorded validation',async()=>{const f=await fixture();await writeFile(path.join(f.validationDir,'artifact-hashes.json'),JSON.stringify({'dist/worker.js':'0'.repeat(64)}));await expect(prepareRemoteAcceptance(f)).rejects.toThrow('VALIDATED_ARTIFACT_MISMATCH');await expect(readdir(f.out)).rejects.toThrow();});
 it('does not pass a red local gate or a mismatched build log',async()=>{const f=await fixture();await writeFile(path.join(f.validationDir,'runtime-final.json'),JSON.stringify({code:1}));await expect(prepareRemoteAcceptance(f)).rejects.toThrow('LOCAL_GATE_FAILED');await writeFile(path.join(f.validationDir,'runtime-final.json'),JSON.stringify({code:0}));await writeFile(path.join(f.validationDir,'build-final-2.json'),JSON.stringify({code:0,stdout:'different artifact'}));await expect(prepareRemoteAcceptance(f)).rejects.toThrow('BUILD_LOG_MISMATCH');});
 it.each(['export default {};','export class LocalCoordinator {}; export default {};','export class ProductionCoordinator {}; export class LocalCoordinator {}; export default {};'])('rejects missing production class or local fixture exports',async code=>{const f=await fixture(code);await expect(prepareRemoteAcceptance(f)).rejects.toThrow('UNEXPECTED_BUNDLE_EXPORTS');});
 it('rejects evidence/output paths outside the workspace evidence root',async()=>{const f=await fixture();await expect(prepareRemoteAcceptance({...f,validationDir:path.join(f.root,'outside')})).rejects.toThrow('PATH_OUTSIDE_ROOT');await expect(prepareRemoteAcceptance({...f,out:path.join(f.root,'outside')})).rejects.toThrow('PATH_OUTSIDE_ROOT');});
 it('never overwrites an earlier candidate directory',async()=>{const f=await fixture();await prepareRemoteAcceptance(f);const before=await readFile(path.join(f.out,'candidate-worker.js'));await expect(prepareRemoteAcceptance(f)).rejects.toThrow();expect(await readFile(path.join(f.out,'candidate-worker.js'))).toEqual(before);});
});
