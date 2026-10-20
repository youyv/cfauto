/* Read-only release preflight. No deploy, Secret write, KV write, cleanup or shell commands. */
const fs = require('node:fs/promises');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
function stringField(text, name) {
    const match = text.split(/\r?\n/).map(line => line.match(/^([a-z_]+)\s*=\s*("[^"\r\n]*")\s*$/)).find(m => m && m[1] === name);
    return match ? JSON.parse(match[2]) : undefined;
}
function active(result) {
    const deployment = result?.deployments?.[0];
    if (!deployment || !Array.isArray(deployment.versions) || deployment.versions.length !== 1 || deployment.versions[0].percentage !== 100 || !/^[a-f0-9-]{36}$/.test(deployment.versions[0].version_id)) fail('ACTIVE_VERSION_NOT_UNAMBIGUOUS');
    return { deployment: deployment.id, version: deployment.versions[0].version_id };
}
async function backup({ account, worker, out, headers, transport = fetch, localFile }) {
    if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) fail('INVALID_TARGET');
    out = path.resolve(out);
    // A fresh directory is mandatory. Never overwrite an earlier backup/evidence set.
    await fs.mkdir(out, { mode: 0o700 });
    if (process.platform === 'win32') {
        const identity = cp.execFileSync('whoami.exe', [], { windowsHide:true, encoding:'utf8' }).trim();
        cp.execFileSync('icacls.exe', [out, '/inheritance:r', '/grant:r', identity + ':(OI)(CI)F'], { windowsHide:true, stdio:'pipe' });
    }
    const base = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/' + worker;
    const save = (name, bytes) => fs.writeFile(path.join(out,name),bytes,{flag:'wx',mode:0o600});
    async function get(suffix) {
        const response = await transport(base + suffix, {method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(30000)});
        if (!response.ok || response.redirected) fail('READ_FAILED_HTTP_' + response.status);
        const reader = response.body?.getReader(); if (!reader) fail('EMPTY_RESPONSE');
        const chunks=[];let size=0;
        try { while(true) { const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>20*1024*1024)fail('READ_TOO_LARGE');chunks.push(Buffer.from(chunk.value)); } }
        finally { void reader.cancel().catch(()=>{}); }
        return { bytes:Buffer.concat(chunks),headers:Object.fromEntries(response.headers) };
    }
    async function json(suffix, filename) {
        const data=await get(suffix);const body=JSON.parse(data.bytes.toString('utf8'));
        if(body?.success!==true)fail('API_READ_REJECTED');await save(filename,data.bytes);return body.result;
    }
    const before=active(await json('/deployments','deployments-before.json'));
    const version=await json('/versions/'+before.version,'version.json');
    if(version.id!==before.version)fail('VERSION_MISMATCH');
    const content=await get('/content/v2');await save('content.multipart',content.bytes);await save('content-headers.json',JSON.stringify(content.headers,null,2));
    const after=active(await json('/deployments','deployments-after.json'));
    if(JSON.stringify(before)!==JSON.stringify(after))fail('REMOTE_CHANGED_DURING_BACKUP');
    const modules=[];
    if((content.headers['content-type']||'').toLowerCase().startsWith('multipart/form-data')) {
        const form=await new Response(content.bytes,{headers:content.headers}).formData();let ordinal=0;
        for(const [name,value] of form.entries()) {
            const bytes=Buffer.from(typeof value==='string'?value:await value.arrayBuffer());
            const file='module-'+String(ordinal++).padStart(3,'0')+'.bin';await save(file,bytes);
            modules.push({name,filename:typeof value==='string'?null:value.name,type:typeof value==='string'?'text':value.type,file,bytes:bytes.length,sha256:hash(bytes)});
        }
    } else {
        await save('module-000.bin',content.bytes);modules.push({name:content.headers['cf-entrypoint']||'raw',file:'module-000.bin',bytes:content.bytes.length,sha256:hash(content.bytes)});
    }
    if(!modules.length)fail('EMPTY_MODULES');
    const local=localFile?hash(await fs.readFile(localFile)):null;
    const manifest={schema:1,readOnly:true,account,worker,capturedAt:new Date().toISOString(),...before,compatibility:version.resources?.script_runtime||null,contentSha256:hash(content.bytes),modules,localSha256:local,localMatchesModule:local!==null&&modules.some(m=>m.sha256===local)};
    await save('manifest.json',JSON.stringify(manifest,null,2));
    // Verify saved raw bytes and extracted parts; never call a backup verified just
    // because the GET returned 200. This is source backup, NOT a KV/data migration backup.
    if(hash(await fs.readFile(path.join(out,'content.multipart')))!==manifest.contentSha256)fail('BACKUP_HASH_MISMATCH');
    for(const m of modules)if(hash(await fs.readFile(path.join(out,m.file)))!==m.sha256)fail('BACKUP_HASH_MISMATCH');
    return {directory:out,version:before.version,deployment:before.deployment,modules:modules.length,localMatchesModule:manifest.localMatchesModule};
}
module.exports={backup,active,stringField};
if(require.main===module)(async()=>{
    const args=process.argv.slice(2),opts={};
    if(args.length!==6)fail('USAGE_CONFIG_AUTH_FILE_OUT');
    for(let i=0;i<args.length;i+=2){if(!['--config','--auth-file','--out'].includes(args[i])||opts[args[i]])fail('INVALID_OPTIONS');opts[args[i]]=args[i+1];}
    const config=await fs.readFile(opts['--config'],'utf8');
    const auth=await fs.readFile(opts['--auth-file'],'utf8');
    const token=process.env.CLOUDFLARE_API_TOKEN||process.env.CF_API_TOKEN||stringField(auth,'oauth_token');
    if(!token)fail('EXISTING_AUTH_UNAVAILABLE');
    const result=await backup({account:stringField(config,'account_id'),worker:stringField(config,'name'),out:opts['--out'],headers:{Authorization:'Bearer '+token},localFile:path.resolve(path.dirname(opts['--config']),'dist/worker.js')});
    console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error('Read-only source backup failed: '+(/^[A-Z0-9_]+$/.test(error.message)?error.message:'LOCAL_OR_NETWORK_ERROR'));process.exitCode=1;});
