import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const helper=require('../scripts/private-path.cjs');
describe('Windows ACL helper environment isolation',()=>{
 it('removes only case-insensitive PSModulePath from a copied environment',()=>{
  const source={PSModulePath:'incompatible',psmodulepath:'other',Path:'keep',USERPROFILE:'keep-home',CUSTOM:'keep-custom'};
  expect(helper.systemPowerShellEnvironment(source)).toEqual({Path:'keep',USERPROFILE:'keep-home',CUSTOM:'keep-custom'});
  expect(source.PSModulePath).toBe('incompatible');
 });
 it('checks real host-private Unicode paths; Windows also isolates poisoned module paths',async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'cfauto-acl-env-'));
  const dir=path.join(base,'中文 路径');await fs.mkdir(dir);
  if(process.platform!=='win32'){
   const {assertPrivate}=require('../scripts/maintenance-client.cjs');
   await fs.chmod(dir,0o700);await assertPrivate(dir);
   await expect(helper.windowsPrivatePath(dir,'check')).rejects.toThrow('WINDOWS_ONLY');
   await fs.chmod(dir,0o755);await expect(assertPrivate(dir)).rejects.toThrow('PRIVATE_PERMISSIONS_REQUIRED');
   return; // Real POSIX permission checks above, not a skipped Windows-ACL claim.
  }
  const source=`const p=require(${JSON.stringify(path.resolve('scripts/private-path.cjs'))});(async()=>{await p.windowsPrivatePath(process.argv[1],'directory');await p.windowsPrivatePath(process.argv[1],'check');console.log('PRIVATE_OK')})().catch(()=>{console.error('PRIVATE_FAILED');process.exitCode=1})`;
  const child=spawnSync(process.execPath,['-e',source,dir],{env:{...process.env,PSModulePath:process.env.PSModulePath || path.join(dir,'nonexistent-modules')},windowsHide:true,encoding:'utf8',timeout:30000});
  expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);expect(child.stdout.trim()).toBe('PRIVATE_OK');
 },40000);
});
