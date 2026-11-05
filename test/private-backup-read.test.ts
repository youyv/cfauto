import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
const req=createRequire(import.meta.url),{privateDirectory,assertPrivate}=req('../scripts/maintenance-client.cjs'),{restrictedRead}=req('../scripts/verify-cutover-backup.cjs');
async function fixture(){const base=path.join(await mkdtemp(path.join(tmpdir(),'cfauto-private-backup-read-')),'private');await privateDirectory(base);const file=path.join(base,'value-000000.bin');await writeFile(file,'fake-test-data-only',{mode:0o600});return {base,file};}
describe('read-only compatibility for inherited private backup ACLs',()=>{
 it('accepts an inherited owner-only file without making the existing strict checker permissive',async()=>{const f=await fixture();expect((await restrictedRead(f.base,'value-000000.bin')).toString()).toBe('fake-test-data-only');if(process.platform==='win32')await expect(assertPrivate(f.file)).rejects.toThrow('PRIVATE_ACL_REQUIRED');},20000);
 it('still rejects a file readable by another principal even in a private parent',async()=>{const f=await fixture();if(process.platform==='win32')await new Promise<void>((resolve,reject)=>execFile('icacls.exe',[f.file,'/grant','*S-1-1-0:R'],{windowsHide:true},e=>e?reject(e):resolve()));else await chmod(f.file,0o644);await expect(restrictedRead(f.base,'value-000000.bin')).rejects.toThrow();},20000);
});
