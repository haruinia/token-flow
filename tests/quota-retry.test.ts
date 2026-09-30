import {afterEach,expect,it,vi} from 'vitest';
import {retryQuotaCall,QuotaTransportError} from '../packages/core/src/quota/retry.js';
// Keep retry tests instantaneous while preserving abort behavior of the real timer.
vi.mock('node:timers/promises',()=>({setTimeout:vi.fn(async(_ms:number,_value:unknown,options:{signal:AbortSignal})=>{options.signal.throwIfAborted();})}));
import {setTimeout as delay} from 'node:timers/promises';
afterEach(()=>vi.clearAllMocks());
const response=(statusCode:number)=>({statusCode,header:{},body:'upstream-secret'});
it('retries transport errors and upstream 502s with bounded backoff, then returns success',async()=>{
 const call=vi.fn().mockRejectedValueOnce(new QuotaTransportError('connection failed')).mockResolvedValueOnce(response(502)).mockResolvedValue(response(200));const retry=vi.fn();
 expect((await retryQuotaCall(call,new AbortController().signal,retry)).statusCode).toBe(200);
 expect(call).toHaveBeenCalledTimes(3);expect(retry.mock.calls).toEqual([[2],[3]]);expect(vi.mocked(delay).mock.calls.map(c=>c[0])).toEqual([1000,2000]);
});
it('stops after five attempts and never exposes the provider body',async()=>{
 const call=vi.fn().mockResolvedValue(response(503));await expect(retryQuotaCall(call,new AbortController().signal,()=>{})).rejects.toThrow('已尝试 5 次');
 expect(call).toHaveBeenCalledTimes(5);expect(vi.mocked(delay).mock.calls.map(c=>c[0])).toEqual([1000,2000,4000,8000]);
});
it.each([400,401,403,404,429,501])('does not retry HTTP %s',async code=>{
 const call=vi.fn().mockResolvedValue(response(code));expect((await retryQuotaCall(call,new AbortController().signal,()=>{})).statusCode).toBe(code);expect(call).toHaveBeenCalledTimes(1);
});
it('does not retry validation errors or a shutdown',async()=>{
 const invalid=vi.fn().mockRejectedValue(new Error('invalid response'));await expect(retryQuotaCall(invalid,new AbortController().signal,()=>{})).rejects.toThrow('invalid response');expect(invalid).toHaveBeenCalledTimes(1);
 const controller=new AbortController(),call=vi.fn().mockResolvedValue(response(502));await expect(retryQuotaCall(call,controller.signal,()=>controller.abort())).rejects.toThrow();expect(call).toHaveBeenCalledTimes(1);
});
