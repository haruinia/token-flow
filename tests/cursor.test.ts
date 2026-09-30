import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile,readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createServer} from 'node:net';
import {CursorProvider,parseCursorInput} from '../packages/core/src/cursor.js';
import {createDesktopService} from '../packages/core/src/service.js';
const sdk=vi.hoisted(()=>({login:vi.fn(),models:vi.fn(),create:vi.fn(),cancel:vi.fn(),close:vi.fn()}));
vi.mock('@cursor/sdk',()=>({Cursor:{auth:{login:sdk.login},models:{list:sdk.models}},Agent:{create:sdk.create},JsonlLocalAgentStore:class{constructor(readonly path:string){}}}));
const cleanup:Array<()=>Promise<unknown>>=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.restoreAllMocks();});
beforeEach(()=>{
 vi.clearAllMocks();sdk.login.mockImplementation(async(options)=>{options.onLoginUrl('https://cursor.com/loginDeepControl?uuid=fixture&challenge=fixture');return {apiKey:'cursor-secret-fixture',email:'cursor@example.test',apiKeyExpiresAtMs:Date.now()+86400000};});
 sdk.models.mockResolvedValue([{id:'fixture-model',displayName:'Fixture model'}]);sdk.cancel.mockResolvedValue(undefined);
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({cancel:sdk.cancel,wait:async()=>({status:'finished',result:'Cursor fixture reply',usage:{inputTokens:7,outputTokens:3,cacheReadTokens:2,cacheWriteTokens:1,totalTokens:13}})})});
});
async function setup(){const root=await mkdtemp(join(await realpath(tmpdir()),'cursor-test-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));const values=new Map<string,string>();const secrets={get:async(name:string)=>values.get(name)??'',set:async(name:string,value:string)=>{values.set(name,value);}};return {root,values,secrets};}
it('uses official login with independent credentials, discovers real account models and keeps secrets out of snapshots',async()=>{
 const {root,values,secrets}=await setup();const opened:string[]=[];const provider=new CursorProvider(root,secrets,async url=>{opened.push(url);});await provider.load();await provider.beginLogin();await expect.poll(()=>provider.snapshot().login?.status).toBe('completed');
 expect(opened[0]).toMatch(/^https:\/\/cursor.com\/loginDeepControl/);expect(sdk.login.mock.calls[0][0]).toMatchObject({store:null,backendUrl:'https://api2.cursor.sh',apiKeyName:'token-flow'});
 expect(values.get('cursor-account')).toContain('cursor-secret-fixture');expect(JSON.stringify(provider.snapshot())).not.toContain('cursor-secret-fixture');expect(provider.snapshot().models[0].id).toBe('cursor/fixture-model');
 const reopened=new CursorProvider(root,secrets);await reopened.load();expect(reopened.snapshot().accounts[0].id).toBe(provider.id);await reopened.setEnabled(false);expect(reopened.snapshot().models).toEqual([]);expect(values.get('cursor-account')).toContain('cursor-secret-fixture');await reopened.remove();expect(values.get('cursor-account')).toBe('');
});
it('does not save credentials from a cancelled login, including late SDK completion',async()=>{
 const {root,values,secrets}=await setup();let complete!:(value:unknown)=>void;sdk.login.mockImplementation(options=>{options.onLoginUrl('https://cursor.com/loginDeepControl?uuid=test');return new Promise(r=>{complete=r;});});
 const provider=new CursorProvider(root,secrets);await provider.beginLogin();await expect.poll(()=>provider.snapshot().login?.status).toBe('waiting_for_browser');provider.cancelLogin(provider.snapshot().login!.id);complete({apiKey:'must-not-save'});await provider.close();expect(values.size).toBe(0);expect(provider.snapshot().accounts).toEqual([]);
});
it('routes Cursor through the existing scoped API, meters tokens, isolates SDK tools, and denies unsupported server tools',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'cursor-secret-fixture',disabled:false}));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy','fixture-accounts.json'),'[]');
 const service=await createDesktopService({root,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),proxyPort:port,token:'admin-token',localKey:'internal-key',secrets});cleanup.push(()=>service.app.close());await service.proxy.start();await expect.poll(()=>service.proxy.snapshot().models.length).toBe(1);
 const admin={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};const account=service.proxy.snapshot().accounts[0];
 const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Cursor caller',models:['cursor/fixture-model'],sourceId:account.id,tokenLimit:100}});expect(created.statusCode,created.body).toBe(200);const client={host:admin.host,authorization:`Bearer ${created.json().apiKey}`};
 expect((await service.app.inject({url:'/v1/models',headers:client})).json().data[0].id).toBe('cursor/fixture-model');
 for(const path of ['responses','chat/completions','messages']){
  const result=await service.app.inject({method:'POST',url:`/v1/${path}`,headers:client,payload:{model:'cursor/fixture-model',...(path==='responses'?{input:'Hello'}:{messages:[{role:'user',content:'Hello'}]}),stream:true}});expect(result.statusCode,result.body).toBe(200);expect(result.body).toContain('Cursor fixture reply');
 }
 const keys=(await service.app.inject({url:'/api/gateway-keys',headers:admin})).json().keys;expect(keys[0].usedTokens).toBe(39);expect(keys[0].unmeteredRequests).toBe(0);
 const options=sdk.create.mock.calls[0][0];expect(options).toMatchObject({tools:[],mcpServers:{},agents:{},local:{settingSources:[]}});expect(options.local.cwd.startsWith(join(root,'cursor-runs'))).toBe(true);expect(sdk.close).toHaveBeenCalledTimes(3);
 const denied=await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:'cursor/fixture-model',input:'Read private files',tools:[{type:'web_search'}]}});expect(denied.statusCode).toBe(400);expect(denied.body).toContain('服务端工具');expect(sdk.create).toHaveBeenCalledTimes(3);
 await service.proxy.setAccountEnabled(account.id,false);expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:'cursor/fixture-model',input:'hi'}})).statusCode).toBe(503);
});
it('exposes explicit text API limits',()=>{
 for(const body of [{input:[{role:'user',content:[{type:'input_image',image_url:'x'}]}]},{input:'hi',previous_response_id:'old'},{input:'hi',text:{format:{type:'json_schema'}}}])expect(()=>parseCursorInput('responses',{model:'cursor/x',...body})).toThrow();
});

const tokenUsage={inputTokens:7,outputTokens:3,cacheReadTokens:2,cacheWriteTokens:1,totalTokens:13};
function toolRun(){
 sdk.create.mockImplementation(async options=>({close:sdk.close,send:async()=>{
  let finish!:(value:unknown)=>void;
  const pending=new Promise(resolve=>{finish=resolve;});
  return {usage:tokenUsage,cancel:async()=>{sdk.cancel();finish({status:'cancelled',usage:tokenUsage});},wait:()=>{
   void options.local.customTools.client_0.execute({value:'ping'},{});
   return pending;
  }};
 }}));
}
it.each(['responses','chat/completions','messages'])('hands tools to the %s client and accepts the next tool-result turn',async path=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);await provider.load();
 toolRun();const model='cursor/fixture-model';
 const fn={name:'client_echo',description:'Echo input',parameters:{type:'object',properties:{value:{type:'string'}},required:['value']}};
 const tools=path==='responses'?[{type:'function',...fn}]:path==='messages'?[{name:fn.name,description:fn.description,input_schema:fn.parameters}]:[{type:'function',function:fn}];
 const body={model,tools,...(path==='responses'?{input:'Echo ping',max_output_tokens:64}:{messages:[{role:'user',content:'Echo ping'}],max_tokens:64})};
 const response=await provider.response(path,body,new AbortController().signal);expect(response.status).toBe(200);const result=await response.json();
 const call=path==='responses'?result.output[0]:path==='messages'?result.content[0]:result.choices[0].message.tool_calls[0];
 expect(path==='chat/completions'?call.function.name:call.name).toBe('client_echo');
 expect(sdk.create.mock.calls[0][0]).toMatchObject({tools:['mcp'],mcpServers:{},agents:{},local:{settingSources:[]}});
 expect(sdk.cancel).toHaveBeenCalledOnce();expect(response.headers.get('X-Token-Flow-Output-Limit')).toContain('advisory');
 const history=path==='responses'?[{role:'user',content:'Echo ping'},...result.output,{type:'function_call_output',call_id:call.call_id,output:'pong'}]:path==='messages'?[{role:'assistant',content:result.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'pong'}]}]:[result.choices[0].message,{role:'tool',tool_call_id:call.id,content:'pong'}];
 let prompt='';sdk.create.mockResolvedValue({close:sdk.close,send:async(value:string)=>{prompt=value;return {wait:async()=>({status:'finished',result:'pong',usage:tokenUsage}),cancel:sdk.cancel};}});
 const next=await provider.response(path,{...body,...(path==='responses'?{input:history}:{messages:history}),stream:true},new AbortController().signal);
 expect(next.status).toBe(200);expect(await next.text()).toContain('pong');expect(prompt).toContain('pong');expect(prompt).toContain(call.call_id??call.id);
 await provider.close();
});
it('recovers model discovery using the official catalog without guessed models, and preserves last-known models on transient failure',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'private-fixture'}));sdk.models.mockRejectedValue(new TypeError('secret upstream details'));
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({items:[{id:'returned-model',displayName:'Returned model'}]}));
 const provider=new CursorProvider(root,secrets);await provider.load();expect(provider.snapshot().models[0].id).toBe('cursor/returned-model');expect(fetcher.mock.calls[0][0]).toBe('https://api.cursor.com/v1/models');expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
 fetcher.mockRejectedValue(new TypeError('private-fixture'));await provider.refresh();expect(provider.snapshot().models).toHaveLength(1);expect(provider.snapshot().accounts[0].modelError).toContain('网络');expect(JSON.stringify(provider.snapshot())).not.toContain('private-fixture');
 sdk.models.mockRejectedValue(Object.assign(new Error('private-fixture'),{status:401}));await provider.refresh();expect(provider.snapshot().models).toEqual([]);expect(provider.snapshot().accounts[0].modelError).toContain('重新连接');
});
it('connects Cursor to all local Agent targets and routes maintenance through the SDK instead of the sidecar',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy','fixture-accounts.json'),'[]');
 const paths={codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')};
 const service=await createDesktopService({root,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),proxyPort:port,token:'admin-token',localKey:'internal',secrets,agentPaths:paths,agentProcesses:async()=>[]});cleanup.push(()=>service.app.close());await service.proxy.start();await expect.poll(()=>service.proxy.snapshot().models.length).toBe(1);
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};const sourceId=service.proxy.cursor.id!;const model='cursor/fixture-model';
 for(const target of ['codex','claude','qoder','workbuddy']){
  const state=(await service.app.inject({url:'/api/a2a',headers})).json().targets.find((t:{id:string})=>t.id===target);
  const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target,sourceId,model,revision:state.revision}});
  expect(connected.statusCode,connected.body).toBe(200);expect(connected.json().verification.checks.every((c:{ok:boolean})=>c.ok)).toBe(true);
  expect(await readFile(paths[target as keyof typeof paths],'utf8')).toContain(model);
 }
 const selected=await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId,model}});expect(selected.statusCode,selected.body).toBe(200);
 await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
 expect(sdk.create).toHaveBeenCalled();
});
it('reports plan_required without retrying a denied catalog or presenting endless sync',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));
 sdk.models.mockRejectedValue(Object.assign(new Error('private upstream'),{status:403,code:'plan_required'}));
 const fetcher=vi.spyOn(globalThis,'fetch');const provider=new CursorProvider(root,secrets);await provider.load();
 expect(fetcher).not.toHaveBeenCalled();expect(provider.snapshot().accounts[0]).toMatchObject({status:'模型同步失败',modelError:expect.stringContaining('plan_required')});expect(provider.snapshot().models).toEqual([]);
});
it('supports Responses custom text tools and keeps their text results in the next turn',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);await provider.load();
 sdk.create.mockImplementation(async options=>({close:sdk.close,send:async()=>{
  let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
  return {cancel:async()=>finish({status:'cancelled',usage:tokenUsage}),wait:()=>{void options.local.customTools.client_0.execute({input:'*** Begin Patch\n*** End Patch'},{});return pending;}};
 }}));
 const body={model:'cursor/fixture-model',input:'Prepare a patch',tools:[{type:'custom',name:'apply_patch',description:'Apply a patch',format:{type:'text'}}],tool_choice:{type:'custom',name:'apply_patch'}};
 const response=await provider.response('responses',body,new AbortController().signal);const result=await response.json();expect(response.status).toBe(200);expect(result.output[0]).toMatchObject({type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch\n*** End Patch'});
 const next=parseCursorInput('responses',{...body,input:[...result.output,{type:'custom_tool_call_output',call_id:result.output[0].call_id,output:'Applied'}]});expect(next.prompt).toContain('Applied');
});
it('lets the real Pi Responses client consume the streamed tool call',async()=>{
 const {streamSimple}=await import('@earendil-works/pi-ai/api/openai-responses');const {normalizeContext}=await import('@earendil-works/pi-ai/utils/transcript');const {Type}=await import('typebox');
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);await provider.load();toolRun();
 const model={id:'cursor/fixture-model',name:'Fixture',api:'openai-responses' as const,provider:'token-flow',baseUrl:'http://127.0.0.1:8317/v1',reasoning:false,input:['text' as const],contextWindow:32768,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const transport:typeof fetch=async(input,init)=>{const request=new Request(input,init);return provider.response('responses',await request.json(),request.signal);};
 const events=streamSimple(model,normalizeContext({messages:[{role:'user',content:'Echo ping',timestamp:Date.now()}],tools:[{name:'client_echo',description:'Echo input',parameters:Type.Object({value:Type.String()})}]}),{apiKey:'local-fixture',fetch:transport,maxRetries:0});
 const result=await events.result();expect(result.stopReason,result.errorMessage).toBe('toolUse');expect(result.content).toContainEqual(expect.objectContaining({type:'toolCall',name:'client_echo',arguments:{value:'ping'}}));
 await provider.close();
});
it('cancels the SDK request when the client disconnects and releases the single-request slot',async()=>{
 const {root,secrets}=await setup();await secrets.set('cursor-account',JSON.stringify({apiKey:'fixture'}));const provider=new CursorProvider(root,secrets);await provider.load();
 let finish!:(result:unknown)=>void;const pending=new Promise(resolve=>{finish=resolve;});
 sdk.cancel.mockImplementation(async()=>finish({status:'cancelled'}));sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({wait:()=>pending,cancel:sdk.cancel})});
 const controller=new AbortController();const response=provider.response('responses',{model:'cursor/fixture-model',input:'hi'},controller.signal);
 await expect.poll(()=>sdk.create.mock.calls.length).toBe(1);controller.abort();expect((await response).status).toBe(499);
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({wait:async()=>({status:'finished',result:'OK',usage:tokenUsage}),cancel:sdk.cancel})});
 expect((await provider.response('responses',{model:'cursor/fixture-model',input:'hi'},new AbortController().signal)).status).toBe(200);
});
