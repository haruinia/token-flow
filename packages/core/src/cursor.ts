import { createHash,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SDKModel,Run,SDKCustomTool,TokenUsage } from '@cursor/sdk';
import type { LocalAccount,LocalModel } from './cliproxy.js';
import type { AccountQuota } from './quota/types.js';
import type { LoginSession } from './login/types.js';

import {parseCursorInput,cursorResponse,type CursorToolCall} from './cursor-protocol.js';
export {parseCursorInput,cursorResponse} from './cursor-protocol.js';

const credentialSchema=z.object({apiKey:z.string().min(1),email:z.string().optional(),apiKeyExpiresAtMs:z.number().optional(),disabled:z.boolean().default(false)});
type CursorLogin=Omit<LoginSession,'provider'>&{provider:'cursor'};
type Credential=z.infer<typeof credentialSchema>;
type Secrets={get:(name:string)=>Promise<string>;set:(name:string,value:string)=>Promise<void>};
const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const errorResponse=(message:string,status=400)=>Response.json({error:{message,type:'cursor_error'}},{status});
export const cursorCatalog={id:'cursor' as const,label:'Cursor',flow:'device' as const,hint:'官方 SDK 授权 · 支持文本与客户端工具；可接入其他 Agent，个人剩余额度请查看官方用量页'};

// Only client-declared tools are exposed. No local filesystem or shell tools.
export class CursorProvider {
 private credential?:Credential;private loaded=false;private models:SDKModel[]=[];private login?:CursorLogin;
 private loginAbort?:AbortController;private loginTask?:Promise<void>;private refreshTask?:Promise<void>;
 private catalogCredential?:Credential;
 private observedAt=new Date().toISOString();private catalogStatus:'loading'|'ready'|'error'='loading';
 private active?:Run;private generating=false;private closed=false;private error?:string;
 constructor(private root:string,private secrets:Secrets,private openExternal?:(url:string)=>Promise<void>){}
 private async sdk(){
  if(process.env.CURSOR_BACKEND_URL)throw failure('Cursor SDK 后端覆盖未获支持，请移除 CURSOR_BACKEND_URL 后重试。');
  return import('@cursor/sdk');
 }
 get id(){return this.credential?createHash('sha256').update(`cursor:${this.credential.email||this.credential.apiKey}`).digest('hex').slice(0,24):undefined;}
 owns(id:string){return !!this.id&&id===this.id;}
 async load(){if(this.loaded)return;const raw=await this.secrets.get('cursor-account');if(raw)this.credential=credentialSchema.parse(JSON.parse(raw));this.loaded=true;await this.refresh();}
 async refresh():Promise<void>{if(this.refreshTask){await this.refreshTask;if(this.catalogCredential!==this.credential)return this.refresh();return;}this.refreshTask=(async()=>{
  const credential=this.credential;if(!credential||credential.disabled)return;
  this.catalogCredential=credential;this.catalogStatus='loading';
  try{
   const {Cursor}=await this.sdk();let models:SDKModel[];
   try{models=await bounded(Cursor.models.list({apiKey:credential.apiKey}),20000);if(!Array.isArray(models))throw new Error('Invalid catalog');}
   catch(error){
    if(cursorFailure(error).blocked)throw error;
    // The documented REST catalog also works when SDK bootstrap/catalog parsing
    // fails. Never substitute a guessed model or broaden account permissions.
    const response=await fetch('https://api.cursor.com/v1/models',{headers:{Authorization:`Bearer ${credential.apiKey}`},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Object.assign(new Error('Catalog request failed'),{status:response.status});
    models=z.object({items:z.array(z.object({id:z.string(),displayName:z.string().default('')}).passthrough())}).parse(await response.json()).items as SDKModel[];
   }
   if(this.credential!==credential||this.closed)return;
   this.models=models.filter(m=>m.id&&m.id.length<280);this.error=this.models.length?undefined:'Cursor 未返回此账号可用的模型，请检查官方 API 权限后刷新。';this.catalogStatus=this.error?'error':'ready';
  }catch(error){if(this.credential===credential&&!this.closed){const cause=cursorFailure(error);if(cause.blocked)this.models=[];this.error=cause.message;this.catalogStatus='error';}}
  finally{this.observedAt=new Date().toISOString();}
 })().finally(()=>{this.refreshTask=undefined;});return this.refreshTask;}
 snapshot():{accounts:LocalAccount[];models:LocalModel[];login?:CursorLogin;quotas:Record<string,AccountQuota>}{
  const c=this.credential;const expired=!!c?.apiKeyExpiresAtMs&&c.apiKeyExpiresAtMs<=Date.now();const enabled=!!c&&!c.disabled&&!expired;
  const models=enabled?this.models.map(m=>({id:`cursor/${m.id}`,provider:'cursor' as const,displayName:m.displayName,capabilities:{text:true,tools:true,images:false}})):[];
  return {accounts:c?[{id:this.id!,provider:'cursor',label:c.email||'Cursor SDK 账号',status:expired?'授权已过期':this.catalogStatus==='loading'?'模型同步中':this.error?(this.models.length?'使用上次模型目录':'模型同步失败'):'active',modelError:this.error,disabled:c.disabled,unavailable:expired,models:models.map(m=>m.id)}]:[],models,login:this.login,
   quotas:c?{[this.id!]:{accountId:this.id!,provider:'cursor' as const,status:'ok' as const,observedAt:this.observedAt,windows:[],note:'个人套餐剩余额度暂无已确认的公开查询接口，请查看 Cursor 官方用量页。本应用调用的 Token 用量在 API 总览记录；这不代表账户剩余额度。'}}:{}};
 }
 assertSource(id:string,model:string){if(!this.owns(id)||!this.snapshot().models.some(m=>m.id===model))throw failure('Cursor 账号或模型当前不可用。',409);return `cursor:${id}`;}
 async beginLogin(){
  if(this.closed)throw failure('应用正在退出');
  if(this.loginTask)throw failure('Cursor 授权正在进行，请完成或取消。',409);
  if(this.generating)throw failure('Cursor 正在处理请求，请结束后再更换账号。',409);
  const controller=new AbortController();this.loginAbort=controller;
  const login:CursorLogin={id:randomUUID(),provider:'cursor',flow:'device',status:'starting',message:'正在准备 Cursor 官方授权…'};this.login=login;
  const timer=setTimeout(()=>controller.abort(),300000);
  this.loginTask=(async()=>{try{
   const {Cursor}=await this.sdk();const result=await Cursor.auth.login({store:null,backendUrl:'https://api2.cursor.sh',websiteUrl:'https://cursor.com',apiKeyName:'token-flow',signal:controller.signal,openBrowser:false,onLoginUrl:raw=>{
    const url=new URL(raw);if(url.protocol!=='https:'||url.hostname!=='cursor.com'||url.pathname!=='/loginDeepControl')throw failure('Cursor 授权地址不合法');
    login.url=url.href;login.status='waiting_for_browser';login.message='请在 Cursor 官方页面授权；此操作会创建独立 SDK Key。';
    void this.openExternal?.(url.href).catch(()=>{});
   }});
   if(controller.signal.aborted||this.closed)return;
   const next=credentialSchema.parse(result);await this.secrets.set('cursor-account',JSON.stringify(next));this.credential=next;this.models=[];await this.refresh();
   login.status='completed';login.message=this.error?'Cursor 已授权，模型同步未完成；可刷新重试，无需重复登录。':'Cursor 已连接，模型目录已刷新。';
  }catch{if(login.status!=='cancelled'){login.status=controller.signal.aborted?'expired':'failed';login.message=controller.signal.aborted?'Cursor 授权已超时，请重试。':'Cursor 授权未完成，请重试。';}}
  finally{clearTimeout(timer);this.loginTask=undefined;this.loginAbort=undefined;}})();
 }
 async openLogin(id:string){if(this.login?.id!==id||!this.login.url||this.login.status!=='waiting_for_browser')throw failure('授权会话已变更');await this.openExternal?.(this.login.url);}
 cancelLogin(id:string){if(this.login?.id!==id)throw failure('授权会话已变更');this.login.status='cancelled';this.login.message='已取消 Cursor 授权。';this.loginAbort?.abort();}
 async setEnabled(enabled:boolean){if(this.loginTask)throw failure('请先结束 Cursor 授权',409);if(!this.credential)throw failure('Cursor 尚未连接');const next={...this.credential,disabled:!enabled};await this.secrets.set('cursor-account',JSON.stringify(next));this.credential=next;if(!enabled)await this.active?.cancel();await this.refresh();}
 async remove(){if(this.loginTask)throw failure('请先结束 Cursor 授权',409);await this.secrets.set('cursor-account','');this.credential=undefined;this.models=[];await this.active?.cancel();}
 async close(){this.closed=true;this.loginAbort?.abort();await this.active?.cancel().catch(()=>{});await this.loginTask;}
 async response(path:string,body:unknown,signal:AbortSignal):Promise<Response>{
  let input:ReturnType<typeof parseCursorInput>;try{input=parseCursorInput(path,body);}catch{return errorResponse('Cursor 请求格式不支持：请使用文本、函数工具及工具结果；图片、服务端工具和严格 JSON 输出暂不可用。');}
  if(!this.id)return errorResponse('Cursor 尚未授权',503);
  this.assertSource(this.id,input.model);
  if(this.closed||signal.aborted)return errorResponse('请求已取消',499);
  if(this.generating)return errorResponse('Cursor 正在处理另一个请求，请稍后重试。',429);
  const credential=this.credential!;
  this.generating=true;let temp:string|undefined;let agent:Awaited<ReturnType<(typeof import('@cursor/sdk'))['Agent']['create']>>|undefined;
  const cancel=()=>{void this.active?.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  const releases:Array<()=>void>=[];
  try{
   const {Agent,JsonlLocalAgentStore}=await this.sdk();await mkdir(join(this.root,'cursor-runs'),{recursive:true,mode:0o700});temp=await mkdtemp(join(this.root,'cursor-runs','request-'));
   const model=this.models.find(m=>`cursor/${m.id}`===input.model)!;
   const defaults=model.variants?.find(v=>v.isDefault)?.params??[];
   const params=defaults.map(p=>({...p}));
   if(input.effort){const parameter=model.parameters?.find(p=>['reasoning_effort','effort'].includes(p.id)&&p.values.some(v=>v.value===input.effort));if(parameter){const existing=params.find(p=>p.id===parameter.id);if(existing)existing.value=input.effort;else params.push({id:parameter.id,value:input.effort});}}
   const calls:CursorToolCall[]=[];let handoff!:()=>void;const toolRequested=new Promise<'tool'>(resolve=>{handoff=()=>resolve('tool');});
   const customTools:Record<string,SDKCustomTool>=Object.fromEntries(input.tools.map((tool,index)=>[`client_${index}`,{
    description:`Client tool: ${tool.name}. ${tool.description??''}`,inputSchema:tool.parameters,
    execute:(args:Record<string,import('@cursor/sdk').SDKJsonValue>)=>{
     if(tool.custom&&typeof args.input!=='string')throw new Error('Custom tool requires text input');
     calls.push({id:`call_${randomUUID().replaceAll('-','')}`,name:tool.name,arguments:JSON.stringify(args),custom:tool.custom});handoff();
     // Hold the callback until cancellation stops the SDK loop. The caller, not
     // this process, executes the tool and submits its result on the next turn.
     return new Promise<string>(resolve=>releases.push(()=>resolve('Tool execution handed back to the client.')));
    }
   }]));
   agent=await Agent.create({apiKey:credential.apiKey,model:{id:model.id,...(params.length?{params}: {})},tools:input.tools.length?['mcp']:[],mcpServers:{},agents:{},local:{cwd:temp,settingSources:[],customTools,store:new JsonlLocalAgentStore(join(temp,'store'))}});
   if(signal.aborted||this.closed||this.credential?.disabled||this.credential?.apiKey!==credential.apiKey)return errorResponse('请求已取消',499);
   this.active=await agent.send(input.prompt);if(signal.aborted)cancel();
   const wait=this.active.wait();
   const outcome=await Promise.race([wait,toolRequested]);
   let result:Awaited<typeof wait>;
   if(outcome==='tool'){
    const stopping=this.active.cancel();for(const release of releases.splice(0))release();await stopping;result=await wait;
   }else result=outcome;
   if(signal.aborted||this.closed||this.credential?.disabled||this.credential?.apiKey!==credential.apiKey)return errorResponse('请求已取消',499);
   if(!calls.length&&result.status!=='finished')return errorResponse(cursorFailure(result.error).message,502);
   if(input.required&&!calls.length)return errorResponse('Cursor 未按要求生成工具调用，请重试或选择其他模型。',502);
   let tokens:TokenUsage|undefined=result.usage??this.active.usage;
   if(!tokens&&agent.getUsage){try{const billed=await bounded(agent.getUsage(),5000);if(billed.runs.length)tokens=billed.usage;}catch{/* Unknown usage stays unknown; the gateway budget guard applies. */}}
   const usage=tokens?{input_tokens:tokens.inputTokens+tokens.cacheReadTokens+tokens.cacheWriteTokens,output_tokens:tokens.outputTokens}:undefined;
   const response=cursorResponse(path,input.model,calls.length?'':result.result??'',usage,input.stream,calls);
   if(input.limit)response.headers.set('X-Token-Flow-Output-Limit','advisory; Cursor SDK does not expose a hard output token limit');
   return response;
  }catch(error){return errorResponse(cursorFailure(error).message,signal.aborted?499:502);}
  finally{signal.removeEventListener('abort',cancel);for(const release of releases)release();if(agent){if(agent[Symbol.asyncDispose])await agent[Symbol.asyncDispose]().catch(()=>{});else agent.close();}this.active=undefined;this.generating=false;if(temp)await rm(temp,{recursive:true,force:true});}
 }
}
async function bounded<T>(promise:Promise<T>,ms:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Timeout'),{code:'deadline_exceeded'})),ms);})]);}finally{clearTimeout(timer);}
}
function cursorFailure(error:unknown){
 const e=(error??{}) as {name?:string;status?:number;code?:string};
 const auth=e.status===401||e.name==='AuthenticationError'||['unauthenticated','unauthorized'].includes(e.code??'');
 const blocked=auth||e.status===403||e.code==='plan_required';
 const message=e.code==='plan_required'?'Cursor 官方返回 plan_required：当前账号套餐不支持此 API，请在官方确认 Pro 或团队套餐后刷新。':auth?'Cursor 授权已失效，请重新连接账号。':e.status===403?'Cursor API 权限不足，请在官方账号或团队设置中确认权限。':e.status===429||e.name==='RateLimitError'?'Cursor 请求受限，请检查官方额度或稍后重试。':e.code==='deadline_exceeded'?'Cursor 连接超时，请检查网络后刷新。':e.name==='TypeError'?'Cursor 网络连接失败，请检查网络后刷新。':process.env.CURSOR_BACKEND_URL?'检测到 CURSOR_BACKEND_URL 覆盖，请移除后重启；SDK 授权与模型目录使用不同的官方地址。':'Cursor 服务或模型目录暂不可用，请刷新重试。';
 return {auth,blocked,message};
}
