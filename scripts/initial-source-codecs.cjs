/* Compile ONLY trusted current-worktree codecs. Never compile a backup, source
 * artifact or downloaded SQL. No network, deploy or approval operation. */
const path=require('node:path'),fs=require('node:fs'),Module=require('node:module');
let codecs;
function localInitialCodecs(){
 if(codecs)return codecs;
 const root=path.resolve(__dirname,'..'),source=path.join(root,'src/reliability/legacy-generation-source.ts');
 // Export the existing strict lexical JSON reader in memory; do not edit the
 // production module or invent a second, weaker backup JSON decoder.
 const text=fs.readFileSync(source,'utf8')+[
  '\nexport {parse as parseStrictBackupJson};',
  "export {legacyBusinessDomain,prepareGenerationData} from './generation-data';",
  "export {TEMPLATES,KV_KEYS} from '../config/templates';",
  "export {encryptKey} from '../lib/crypto-utils';",
  "export {SealedStore} from './sealed-store';",
  "export {initialCutoverPin,initialCutoverEvidence,INITIAL_FRAME_BYTES,INITIAL_MAX_PACKET_BYTES} from './initial-cutover-pin';",
  "export {canonical} from './protocol';",
 ].join('\n');
 const result=require('esbuild').buildSync({stdin:{contents:text,sourcefile:source,resolveDir:path.dirname(source),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
 const compiled=new Module(path.join(root,'scripts','.initial-source-codecs.cjs'),module);compiled.filename=path.join(root,'scripts','.initial-source-codecs.cjs');compiled.paths=module.paths;compiled._compile(result.outputFiles[0].text,compiled.filename);return codecs=compiled.exports;
}
module.exports={localInitialCodecs};
