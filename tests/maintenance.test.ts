import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import type {AssistantMessage,TranscriptContext} from '@earendil-works/pi-ai';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import {GatewayMaintenance} from '../packages/core/src/gateway-maintenance.js';
const transport={baseURL:'http://127.0.0.1:8317/v1',apiKey:'private-fixture-key',authID:'account.json'};
function answer(content:AssistantMessage['content'],error=false){const s=createAssistantMessageEventStream();const message:AssistantMessage={role:'assistant',content,api:'openai-responses',provider:'token-flowb',model:'qoder/test',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:error?'error':content.some(c=>c.type==='toolCall')?'toolUse':'stop',timestamp:Date.now(),...(error?{errorMessage:'private-fixture-key RAW UPSTREAM ERROR'}:{})};if(error)s.push({type:'error',reason:'error',error:message});else s.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});s.end(message);return s;}
it('uses the actual Pi loop, retains follow-up context and never carries write authorization into the next question',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-care-'));let turns=0,restores=0,inspects=0;const contexts:TranscriptContext[]=[];
 const stream:StreamFn=(_m,c)=>{contexts.push(structuredClone(c));turns++;return turns%2===1?answer([{type:'toolCall',id:`call${turns}`,name:'restore_connection',arguments:{id:randomUUID()}}]):answer([{type:'text',text:'已依据检查结果回答'}]);};
 const care=new GatewayMaintenance(root,stream);const actions={inspect:async()=>{inspects++;return {safe:true};},refresh:async()=>({}),restore:async()=>{restores++;return {restored:true};}};
 try{await care.select({sourceId:'account',model:'qoder/test'});care.start('还原指定接入',transport,actions,true);await expect.poll(()=>care.snapshot().status).toBe('completed');expect(restores).toBe(1);
 care.start('刚才还原的是哪个配置？',transport,actions);await expect.poll(()=>care.snapshot().status).toBe('completed');expect(restores).toBe(1);expect(inspects).toBe(2);expect(JSON.stringify(contexts.at(-1))).toContain('还原指定接入');expect(care.snapshot().engine).toBe('pi');expect(care.snapshot().messages.some(m=>m.text.includes('本次任务未授权修改配置'))).toBe(true);expect(JSON.stringify(care.snapshot())).not.toContain('private-fixture-key');care.reset();expect(care.snapshot().messages).toEqual([]);
 }finally{await care.close();await rm(root,{recursive:true,force:true});}
});
it('redacts provider failures and caps an endless tool loop',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-limits-'));let turns=0;
 const care=new GatewayMaintenance(root,()=>++turns===1?answer([],true):answer([{type:'toolCall',id:`call${turns}`,name:'inspect_gateway',arguments:{}}]));
 const actions={inspect:async()=>({}),refresh:async()=>({}),restore:async()=>({})};
 try{await care.select({sourceId:'account',model:'qoder/test'});care.start('检查',transport,actions);await expect.poll(()=>care.snapshot().status).toBe('failed');expect(JSON.stringify(care.snapshot())).not.toContain('private-fixture-key');care.start('循环检查',transport,actions);await expect.poll(()=>care.snapshot().status).toBe('failed');expect(turns).toBe(4);expect(care.snapshot().messages.at(-1)?.text).toContain('上限');}finally{await care.close();await rm(root,{recursive:true,force:true});}
});
it('stops during preflight without starting a late model request, and blocks overlapping runs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-stop-'));let calls=0;let release!:()=>void;const pending=new Promise<void>(r=>release=r);
 const care=new GatewayMaintenance(root,()=>{calls++;return answer([{type:'text',text:'OK'}]);});const actions={inspect:async()=>{await pending;return {};},refresh:async()=>({}),restore:async()=>({})};
 try{await care.select({sourceId:'account',model:'qoder/test'});care.start('检查',transport,actions);expect(()=>care.start('重叠请求',transport,actions)).toThrow('上一条');const closed=care.close();release();await closed;expect(calls).toBe(0);expect(care.snapshot().status).toBe('failed');care.reset();expect(care.snapshot().status).toBe('idle');}finally{release();await care.close();await rm(root,{recursive:true,force:true});}
});

it('probes Responses without repair tools, rejects empty success, and does not persist readiness across startup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-check-'));let calls=0;
 const care=new GatewayMaintenance(root,(_m,context,options)=>{calls++;expect(JSON.stringify(context)).not.toContain('inspect_gateway');expect(options?.maxTokens).toBe(32);return answer(calls===1?[]:[{type:'text',text:'OK'}]);});
 try{await care.select({sourceId:'account',model:'qoder/test'});expect(care.check(transport).readiness.status).toBe('checking');expect(()=>care.check(transport)).toThrow('正在');await expect.poll(()=>care.snapshot().readiness.status).toBe('failed');expect(care.snapshot().readiness.message).toContain('完整响应');care.check(transport);await expect.poll(()=>care.snapshot().readiness.status).toBe('ready');expect(calls).toBe(2);expect(care.snapshot().messages).toEqual([]);const reopened=new GatewayMaintenance(root);await reopened.load();expect(reopened.snapshot().selection?.model).toBe('qoder/test');expect(reopened.snapshot().readiness.status).toBe('unchecked');}finally{await care.close();await rm(root,{recursive:true,force:true});}
});
it('classifies upstream failures without exposing secrets and starts fresh after a failed turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pi-retry-'));let turns=0;
 const care=new GatewayMaintenance(root,(_m,context)=>{if(++turns===1)throw new Error('403 private-fixture-key provider body');expect(JSON.stringify(context)).not.toContain('first broken prompt');return answer([{type:'text',text:'OK'}]);});
 const actions={inspect:async()=>({}),refresh:async()=>({}),restore:async()=>({})};
 try{await care.select({sourceId:'account',model:'qoder/test'});care.start('first broken prompt',transport,actions);await expect.poll(()=>care.snapshot().status).toBe('failed');expect(care.snapshot().readiness.message).toContain('403');expect(JSON.stringify(care.snapshot())).not.toContain('private-fixture-key');care.start('new inspection',transport,actions);await expect.poll(()=>care.snapshot().status).toBe('completed');expect(turns).toBe(2);}finally{await care.close();await rm(root,{recursive:true,force:true});}
});
