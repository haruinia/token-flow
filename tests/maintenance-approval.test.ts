import {expect,it,vi} from 'vitest';
import {MaintenanceApproval} from '../packages/core/src/maintenance-approval.js';
const verdict={decision:'approve' as const,reason:'safe',reviewer:'source/model'};
function setup(review=vi.fn(async(_proposal:unknown,_policy:unknown)=>verdict)) {const execute=vi.fn(async()=>({ok:true}));const after=vi.fn(async()=>{});const queue=new MaintenanceApproval(review,async()=>{},after);return {queue,execute,after,review};}
it('requires explicit approval and executes an immutable proposal once, followed by review',async()=>{
 const {queue,execute,after}=setup();const proposal=queue.propose('repair','exact code',execute);expect(execute).not.toHaveBeenCalled();expect(queue.snapshot().policy.mode).toBe('manual');proposal.code='edited';expect(queue.snapshot().proposal?.code).toBe('exact code');
 await queue.decide(proposal.id,true);expect(execute).toHaveBeenCalledTimes(1);expect(after).toHaveBeenCalledWith({ok:true});await expect(queue.decide(proposal.id,true)).rejects.toThrow();
});
it('rejects stale ids and user denial without executing',async()=>{const {queue,execute}=setup();const p=queue.propose('repair','code',execute);await expect(queue.decide('stale',true)).rejects.toThrow();await queue.decide(p.id,false);expect(execute).not.toHaveBeenCalled();});
it('delegates a pending plan to the selected reviewer and auto-executes only approval',async()=>{const {queue,execute,review}=setup();queue.propose('repair','code',execute);const reviewer={sourceId:'other',model:'other/model'};queue.configure({mode:'model',reviewer});await vi.waitFor(()=>expect(execute).toHaveBeenCalledOnce());expect(review.mock.calls[0]?.[1]).toEqual({mode:'model',reviewer});});
it('uses default maintenance selection implicitly and returns failed model approval to manual review',async()=>{
 const {queue,execute}=setup(vi.fn(async()=>{throw Error('offline');}));queue.configure({mode:'model'});queue.propose('repair','code',execute);await vi.waitFor(()=>expect(queue.snapshot().proposal?.reason).toContain('人工审批'));expect(queue.snapshot().proposal?.status).toBe('pending');expect(execute).not.toHaveBeenCalled();
});
it('revoking delegation while the model is deciding prevents execution',async()=>{
 let resolve!:(v:typeof verdict)=>void;const {queue,execute,review}=setup(vi.fn(()=>new Promise<typeof verdict>(r=>{resolve=r;})));queue.configure({mode:'model'});queue.propose('repair','code',execute);await vi.waitFor(()=>expect(review).toHaveBeenCalledOnce());queue.configure({mode:'manual'});resolve(verdict);await new Promise(r=>setTimeout(r,0));expect(execute).not.toHaveBeenCalled();expect(queue.snapshot().proposal?.status).toBe('pending');
});
it('does not execute rejected model plans or expired plans',async()=>{
 const execute=vi.fn();const queue=new MaintenanceApproval(async()=>({...verdict,decision:'reject'}),async()=>{},async()=>{});queue.configure({mode:'model'});queue.propose('repair','code',execute);await vi.waitFor(()=>expect(queue.snapshot().proposal?.status).toBe('rejected'));expect(execute).not.toHaveBeenCalled();
 queue.configure({mode:'manual'});const p=queue.propose('repair','code',execute);const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(p.expiresAt)+1);try{await expect(queue.decide(p.id,true)).rejects.toThrow('过期');}finally{clock.mockRestore();}
});
it('reports execution conflicts and does not run post-repair review',async()=>{const {queue,after}=setup();const p=queue.propose('repair','code',async()=>{throw Error('file changed');});await queue.decide(p.id,true);expect(queue.snapshot().proposal?.status).toBe('failed');expect(after).not.toHaveBeenCalled();});
