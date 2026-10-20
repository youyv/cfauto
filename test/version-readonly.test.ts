import {afterEach,describe,it,expect,vi} from 'vitest';
import {mockEnv,mockKV,readKV} from './helpers';
import {KV_KEYS} from '../src/config/templates';
import {fetchGithubVersion} from '../src/lib/auto-update';
const sha='a'.repeat(40),date='2026-10-01T00:00:00Z';
afterEach(()=>vi.unstubAllGlobals());
function fixture(workers:string[]){const config={mode:'fixed',currentSha:sha,deployTime:date},kv=mockKV({[KV_KEYS.ACCOUNTS]:[{accountId:'b'.repeat(32),alias:'a',email:'',globalKey:'',apiToken:'',workers_cmliu:workers}],[KV_KEYS.deployConfig('cmliu')]:config,[KV_KEYS.ghInfoCache('cmliu')]:{branch:'main',path:'_worker.js'}});vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.endsWith('/'+sha)?{commit:{committer:{date}}}:[{sha,commit:{committer:{date},message:'test'}}])));return {kv,env:mockEnv(kv),config};}
describe('version GET is never a config write',()=>{
 it('missing workers affects the displayed version but never resets retained deployment config',async()=>{const f=fixture([]),v=await fetchGithubVersion(f.env,'cmliu');expect(v.localSha).toBeNull();expect(readKV(f.kv,KV_KEYS.deployConfig('cmliu'))).toEqual(f.config);expect(f.kv._puts).toBe(0);});
 it('commit date lookup is a response-only observation, not a blind read-side KV backfill',async()=>{const f=fixture(['demo']),v=await fetchGithubVersion(f.env,'cmliu');expect(v.commitDate).toBe(date);expect(readKV(f.kv,KV_KEYS.deployConfig('cmliu'))).toEqual(f.config);expect(f.kv._puts).toBe(0);});
});
