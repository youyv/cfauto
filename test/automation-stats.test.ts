import { describe,expect,it } from 'vitest';
import { parseUsageGroups,statForAccount } from '../src/lib/stats';
import { isFuseTriggered } from '../src/cron';
describe('automation statistics fail closed',()=>{
    it.each([undefined,null,{},[{sum:{}}],[{sum:{requests:'5'}}],[{sum:{requests:-1}}],[{sum:{requests:1.5}}],[{sum:{requests:NaN}}],[{sum:{requests:Infinity}}],Array(1000).fill({sum:{requests:1}}),[{sum:{requests:Number.MAX_SAFE_INTEGER}},{sum:{requests:1}}]].map(value=>[value]))('does not treat malformed/saturated groups as usable zero: %j',value=>{expect(parseUsageGroups(value)).toBeNull();});
    it('distinguishes an empty complete array from missing groups',()=>{expect(parseUsageGroups([])).toBe(0);expect(parseUsageGroups([{sum:{requests:4}},{sum:{requests:6}}])).toBe(10);});
    it('joins on stable account ID, never alias, and rejects duplicate matches',()=>{
        const rows=[{accountId:'a',alias:'same',total:1,max:100},{accountId:'b',alias:'same',total:99,max:100}];
        expect(statForAccount(rows,'a')?.total).toBe(1);expect(statForAccount(rows,'b')?.total).toBe(99);expect(statForAccount(rows,'missing')).toBeUndefined();expect(statForAccount([...rows,rows[0]],'a')).toBeUndefined();
    });
    it.each([{total:Infinity,max:100},{total:100,max:0},{total:100,max:NaN},{total:-1,max:100},{total:1.5,max:1},{total:100,max:Infinity}])('rejects unsafe fuse inputs %j',stat=>{expect(isFuseTriggered(stat,90)).toBe(false);});
    it.each([NaN,Infinity,-1,0])('rejects unsafe threshold %s',threshold=>{expect(isFuseTriggered({total:100,max:100},threshold)).toBe(false);});
});
