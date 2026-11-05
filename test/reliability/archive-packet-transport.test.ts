import {afterEach,describe,expect,it,vi} from 'vitest';
import {ArchivePacketTransport,ARCHIVE_FRAME_BYTES} from '../../src/reliability/archive-packet-transport';
import {AuthorityArchive} from '../../src/reliability/authority-archive';
import {SealedStore} from '../../src/reliability/sealed-store';
import {ConfigStore} from '../../src/reliability/config-store';
import {canonical,sha256,manifestDigest} from '../../src/reliability/protocol';
import {sqliteFixture} from './sqlite-fixture';
const opened:ReturnType<typeof sqliteFixture>[]=[];
const ring={currentId:'local',keys:{local:'local-only-archive-transport-key-32-bytes'}};
async function fixture(source=false){const f=sqliteFixture();opened.push(f);const config=new ConfigStore(f.db),sealed=new SealedStore(f.db,ring),archive=new AuthorityArchive(f.db,sealed,'installation1',{role:'global'},()=>1234);const make=()=>new ArchivePacketTransport(f.db,archive);const transfer=make();if(source){const records:any[]=[{domain:'accounts',revision:1,value:[]},{domain:'vars:cmliu',revision:1,value:{private:'not-public-secret-'.repeat(1500)}}];config.beginImport('g1',await manifestDigest(records),records.length);for(const r of records)config.stage('g1',r);await config.activateInitial('g1',0);await archive.create('backup1','g1',1);}return {...f,config,sealed,archive,transfer,make};}
afterEach(()=>{for(const f of opened.splice(0))f.sql.close();vi.restoreAllMocks();});
async function transferPacket(source:Awaited<ReturnType<typeof fixture>>,target:Awaited<ReturnType<typeof fixture>>,id:string,part:number|null){const info=await source.transfer.beginExport(id,'backup1',part);target.transfer.beginImport(info.descriptor);for(let n=info.descriptor.frames-1;n>=0;n--){const frame=await source.transfer.exportFrame(id,n);await target.transfer.putFrame(id,n,frame.data);}return target.transfer.commitImport(id);}
describe('bounded durable archive ciphertext packet transport',()=>{
 it('round-trips a complete archive in bounded frames, never activating config or emitting values',async()=>{
  const a=await fixture(true),b=await fixture();await transferPacket(a,b,'root1',null);
  const inventory=await a.transfer.inventory('backup1');for(let p=0;p<inventory.pages;p++)await transferPacket(a,b,'page'+p,p);
  expect(await b.archive.finishReceive('backup1')).toMatchObject({state:'ready',migrationReady:false});expect(b.config.status().generation).toBeNull();
  const restored=await b.archive.snapshot('backup1'),original=await a.archive.snapshot('backup1');expect(restored).toEqual(original);
  const output=await a.transfer.exportFrame('root1',0);expect(output.data.length).toBeLessThanOrEqual(ARCHIVE_FRAME_BYTES*4/3);expect(JSON.stringify(output)).not.toContain('not-public-secret');
 });
 it('resumes out-of-order frames after reconstruction, rejects conflicting bytes and never overwrites',async()=>{
  const a=await fixture(true),b=await fixture(),info=await a.transfer.beginExport('root1','backup1',null);b.transfer.beginImport(info.descriptor);
  const first=await a.transfer.exportFrame('root1',0);expect(await b.transfer.putFrame('root1',0,first.data)).toEqual({duplicate:false});expect(await b.make().putFrame('root1',0,first.data)).toEqual({duplicate:true});
  const changed=Buffer.from('x'.repeat(ARCHIVE_FRAME_BYTES)).toString('base64');await expect(b.transfer.putFrame('root1',0,changed)).rejects.toThrow();await expect(b.make().commitImport('root1')).rejects.toThrow('NOT_READY');
  for(let n=1;n<info.descriptor.frames;n++){const frame=await a.transfer.exportFrame('root1',n);await b.make().putFrame('root1',n,frame.data);}expect((await b.make().commitImport('root1')).state).toBe('complete');expect((await b.make().commitImport('root1')).state).toBe('complete');
 });
 it('refuses wrong hash, wrong archive context and malformed frame sizes before archive import',async()=>{
  const a=await fixture(true),info=await a.transfer.beginExport('root1','backup1',null);
  for(const patch of [{digest:'0'.repeat(64)},{archive:'wrong'}]){const b=await fixture();b.transfer.beginImport({...info.descriptor,...patch});for(let n=0;n<info.descriptor.frames;n++)await b.transfer.putFrame('root1',n,(await a.transfer.exportFrame('root1',n)).data);await expect(b.transfer.commitImport('root1')).rejects.toThrow();expect(b.db.rows('SELECT * FROM authority_archives')).toEqual([]);expect(b.config.status().generation).toBeNull();}
  const b=await fixture();b.transfer.beginImport(info.descriptor);for(const data of ['not base64','YQ==','===='])await expect(b.transfer.putFrame('root1',0,data)).rejects.toThrow('INVALID');expect(b.db.rows('SELECT * FROM archive_transfer_frames')).toEqual([]);
 });
 it('does not reflect unverified import frames as exports or permit transfer rebinding',async()=>{
  const a=await fixture(true),b=await fixture(),info=await a.transfer.beginExport('root1','backup1',null);b.transfer.beginImport(info.descriptor);await expect(b.transfer.exportFrame('root1',0)).rejects.toThrow();expect(()=>b.transfer.beginImport({...info.descriptor,generation:'g2'})).toThrow('CONFLICT');await expect(a.transfer.beginExport('root1','backup1',0)).rejects.toThrow('CONFLICT');
 });
 it('recovers archive-import success followed by lost transfer ACK without overwriting packet bytes',async()=>{
  const a=await fixture(true),b=await fixture(),info=await a.transfer.beginExport('root1','backup1',null);b.transfer.beginImport(info.descriptor);for(let n=0;n<info.descriptor.frames;n++)await b.transfer.putFrame('root1',n,(await a.transfer.exportFrame('root1',n)).data);
  const rows=b.db.rows.bind(b.db);let fail=true;vi.spyOn(b.db,'rows').mockImplementation((q,...p)=>{if(fail&&q.startsWith("UPDATE archive_packet_transfers SET state='complete'")){fail=false;throw new Error('lost ACK');}return rows(q,...p);});await expect(b.transfer.commitImport('root1')).rejects.toThrow();const ciphertext=b.db.rows('SELECT * FROM sealed_chunks');expect((await b.make().commitImport('root1')).state).toBe('complete');expect(b.db.rows('SELECT * FROM sealed_chunks')).toEqual(ciphertext);
 });
 it('excludes retained transfer payloads from later archives rather than recursively embedding backups',async()=>{
  const a=await fixture(true);await a.transfer.beginExport('root1','backup1',null);await a.archive.create('backup2','g1',1);const saved=await a.archive.snapshot('backup2');expect(saved.manifest.tables.find(t=>t.name==='archive_transfer_frames')?.rows).toBe(0);expect(saved.manifest.tables.find(t=>t.name==='archive_packet_transfers')?.rows).toBe(1);expect(a.db.rows('SELECT * FROM archive_transfer_frames').length).toBeGreaterThan(0);
 });
});

it('rejects a forged authenticated packet even when its transport digest and frames are valid',async()=>{
 const a=await fixture(true),b=await fixture(),original=await a.archive.rootPacket('backup1'),text=canonical({...original,proof:'0'.repeat(64)}),bytes=Buffer.from(text);
 const descriptor={id:'forged',archive:'backup1',part:null,generation:'g1',epoch:1,digest:await sha256(text),bytes:bytes.length,frames:Math.ceil(bytes.length/ARCHIVE_FRAME_BYTES)};b.transfer.beginImport(descriptor);
 for(let n=0;n<descriptor.frames;n++)await b.transfer.putFrame('forged',n,bytes.subarray(n*ARCHIVE_FRAME_BYTES,(n+1)*ARCHIVE_FRAME_BYTES).toString('base64'));
 await expect(b.transfer.commitImport('forged')).rejects.toThrow();expect(b.db.rows('SELECT * FROM authority_archives')).toEqual([]);expect(b.config.status().generation).toBeNull();
});
it('bounds corrupted persisted descriptors and detects corrupted export frames',async()=>{
 const a=await fixture(true);await a.transfer.beginExport('root1','backup1',null);a.db.rows("UPDATE archive_transfer_frames SET data='YQ==' WHERE transfer='root1' AND ordinal=0");await expect(a.transfer.exportFrame('root1',0)).rejects.toThrow();a.db.rows("UPDATE archive_packet_transfers SET bytes=-1 WHERE id='root1'");expect(()=>a.transfer.info('root1')).toThrow('INVALID');
});
