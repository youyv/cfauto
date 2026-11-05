/* Offline, read-only integrity inspection. No network, credentials, writes or activation. */
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const Module = require('node:module');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
let adapter;
function sourceAdapter() {
    if (!adapter) {
        // Bundle only this trusted local project's TypeScript; never load code from
        // a backup or evaluate downloaded SQL. Existing dependency, no installation.
        const root = path.resolve(__dirname, '..');
        const {buildSync} = require('esbuild');
        const result = buildSync({entryPoints:[path.join(root,'src/reliability/legacy-generation-source.ts')],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
        const compiled = new Module(path.join(root,'scripts','.offline-legacy-adapter.cjs'),module);
        compiled.filename = path.join(root,'scripts','.offline-legacy-adapter.cjs');
        compiled.paths = module.paths;
        compiled._compile(result.outputFiles[0].text,compiled.filename);
        adapter = compiled.exports.legacyGenerationSource;
    }
    return adapter;
}
async function inspectLegacyBackup({directory,manifestSha256,account,worker,namespace,version}) {
    if (typeof directory !== 'string' || !/^[a-f0-9]{64}$/.test(manifestSha256)) fail('INVALID_INPUT');
    const base = await fs.realpath(path.resolve(directory));
    async function file(name,max,exact) {
        if (!/^(manifest\.json|value-[0-9]{6}\.bin)$/.test(name)) fail('INVALID_FILENAME');
        const filename = path.join(base,name),stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || (exact !== undefined && stat.size !== exact) || path.dirname(await fs.realpath(filename)) !== base) fail('INVALID_LOCAL_FILE');
        const bytes = await fs.readFile(filename);if(bytes.length>max || (exact!==undefined && bytes.length!==exact))fail('INVALID_LOCAL_FILE');return bytes;
    }
    const raw = await file('manifest.json',4*1024*1024);
    if (hash(raw) !== manifestSha256) fail('MANIFEST_HASH_MISMATCH');
    let manifest;try { manifest=JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_MANIFEST'); }
    const source = await sourceAdapter()(new Uint8Array(raw),manifestSha256,{account,worker,namespace,version,deployment:manifest.deployment},(name,size)=>file(name,25*1024*1024,size));
    const accounts=source.data.records.find(r=>r.domain==='accounts')?.value;
    return {mode:'offline_integrity_only',manifestSha256,version,files:manifest.entries.length,totalBytes:manifest.totalBytes,businessDomains:source.data.records.length,accounts:Array.isArray(accounts)?accounts.length:null,credentialsValidated:false,migrationReady:false,activationReady:false,blockers:source.blockers};
}
module.exports={inspectLegacyBackup};
if(require.main===module)(async()=>{
    const args=process.argv.slice(2),opts={};if(args.length!==12)fail('USAGE_BACKUP_HASH_ACCOUNT_WORKER_NAMESPACE_VERSION');
    for(let i=0;i<args.length;i+=2){if(!['--backup','--manifest-sha256','--account','--worker','--namespace','--version'].includes(args[i])||opts[args[i]])fail('INVALID_OPTIONS');opts[args[i]]=args[i+1];}
    console.log(JSON.stringify(await inspectLegacyBackup({directory:opts['--backup'],manifestSha256:opts['--manifest-sha256'],account:opts['--account'],worker:opts['--worker'],namespace:opts['--namespace'],version:opts['--version']}),null,2));
})().catch(error=>{const code=/^[A-Z0-9_]+$/.test(error.message)?error.message:'LOCAL_VALIDATION_FAILED';console.error('Offline backup inspection failed: '+code);process.exitCode=1;});
