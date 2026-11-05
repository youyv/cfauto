import { describe, it, expect } from 'vitest';
import { readApiResult } from '../src/lib/cloudflare-api';
import { rotateRepairSubdomain } from '../src/routes/fix1101';
import { cfOk, cfErr, stubFetch } from './helpers';

describe('repair subdomain recovery', () => {
    it('never deletes when the old value cannot be read', async () => {
        const stub = stubFetch([{ match: '/subdomain', respond: () => cfOk({}) }]);
        try {
            expect(await rotateRepairSubdomain('account', {})).toContain('未执行删除');
            expect(stub.calls.map(c => c.method)).toEqual(['GET']);
        } finally { stub.restore(); }
    });
    it('restores old value after rejected new value and confirmed absence', async () => {
        let reads = 0; let puts = 0;
        const stub = stubFetch([{ match: '/subdomain', respond: c => {
            if (c.method === 'GET') return cfOk({ subdomain: ++reads === 1 ? 'original' : '' });
            if (c.method === 'PUT' && ++puts === 1) return cfErr(200, 'rejected');
            return cfOk({});
        } }]);
        try {
            expect(await rotateRepairSubdomain('account', {})).toContain('已恢复原子域名');
            expect(JSON.parse(stub.calls.at(-1)!.body!)).toEqual({ subdomain: 'original' });
        } finally { stub.restore(); }
    });
    it('does not overwrite a current value after a lost response', async () => {
        let reads = 0;
        const stub = stubFetch([{ match: '/subdomain', respond: c => {
            if (c.method === 'GET') return cfOk({ subdomain: ++reads === 1 ? 'original' : 'new-active' });
            if (c.method === 'PUT') throw new Error('response lost');
            return cfOk({});
        } }]);
        try {
            expect(await rotateRepairSubdomain('account', {})).toContain('当前值为 new-active');
            expect(stub.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
        } finally { stub.restore(); }
    });
    it('does not treat malformed re-read data as confirmed absence', async () => {
        let reads = 0;
        const stub = stubFetch([{ match: '/subdomain', respond: c => {
            if (c.method === 'GET') return cfOk(++reads === 1 ? { subdomain: 'original' } : {});
            return cfErr(503, 'unavailable');
        } }]);
        try {
            expect(await rotateRepairSubdomain('account', {})).toContain('状态未知');
            expect(stub.calls.some(c => c.method === 'PUT')).toBe(false);
        } finally { stub.restore(); }
    });
    it('reports unknown rather than restoration success when re-read fails', async () => {
        let reads = 0;
        const stub = stubFetch([{ match: '/subdomain', respond: c => {
            if (c.method === 'GET' && ++reads === 1) return cfOk({ subdomain: 'original' });
            return cfErr(503, 'unavailable');
        } }]);
        try {
            expect(await rotateRepairSubdomain('account', {})).toContain('状态未知');
            expect(stub.calls.some(c => c.method === 'PUT')).toBe(false);
        } finally { stub.restore(); }
    });
});

describe('Cloudflare result envelopes', () => {
    it('rejects HTTP 200 business errors and redacts diagnostics', async () => {
        await expect(readApiResult(cfErr(200, 'Bearer abcdefghijklmnopqrstuvwxyz'), 'test')).rejects.not.toThrow('abcdefghijklmnopqrstuvwxyz');
        await expect(readApiResult(cfErr(200, 'rejected'), 'test')).rejects.toThrow('rejected');
    });
});
