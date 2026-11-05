import type {SqlDatabase} from './config-store';
import {accountId} from './business-command';
import {ReliabilityError} from './protocol';
/** Shared, read-only inventory for drain and archive. Retained archive owners are
 * still physical authority objects even after directory/history removal. Missing
 * mandatory authority tables or malformed identities fail closed; no KV fallback. */
export function authorityAccounts(db:SqlDatabase,generation:string):string[]{
 const record=db.rows<{payload:string}>('SELECT payload FROM config_records WHERE generation=? AND domain=?',generation,'accounts')[0];
 if(!record)throw new ReliabilityError('NOT_READY',503);
 let value:unknown;try{value=JSON.parse(record.payload);}catch{throw new ReliabilityError('NOT_READY',503);}
 if(!Array.isArray(value))throw new ReliabilityError('NOT_READY',503);
 const current=value.map(a=>a?.accountId);
 const history=db.rows<{account:string}>('SELECT DISTINCT account FROM dispatch_outbox').map(r=>r.account);
 const hasRegistry=db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name='account_archive_registry'").length>0;
 const retained=hasRegistry?db.rows<{account:string}>('SELECT account FROM account_archive_registry').map(r=>r.account):[];
 const accounts=[...new Set([...current,...history,...retained])];accounts.forEach(accountId);return accounts.sort();
}
