/* Durable single-dispatch journal. Never sends network traffic or infers success
 * from elapsed time/PID disappearance. Uncertain operations retain the target gate. */
const fs=require('node:fs/promises'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {privateDirectory,assertPrivate}=require('./maintenance-client.cjs');
const fail=c=>{throw Error(c);};
function spec(s){if(!s||Object.keys(s).sort().join(',')!=='account,id,intentSha256,kind,worker'||! /^[a-f0-9]{32}$/.test(s.account)||! /^[a-z0-9][a-z0-9-]{0,62}$/.test(s.worker)||! /^[a-z0-9][a-z0-9_-]{0,95}$/.test(s.id)||! /^[a-z][a-z0-9_]{0,63}$/.test(s.kind)||! /^[a-f0-9]{64}$/.test(s.intentSha256))fail('INVALID_RELEASE_INTENT');return {...s};}
async function openReleaseJournal(directory){
 directory=path.resolve(directory);try{await privateDirectory(directory);}catch(e){if(e.code!=='EEXIST')throw e;await assertPrivate(directory);}
 const file=path.join(directory,'operations.sqlite');try{const f=await fs.open(file,'wx',0o600);await f.close();if(process.platform==='win32')await require('./private-path.cjs').windowsPrivatePath(file,'file');}catch(e){if(e.code!=='EEXIST')throw e;}
 await assertPrivate(file);const db=new DatabaseSync(file);
 db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
 db.exec('CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,account TEXT NOT NULL,worker TEXT NOT NULL,kind TEXT NOT NULL,intent_sha TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,dispatched_at TEXT,evidence_sha TEXT); CREATE TABLE IF NOT EXISTS target_gates(account TEXT NOT NULL,worker TEXT NOT NULL,operation_id TEXT NOT NULL REFERENCES operations(id),PRIMARY KEY(account,worker)); CREATE TABLE IF NOT EXISTS transitions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES operations(id),state TEXT NOT NULL,at TEXT NOT NULL,evidence_sha TEXT);');
 const get=id=>db.prepare('SELECT * FROM operations WHERE id=?').get(id)??null;
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}
 function transition(id,state,evidence=null){db.prepare('INSERT INTO transitions(operation_id,state,at,evidence_sha) VALUES(?,?,?,?)').run(id,state,new Date().toISOString(),evidence);}
 function gated(id){const row=get(id);if(!row)fail('RELEASE_OPERATION_NOT_FOUND');const gate=db.prepare('SELECT operation_id FROM target_gates WHERE account=? AND worker=?').get(row.account,row.worker);if(gate?.operation_id!==id)fail('RELEASE_TARGET_GATE_MISMATCH');return row;}
 return {
  file,
  reserve(input,predecessor){const s=spec(input);let expected;if(predecessor!==undefined){if(!predecessor||Object.keys(predecessor).sort().join(',')!=='evidenceSha256,id'||! /^[a-z0-9][a-z0-9_-]{0,95}$/.test(predecessor.id)||! /^[a-f0-9]{64}$/.test(predecessor.evidenceSha256))fail('INVALID_RELEASE_PREDECESSOR');expected={...predecessor};}return transaction(()=>{const prior=get(s.id);if(prior){if(prior.account!==s.account||prior.worker!==s.worker||prior.kind!==s.kind||prior.intent_sha!==s.intentSha256)fail('RELEASE_INTENT_CONFLICT');return prior;}
   if(expected){const parent=get(expected.id),head=db.prepare("SELECT o.id FROM transitions t JOIN operations o ON o.id=t.operation_id WHERE o.account=? AND o.worker=? AND t.state='verified' ORDER BY t.sequence DESC LIMIT 1").get(s.account,s.worker);if(!parent||parent.account!==s.account||parent.worker!==s.worker||parent.state!=='verified'||parent.evidence_sha!==expected.evidenceSha256||head?.id!==parent.id)fail('RELEASE_PREDECESSOR_CHANGED');}
   if(db.prepare('SELECT operation_id FROM target_gates WHERE account=? AND worker=?').get(s.account,s.worker))fail('RELEASE_TARGET_HELD');
   db.prepare('INSERT INTO operations(id,account,worker,kind,intent_sha,state,created_at) VALUES(?,?,?,?,?,?,?)').run(s.id,s.account,s.worker,s.kind,s.intentSha256,'prepared',new Date().toISOString());db.prepare('INSERT INTO target_gates(account,worker,operation_id) VALUES(?,?,?)').run(s.account,s.worker,s.id);transition(s.id,'prepared');return get(s.id);});},
  dispatch(id){return transaction(()=>{const r=gated(id);if(r.state!=='prepared')fail('RELEASE_ALREADY_DISPATCHED');db.prepare('UPDATE operations SET state=?,dispatched_at=? WHERE id=?').run('dispatching',new Date().toISOString(),id);transition(id,'dispatching');return get(id);});},
  record(id,state,evidenceSha256){if(!['acknowledged','uncertain'].includes(state)||! /^[a-f0-9]{64}$/.test(evidenceSha256))fail('INVALID_RELEASE_OUTCOME');return transaction(()=>{const r=get(id);if(r?.state==='verified')return r;gated(id);if(!['dispatching','acknowledged','uncertain'].includes(r.state))fail('RELEASE_NOT_DISPATCHED');db.prepare('UPDATE operations SET state=?,evidence_sha=? WHERE id=?').run(state,evidenceSha256,id);transition(id,state,evidenceSha256);return get(id);});},
  verified(id,evidenceSha256){if(! /^[a-f0-9]{64}$/.test(evidenceSha256))fail('INVALID_RELEASE_EVIDENCE');return transaction(()=>{const r=get(id);if(r?.state==='verified'){if(r.evidence_sha!==evidenceSha256)fail('RELEASE_VERIFICATION_CONFLICT');return r;}gated(id);if(!['dispatching','acknowledged','uncertain'].includes(r.state))fail('RELEASE_NOT_DISPATCHED');db.prepare('UPDATE operations SET state=?,evidence_sha=? WHERE id=?').run('verified',evidenceSha256,id);transition(id,'verified',evidenceSha256);db.prepare('DELETE FROM target_gates WHERE account=? AND worker=? AND operation_id=?').run(r.account,r.worker,id);return get(id);});},
  inspect(id){return {operation:get(id),transitions:db.prepare('SELECT * FROM transitions WHERE operation_id=? ORDER BY sequence').all(id)};},
  close(){db.close();}
 };
}
module.exports={openReleaseJournal};
