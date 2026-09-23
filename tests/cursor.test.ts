import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createServer} from 'node:net';
import {CursorProvider,parseCursorInput} from '../packages/core/src/cursor.js';
import {createDesktopService} from '../packages/core/src/service.js';
const sdk=vi.hoisted(()=>({login:vi.fn(),models:vi.fn(),create:vi.fn(),cancel:vi.fn(),close:vi.fn()}));
vi.mock('@cursor/sdk',()=>({Cursor:{auth:{login:sdk.login},models:{list:sdk.models}},Agent:{create:sdk.create},JsonlLocalAgentStore:class{constructor(readonly path:string){}}}));
const cleanup:Array<()=>Promise<unknown>>=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
beforeEach(()=>{
 vi.clearAllMocks();sdk.login.mockImplementation(async(options)=>{options.onLoginUrl('https://cursor.com/loginDeepControl?uuid=fixture&challenge=fixture');return {apiKey:'cursor-secret-fixture',email:'cursor@example.test',apiKeyExpiresAtMs:Date.now()+86400000};});
 sdk.models.mockResolvedValue([{id:'fixture-model',displayName:'Fixture model'}]);sdk.cancel.mockResolvedValue(undefined);
 sdk.create.mockResolvedValue({close:sdk.close,send:async()=>({cancel:sdk.cancel,wait:async()=>({status:'finished',result:'Cursor fixture reply',usage:{inputTokens:7,outputTokens:3,cacheReadTokens:2,cacheWriteTokens:1,totalTokens:13}})})});
});
async function setup(){const root=await mkdtemp(join(await realpath(tmpdir()),'cursor-test-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));const values=new Map<string,string>();const secrets={get:async(name:string)=>values.get(name)??'',set:async(name:string,value:string)=>{values.set(name,value);}};return {root,values,secrets};}
it('uses official login with independent credentials, discovers real account models and keeps secrets out of snapshots',async()=>{
 const {root,values,secrets}=await setup();const opened:string[]=[];const provider=new CursorProvider(root,secrets,async url=>{opened.push(url);});await provider.load();await provider.beginLogin();await expect.poll(()=>provider.snapshot().login?.status).toBe('completed');
 expect(opened[0]).toMatch(/^https:\/\/cursor.com\/loginDeepControl/);expect(sdk.login.mock.calls[0][0]).toMatchObject({store:null,backendUrl:'https://api2.cursor.sh',apiKeyName:'token-flowb'});
 expect(values.get('cursor-account')).toContain('cursor-secret-fixture');expect(JSON.stringify(provider.snapshot())).not.toContain('cursor-secret-fixture');expect(provider.snapshot().models[0].id).toBe('cursor/fixture-model');
 const reopened=new CursorProvider(root,secrets);await reopened.load();expect(reopened.snapshot().accounts[0].id).toBe(provider.id);await reopened.setEnabled(false);expect(reopened.snapshot().models).toEqual([]);expect(values.get('cursor-account')).toContain('cursor-secret-fixture');await reopened.remove();expect(values.get('cursor-account')).toBe('');
});
it('does not save credentials from a cancelled login, including late SDK completion',async()=>{
 const {root,values,secrets}=await setup();let complete!:(value:unknown)=>void;sdk.login.mockImplementation(options=>{options.onLoginUrl('https://cursor.com/loginDeepControl?uuid=test');return new Promise(r=>{complete=r;});});
 const provider=new CursorProvider(root,secrets);await provider.beginLogin();await expect.poll(()=>provider.snapshot().login?.status).toBe('waiting_for_browser');provider.cancelLogin(provider.snapshot().login!.id);complete({apiKey:'must-not-save'});await provider.close();expect(values.size).toBe(0);expect(provider.snapshot().accounts).toEqual([]);
});
it('routes Cursor through the existing scoped API, meters tokens, isolates SDK tools, and denies unsupported requests',async()=>{
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
 const denied=await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:'cursor/fixture-model',input:'Read private files',tools:[{type:'function',name:'read'}]}});expect(denied.statusCode).toBe(400);expect(denied.body).toContain('仅支持文本');expect(sdk.create).toHaveBeenCalledTimes(3);
 await service.proxy.setAccountEnabled(account.id,false);expect((await service.app.inject({method:'POST',url:'/v1/responses',headers:client,payload:{model:'cursor/fixture-model',input:'hi'}})).statusCode).toBe(503);
});
it('exposes explicit text API limits',()=>{
 for(const body of [{input:[{role:'user',content:[{type:'input_image',image_url:'x'}]}]},{input:'hi',previous_response_id:'old'},{input:'hi',max_output_tokens:1}])expect(()=>parseCursorInput('responses',{model:'cursor/x',...body})).toThrow();
});
