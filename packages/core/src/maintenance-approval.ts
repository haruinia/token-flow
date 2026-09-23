import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { maintenanceSelection } from './gateway-maintenance.js';
export const approvalPolicy=z.object({mode:z.enum(['manual','model']).default('manual'),reviewer:maintenanceSelection.optional()}).strict();
export type ApprovalPolicy=z.infer<typeof approvalPolicy>;
export type RepairProposal={id:string;title:string;code:string;createdAt:string;expiresAt:string;status:'pending'|'reviewing'|'executing'|'completed'|'rejected'|'failed';reason?:string;reviewer?:string;result?:unknown};
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
/** Exact, immutable, single-use operation. Models may approve or reject; never edit executable code. */
export class MaintenanceApproval {
 private policy:ApprovalPolicy={mode:'manual'};
 private proposal?:RepairProposal;
 private execute?:()=>Promise<unknown>;
 private generation=0;
 private closed=false;
 private task?:Promise<void>;
 constructor(private review:(proposal:RepairProposal,policy:ApprovalPolicy)=>Promise<{decision:'approve'|'reject';reason:string;reviewer:string}>,private settled:()=>Promise<void>,private after:(result:unknown)=>Promise<void>){}
 snapshot(){return structuredClone({policy:this.policy,proposal:this.proposal});}
 configure(policy:ApprovalPolicy){if(this.proposal?.status==='executing')throw conflict('维修正在执行');this.generation++;this.policy=policy;if(this.proposal?.status==='reviewing')this.proposal.status='pending';if(this.policy.mode==='model'&&this.proposal?.status==='pending')this.launchReview();return this.snapshot();}
 clear(){if(this.proposal?.status==='executing')throw conflict('维修正在执行');this.generation++;this.proposal=undefined;this.execute=undefined;}
 async close(){this.closed=true;this.generation++;await this.task;}
 propose(title:string,code:string,execute:()=>Promise<unknown>){
  if(this.closed)throw conflict('服务正在关闭');
  if(this.proposal?.status==='pending'&&Date.now()>Date.parse(this.proposal.expiresAt))this.proposal.status='failed';
  if(this.proposal&&['pending','reviewing','executing'].includes(this.proposal.status))return this.snapshot().proposal!;
  const id=randomUUID();this.proposal={id,title,code,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),status:'pending'};this.execute=execute;
  if(this.policy.mode==='model')this.launchReview();
  return this.snapshot().proposal!;
 }
 private launchReview(){
   const id=this.proposal!.id;
   const generation=++this.generation;const policy=structuredClone(this.policy);
   this.task=(async()=>{
    await this.settled();if(this.closed||generation!==this.generation)return;
    const proposal=this.require(id);proposal.status='reviewing';
    try{
     const answer=await this.review(structuredClone(proposal),policy);
     if(this.closed||generation!==this.generation)return;
     proposal.status='pending';proposal.reviewer=answer.reviewer;proposal.reason=answer.reason;
     if(answer.decision==='approve')await this.decide(id,true);else proposal.status='rejected';
    }catch{if(!this.closed&&generation===this.generation){proposal.status='pending';proposal.reason='模型审批未完成，已转回人工审批。';}}
   })().catch(()=>{if(this.proposal?.id===id&&generation===this.generation){this.proposal.status='pending';this.proposal.reason='审批未完成，请重新检查并生成人工审批方案。';}});
  }
 private require(id:string){if(!this.proposal||this.proposal.id!==id)throw conflict('维修方案已变更');if(Date.now()>Date.parse(this.proposal.expiresAt))throw conflict('维修方案已过期，请重新生成');return this.proposal;}
 async decide(id:string,approve:boolean){
  const proposal=this.require(id);if(proposal.status!=='pending')throw conflict('该方案已经处理或正在审批');
  if(!approve){this.generation++;proposal.status='rejected';proposal.reason='用户拒绝了本次维修';return this.snapshot();}
  proposal.status='executing';
  try{await this.settled();if(this.closed)throw conflict('服务正在关闭');this.require(id);const result=await this.execute!();proposal.status='completed';proposal.result=result;try{await this.after(result);}catch{proposal.reason='维修执行完成，自动复查未启动，可手动重新检查。';}}
  catch{proposal.status='failed';proposal.reason='执行未完成：配置、进程、授权或接入记录可能已变化。请重新检查并生成方案；没有跳过冲突检查。';}
  return this.snapshot();
 }
}
