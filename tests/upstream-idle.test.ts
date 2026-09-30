import {afterEach,expect,it,vi} from 'vitest';
import {upstreamIdle} from '../packages/core/src/upstream-idle.js';
afterEach(()=>vi.useRealTimers());
it('allows active streams past the original deadline, then aborts stalled input',async()=>{
 vi.useFakeTimers();const idle=upstreamIdle(100);
 let source!:ReadableStreamDefaultController<Uint8Array>;
 const response=idle.watch(new Response(new ReadableStream({start(c){source=c;}})));
 const reader=response.body!.getReader();
 for(let i=0;i<5;i++){
  await vi.advanceTimersByTimeAsync(80);source.enqueue(new Uint8Array([i]));expect((await reader.read()).value?.[0]).toBe(i);expect(idle.signal.aborted).toBe(false);
 }
 const pending=reader.read();const failure=expect(pending).rejects.toThrow(/idle timeout/);
 await vi.advanceTimersByTimeAsync(101);await failure;expect(idle.signal.aborted).toBe(true);idle.close();
});
it('propagates cancellation to upstream and clears the deadline',async()=>{
 vi.useFakeTimers();const cancelled=vi.fn();const idle=upstreamIdle(100);
 const response=idle.watch(new Response(new ReadableStream({cancel:cancelled})));
 const reader=response.body!.getReader();const failure=expect(reader.read()).rejects.toThrow();idle.abort();await failure;
 await vi.advanceTimersByTimeAsync(0);expect(cancelled).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
