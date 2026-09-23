import { createHash,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SDKModel,Run } from '@cursor/sdk';
import type { LocalAccount,LocalModel } from './cliproxy.js';
import type { AccountQuota } from './quota/types.js';
import type { LoginSession } from './login/types.js';

const credentialSchema=z.object({apiKey:z.string().min(1),email:z.string().optional(),apiKeyExpiresAtMs:z.number().optional(),disabled:z.boolean().default(false)});
type CursorLogin=Omit<LoginSession,'provider'>&{provider:'cursor'};
type Credential=z.infer<typeof credentialSchema>;
type Secrets={get:(name:string)=>Promise<string>;set:(name:string,value:string)=>Promise<void>};
const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const errorResponse=(message:string,status=400)=>Response.json({error:{message,type:'cursor_error'}},{status});
export const cursorCatalog={id:'cursor' as const,label:'Cursor',flow:'device' as const,hint:'官方 SDK 授权 · 文本 API（实验性）；暂不支持外部工具调用，账户剩余额度需在官方查看'};

/** Cursor's SDK is an agent runtime, not raw inference. Keep its text-only capability explicit. */
export class CursorProvider {
 private credential?:Credential;private loaded=false;private models:SDKModel[]=[];private login?:CursorLogin;
 private loginAbort?:AbortController;private loginTask?:Promise<void>;private refreshTask?:Promise<void>;
 private active?:Run;private generating=false;private closed=false;private error?:string;
 constructor(private root:string,private secrets:Secrets,private openExternal?:(url:string)=>Promise<void>){}
 private async sdk(){
  if(process.env.CURSOR_BACKEND_URL&&process.env.CURSOR_BACKEND_URL!=='https://api2.cursor.sh')throw failure('Cursor SDK 后端覆盖未获支持，请移除 CURSOR_BACKEND_URL 后重试。');
  return import('@cursor/sdk');
 }
 get id(){return this.credential?createHash('sha256').update(`cursor:${this.credential.email||this.credential.apiKey}`).digest('hex').slice(0,24):undefined;}
 owns(id:string){return !!this.id&&id===this.id;}
 async load(){if(this.loaded)return;const raw=await this.secrets.get('cursor-account');if(raw)this.credential=credentialSchema.parse(JSON.parse(raw));this.loaded=true;await this.refresh();}
 async refresh(){if(this.refreshTask)return this.refreshTask;this.refreshTask=(async()=>{
  const credential=this.credential;if(!credential||credential.disabled)return;
  try{const {Cursor}=await this.sdk();const models=await Cursor.models.list({apiKey:credential.apiKey});if(this.credential!==credential||this.closed)return;this.models=models.filter(m=>m.id&&m.id.length<280);this.error=undefined;}
  catch{if(this.credential===credential){this.models=[];this.error='Cursor 模型目录暂不可用，请检查授权或稍后刷新。';}}
 })().finally(()=>{this.refreshTask=undefined;});return this.refreshTask;}
 snapshot():{accounts:LocalAccount[];models:LocalModel[];login?:CursorLogin;quotas:Record<string,AccountQuota>}{
  const c=this.credential;const expired=!!c?.apiKeyExpiresAtMs&&c.apiKeyExpiresAtMs<=Date.now();const enabled=!!c&&!c.disabled&&!expired;
  const models=enabled?this.models.map(m=>({id:`cursor/${m.id}`,provider:'cursor' as const,textOnly:true})):[];
  return {accounts:c?[{id:this.id!,provider:'cursor',label:c.email||'Cursor SDK 账号',status:expired?'授权已过期':'active',disabled:c.disabled,unavailable:expired,models:models.map(m=>m.id)}]:[],models,login:this.login,
   quotas:c?{[this.id!]:{accountId:this.id!,provider:'cursor' as const,status:'ok' as const,observedAt:new Date().toISOString(),windows:[],note:this.error||'官方 SDK 未提供账户剩余额度；可在 Cursor 官方用量页查看。本应用调用量在 API 总览记录。'}}:{}};
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
   const {Cursor}=await this.sdk();const result=await Cursor.auth.login({store:null,backendUrl:'https://api2.cursor.sh',websiteUrl:'https://cursor.com',apiKeyName:'token-flowb',signal:controller.signal,openBrowser:false,onLoginUrl:raw=>{
    const url=new URL(raw);if(url.protocol!=='https:'||url.hostname!=='cursor.com'||url.pathname!=='/loginDeepControl')throw failure('Cursor 授权地址不合法');
    login.url=url.href;login.status='waiting_for_browser';login.message='请在 Cursor 官方页面授权；此操作会创建独立 SDK Key。';
    void this.openExternal?.(url.href).catch(()=>{});
   }});
   if(controller.signal.aborted||this.closed)return;
   const next=credentialSchema.parse(result);await this.secrets.set('cursor-account',JSON.stringify(next));this.credential=next;this.models=[];await this.refresh();
   login.status='completed';login.message='Cursor 已连接，模型目录已刷新。';
  }catch{if(login.status!=='cancelled'){login.status=controller.signal.aborted?'expired':'failed';login.message=controller.signal.aborted?'Cursor 授权已超时，请重试。':'Cursor 授权未完成，请重试。';}}
  finally{clearTimeout(timer);this.loginTask=undefined;this.loginAbort=undefined;}})();
 }
 async openLogin(id:string){if(this.login?.id!==id||!this.login.url||this.login.status!=='waiting_for_browser')throw failure('授权会话已变更');await this.openExternal?.(this.login.url);}
 cancelLogin(id:string){if(this.login?.id!==id)throw failure('授权会话已变更');this.login.status='cancelled';this.login.message='已取消 Cursor 授权。';this.loginAbort?.abort();}
 async setEnabled(enabled:boolean){if(this.loginTask)throw failure('请先结束 Cursor 授权',409);if(!this.credential)throw failure('Cursor 尚未连接');const next={...this.credential,disabled:!enabled};await this.secrets.set('cursor-account',JSON.stringify(next));this.credential=next;if(!enabled)await this.active?.cancel();await this.refresh();}
 async remove(){if(this.loginTask)throw failure('请先结束 Cursor 授权',409);await this.secrets.set('cursor-account','');this.credential=undefined;this.models=[];await this.active?.cancel();}
 async close(){this.closed=true;this.loginAbort?.abort();await this.active?.cancel().catch(()=>{});await this.loginTask;}
 async response(path:string,body:unknown,signal:AbortSignal):Promise<Response>{
  let input:ReturnType<typeof parseCursorInput>;try{input=parseCursorInput(path,body);}catch{return errorResponse('Cursor 当前仅支持文本对话；工具、图片、续接 ID、压缩及未支持的生成参数暂不可用。');}
  if(!this.id)return errorResponse('Cursor 尚未授权',503);
  this.assertSource(this.id,input.model);
  if(this.generating)return errorResponse('Cursor 正在处理另一个请求，请稍后重试。',429);
  this.generating=true;let temp:string|undefined;let agent:Awaited<ReturnType<(typeof import('@cursor/sdk'))['Agent']['create']>>|undefined;
  const cancel=()=>{void this.active?.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
   const {Agent,JsonlLocalAgentStore}=await this.sdk();await mkdir(join(this.root,'cursor-runs'),{recursive:true,mode:0o700});temp=await mkdtemp(join(this.root,'cursor-runs','request-'));
   const model=this.models.find(m=>`cursor/${m.id}`===input.model)!;
   agent=await Agent.create({apiKey:this.credential!.apiKey,model:{id:model.id,params:model.parameters?.flatMap(p=>p.values[0]?[{id:p.id,value:p.values[0].value}]:[])},tools:[],mcpServers:{},agents:{},local:{cwd:temp,settingSources:[],store:new JsonlLocalAgentStore(join(temp,'store'))}});
   if(signal.aborted)return errorResponse('请求已取消',499);
   this.active=await agent.send(input.prompt);if(signal.aborted)await this.active.cancel();
   const result=await this.active.wait();if(result.status!=='finished')return errorResponse('Cursor 调用未完成，请检查官方账号状态。',502);
   const usage=result.usage?{input_tokens:result.usage.inputTokens+result.usage.cacheReadTokens+result.usage.cacheWriteTokens,output_tokens:result.usage.outputTokens}:undefined;
   return cursorResponse(path,input.model,result.result??'',usage,input.stream);
  }catch{return errorResponse('Cursor 官方服务暂不可用，请检查账号授权和模型权限。',502);}
  finally{signal.removeEventListener('abort',cancel);agent?.close();this.active=undefined;this.generating=false;if(temp)await rm(temp,{recursive:true,force:true});}
 }
}
const textContent=z.union([z.string(),z.array(z.object({type:z.enum(['text','input_text','output_text']),text:z.string()}).strict())]);
const message=z.object({type:z.literal('message').optional(),role:z.enum(['system','developer','user','assistant']),content:textContent}).strict();
export function parseCursorInput(path:string,body:unknown){
 if(!['responses','chat/completions','messages'].includes(path))throw failure('unsupported');
 const schema=z.object({model:z.string(),stream:z.boolean().default(false),input:z.union([z.string(),z.array(message)]).optional(),messages:z.array(message).optional(),instructions:z.string().optional(),system:textContent.optional(),tools:z.array(z.never()).optional(),max_tokens:z.number().optional(),max_output_tokens:z.number().optional(),stream_options:z.object({include_usage:z.boolean()}).optional()}).strict();
 const input=schema.parse(body);const text=(v:z.infer<typeof textContent>)=>typeof v==='string'?v:v.map(p=>p.text).join('\n');
 const messages=path==='responses'?input.input:input.messages;if(!messages)throw failure('missing messages');
 // The SDK accepts one prompt. Preserve role boundaries as a transcript, without claiming raw inference semantics.
 const prompt=[input.instructions,input.system?text(input.system):undefined,typeof messages==='string'?messages:messages.map(m=>`[${m.role}]\n${text(m.content)}`).join('\n\n')].filter(Boolean).join('\n\n');
 if(!prompt.trim()||prompt.length>200000)throw failure('invalid prompt');
 // Output limits cannot currently be enforced by the SDK; do not silently ignore them.
 if(input.max_tokens!==undefined||input.max_output_tokens!==undefined)throw failure('unsupported output limit');
 return {model:input.model,stream:input.stream,prompt};
}
export function cursorResponse(path:string,model:string,text:string,usage:{input_tokens:number;output_tokens:number}|undefined,stream:boolean){
 const id=`cursor_${randomUUID()}`;const content={type:'output_text',text,annotations:[]};const item={id:`msg_${randomUUID()}`,type:'message',role:'assistant',status:'completed',content:[content]};
 const response={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model,output:[item],usage:usage?{...usage,total_tokens:usage.input_tokens+usage.output_tokens}:null};
 const chatUsage=usage?{prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,total_tokens:usage.input_tokens+usage.output_tokens}:undefined;
 const chat={id,object:'chat.completion',created:response.created_at,model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],...(chatUsage?{usage:chatUsage}:{})};
 const msg={id,type:'message',role:'assistant',model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,...(usage?{usage}:{})};
 if(!stream)return Response.json(path==='responses'?response:path==='messages'?msg:chat);
 const events:unknown[]=path==='responses'?[{type:'response.created',response:{...response,status:'in_progress',output:[],usage:null}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{...content,text:''}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:text},{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text},{type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:content},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}]:path==='messages'?[{type:'message_start',message:{...msg,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},...(usage?{usage}:{})},{type:'message_stop'}]:[{...chat,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:'stop'}]},'[DONE]'];
 return new Response(events.map((event:any,index)=>typeof event==='string'?`data: ${event}\n\n`:`${event.type?`event: ${event.type}\n`:''}data: ${JSON.stringify(path==='responses'?{...event,sequence_number:index}:event)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
}
