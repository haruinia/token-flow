import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDesktopService } from '../packages/core/src/service.js';
import { GatewayKeys } from '../packages/core/src/gateway-keys.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function setup() {
  const root=await mkdtemp(join(tmpdir(),'scoped-models-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
  await mkdir(join(root,'cliproxy'));
  await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify(['codex','claude'].map(provider=>({name:`${provider}.json`,provider,email:`${provider}@example.test`,status:'active',models:['shared-model','second-model']}))));
  const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-sidecar-key',secrets:{get:async()=>'',set:async()=>{}}});
  cleanup.push(()=>service.app.close());
  await service.proxy.start();
  const admin={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
  return {root,port,service,admin};
}
it('registers actual namespaced aliases for duplicate provider models and restores them after restart',async()=>{
  const {service,port}=await setup();
  expect(service.proxy.snapshot().models.map(m=>m.id)).toEqual(['claude/second-model','claude/shared-model','codex/second-model','codex/shared-model']);
  for(const provider of ['codex','claude']) {
    const response=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{Authorization:'Bearer internal-sidecar-key','Content-Type':'application/json'},body:JSON.stringify({model:`${provider}/shared-model`,input:'Hi'})});
    expect((await response.json()).output[0].content[0].text).toBe(provider);
  }
  await service.proxy.stop();await service.proxy.start();expect(service.proxy.snapshot().models).toHaveLength(4);
  const codex=service.proxy.snapshot().accounts.find(a=>a.provider==='codex')!;
  await service.proxy.setAccountEnabled(codex.id,false);expect(service.proxy.snapshot().models.every(m=>m.provider==='claude')).toBe(true);
});
it('enforces key model scopes on list, Responses and Chat, isolates management and persists without plaintext',async()=>{
  const {root,port,service,admin}=await setup();
  const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Cursor',models:['codex/shared-model']}});
  expect(created.statusCode).toBe(200);const {key,apiKey}=created.json();
  const headers={host:admin.host,authorization:`Bearer ${apiKey}`};
  expect((await readFile(join(root,'gateway-keys.json'),'utf8'))).not.toContain(apiKey);
  expect((await service.app.inject({url:'/api/gateway-keys',headers:admin})).body).not.toContain(apiKey);
  const restored=await GatewayKeys.open(root);expect(restored.authenticate(apiKey)?.models).toEqual(['codex/shared-model']);
  expect((await service.app.inject({url:'/api/settings',headers})).statusCode).toBe(401);
  expect((await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{authorization:headers.authorization}})).status).toBe(401);
  const list=await service.app.inject({url:'/v1/models',headers});expect(list.json().data.map((m:{id:string})=>m.id)).toEqual(['codex/shared-model']);
  for(const model of ['claude/shared-model','shared-model','codex/second-model','codex/shared-model(high)'])for(const path of ['responses','chat/completions']) {
    expect((await service.app.inject({method:'POST',url:`/v1/${path}`,headers,payload:{model,input:'Hi'}})).statusCode).toBe(403);
  }
  // Client keys always route to the local gateway, independent of the workspace's custom provider.
  await service.app.inject({method:'PUT',url:'/api/settings',headers:admin,payload:{provider:{kind:'custom',baseURL:'http://127.0.0.1:1/v1',model:'other'}}});
  expect((await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'codex/shared-model',input:'Hi'}})).json().output[0].content[0].text).toBe('codex');
  expect((await service.app.inject({url:'/v1/models',headers:{...headers,authorization:'Bearer wrong',cookie:'agent_session=admin-token'}})).statusCode).toBe(401);
  await service.app.inject({method:'PUT',url:`/api/gateway-keys/${key.id}`,headers:admin,payload:{name:'Cursor',models:['claude/shared-model'],enabled:true}});
  expect((await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'codex/shared-model'}})).statusCode).toBe(403);
  const claude=service.proxy.snapshot().accounts.find(a=>a.provider==='claude')!;
  await service.proxy.setAccountEnabled(claude.id,false);
  expect((await service.app.inject({url:'/v1/models',headers})).json().data).toEqual([]);
  expect((await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'claude/shared-model'}})).statusCode).toBe(503);
  await service.app.inject({method:'PUT',url:`/api/gateway-keys/${key.id}`,headers:admin,payload:{name:'Cursor',models:[],enabled:true}});
  expect((await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'claude/shared-model'}})).statusCode).toBe(403);
  await service.app.inject({method:'PUT',url:`/api/gateway-keys/${key.id}`,headers:admin,payload:{name:'Cursor',models:[],enabled:false}});
  expect((await service.app.inject({url:'/v1/models',headers})).statusCode).toBe(401);
  await service.app.inject({method:'DELETE',url:`/api/gateway-keys/${key.id}`,headers:admin});
  expect((await service.app.inject({url:'/api/gateway-keys',headers:admin})).json().keys).toEqual([]);
  expect((await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'bad',models:['codex/not-loaded']}})).statusCode).toBe(400);
});
it('coalesces startup and safely closes while startup is in progress',async()=>{
  const {service}=await setup();await service.proxy.stop();
  const first=service.proxy.start();expect(service.proxy.start()).toBe(first);
  await service.proxy.shutdown();await first;
  expect(service.proxy.snapshot().state).toBe('stopped');
});

it('adapts Messages and Chat with the same key scope, forwards streams and records actual token usage only',async()=>{
 const {service,admin}=await setup();
 const {apiKey}= (await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Claude Code',models:['codex/shared-model']}})).json();
 const headers={host:admin.host,'x-api-key':apiKey,'anthropic-version':'2023-06-01'};
 for(const path of ['messages','messages/count_tokens','responses/compact','chat/completions']){
  const response=await service.app.inject({method:'POST',url:`/v1/${path}`,headers,payload:{model:'codex/shared-model',messages:[{role:'user',content:'not-for-logs'}],max_tokens:64}});
  expect(response.statusCode).toBe(200);
  if(path==='messages')expect(response.json()).toMatchObject({type:'message',content:[{type:'text',text:'codex'}]});
  if(path==='messages/count_tokens')expect(response.json()).toEqual({input_tokens:7});
  if(path==='chat/completions')expect(response.json().choices[0].message.content).toBe('codex');
  expect((await service.app.inject({method:'POST',url:`/v1/${path}`,headers,payload:{model:'claude/shared-model'}})).statusCode).toBe(403);
 }
 for(const path of ['responses','messages','chat/completions']){
  const response=await service.app.inject({method:'POST',url:`/v1/${path}`,headers,payload:{model:'codex/shared-model',messages:[{role:'user',content:'not-for-logs'}],stream:true}});
  expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('text/event-stream');expect(response.body).toContain('data:');
 }
 const report=(await service.app.inject({url:'/api/gateway/activity',headers:admin})).json();
 expect(report.total).toBe(11);expect(report.failed).toBe(4);expect(report.measured).toBe(6);expect(report.inputTokens).toBe(42);expect(report.outputTokens).toBe(18);
 expect(report.recent.filter((r:{protocol:string})=>r.protocol!=='messages/count_tokens'&&'status' in r&&r.status===200).every((r:{inputTokens:number;outputTokens:number})=>r.inputTokens===7&&r.outputTokens===3)).toBe(true);
 expect(JSON.stringify(report)).not.toContain('not-for-logs');expect(JSON.stringify(report)).not.toContain(apiKey);
 expect((await service.app.inject({url:'/api/gateway/activity',headers})).statusCode).toBe(401);
 expect((await service.app.inject({url:'/v1/models',headers:{...headers,authorization:'Bearer conflicting'}})).statusCode).toBe(401);
});

it('enforces agent protocols and persists cumulative token budgets through edits, depletion and reset',async()=>{
 const {root,service,admin}=await setup();
 const response=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Budgeted Codex',models:['codex/shared-model'],agents:['codex'],tokenLimit:15}});
 const {key,apiKey}=response.json();const headers={host:admin.host,authorization:`Bearer ${apiKey}`};
 const invoke=(path='responses')=>service.app.inject({method:'POST',url:`/v1/${path}`,headers,payload:{model:'codex/shared-model',input:'OK'}});
 expect((await invoke('messages')).statusCode).toBe(403);expect((await invoke('chat/completions')).statusCode).toBe(403);
 expect((await invoke()).statusCode).toBe(200);
 let saved=(await GatewayKeys.open(root)).authenticate(apiKey)!;expect(saved.usedTokens).toBe(10);expect(saved.pendingRequests).toBe(0);
 // Backwards-compatible name/state updates do not reset budget or agent scope.
 await service.app.inject({method:'PUT',url:`/api/gateway-keys/${key.id}`,headers:admin,payload:{name:'Renamed',models:['codex/shared-model']}});
 saved=(await service.app.inject({url:'/api/gateway-keys',headers:admin})).json().keys[0];expect(saved.tokenLimit).toBe(15);expect(saved.usedTokens).toBe(10);expect(saved.agents).toEqual(['codex']);
 // Admission ceiling: the last already-admitted response may cross the configured limit.
 expect((await invoke()).statusCode).toBe(200);expect((await invoke()).statusCode).toBe(429);
 saved=(await GatewayKeys.open(root)).authenticate(apiKey)!;expect(saved.usedTokens).toBe(20);
 expect((await service.app.inject({method:'POST',url:`/api/gateway-keys/${key.id}/reset-usage`,headers,payload:{}})).statusCode).toBe(401);
 expect((await service.app.inject({method:'POST',url:`/api/gateway-keys/${key.id}/reset-usage`,headers:admin,payload:{}})).statusCode).toBe(200);
 expect((await invoke()).statusCode).toBe(200);
});

it('blocks a finite key after a truncated stream even when initial usage was reported',async()=>{
 const {service,port,admin}=await setup();
 const {apiKey}=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'truncated',models:['codex/shared-model'],agents:['claude'],tokenLimit:1000}})).json();
 const headers={host:admin.host,authorization:`Bearer ${apiKey}`};
 await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({mode:'truncated-stream'})});
 const request={method:'POST' as const,url:'/v1/messages',headers,payload:{model:'codex/shared-model',stream:true,messages:[{role:'user',content:'Hi'}]}};
 expect((await service.app.inject(request)).statusCode).toBe(200);
 const key=(await service.app.inject({url:'/api/gateway-keys',headers:admin})).json().keys[0];
 expect(key).toMatchObject({usedTokens:7,unmeteredRequests:1,pendingRequests:0});
 expect((await service.app.inject(request)).statusCode).toBe(429);
});
it('pins A2A keys to their selected credential, blocks spoofing and fails closed when that source is disabled',async()=>{
 const {service,admin}=await setup();const source=service.proxy.snapshot().accounts.find(a=>a.provider==='codex')!;
 const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'Pinned',sourceId:source.id,models:['codex/shared-model']}});expect(created.statusCode).toBe(200);
 const headers={host:admin.host,authorization:`Bearer ${created.json().apiKey}`,'x-token-flowb-auth':'claude.json'};
 const response=await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'codex/shared-model',input:'hi'}});expect(response.statusCode).toBe(200);expect(response.json().output[0].content[0].text).toBe('codex');
 await service.proxy.setAccountEnabled(source.id,false);
 expect((await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'codex/shared-model',input:'hi'}})).statusCode).toBe(503);
});

it('retains pool credentials and inference after a quota 401, and recovers on a later check',async()=>{
 const {root,service,port,admin}=await setup();const file=join(root,'cliproxy','fixture-accounts.json');const accounts=JSON.parse(await readFile(file,'utf8'));for(const a of accounts)a.auth_index=`idx-${a.provider}`;await writeFile(file,JSON.stringify(accounts));await service.proxy.stop();await service.proxy.start();
 await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({mode:'quota-401'})});await service.proxy.refreshAccounts();await service.proxy.refreshQuota();expect(service.proxy.snapshot().accounts).toHaveLength(accounts.length);expect(JSON.parse(await readFile(file,'utf8'))).toEqual(accounts);
 const source=service.proxy.snapshot().accounts.find(a=>a.provider==='codex')!;
 expect(()=>service.proxy.sourceAuth(source.id,'codex/shared-model')).not.toThrow();
 expect(service.proxy.snapshot().quotas[source.id].status).toBe('error');
 const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'quota-independent',sourceId:source.id,models:['codex/shared-model']}});expect(created.statusCode).toBe(200);
 const response=await service.app.inject({method:'POST',url:'/v1/responses',headers:{host:admin.host,authorization:`Bearer ${created.json().apiKey}`},payload:{model:'codex/shared-model',input:'hi'}});expect(response.statusCode).toBe(200);expect(response.json().output[0].content[0].text).toBe('codex');
 await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({mode:'wait'})});await service.proxy.refreshQuota();
 expect(service.proxy.snapshot().quotas[source.id].status).toBe('ok');
});

it('explains an upstream region restriction without exposing upstream diagnostics',async()=>{
 const {service,admin,port}=await setup();const {apiKey}=(await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:'regional',models:['codex/shared-model']}})).json();
 await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({mode:'region-restricted'})});
 const response=await service.app.inject({method:'POST',url:'/v1/messages',headers:{host:admin.host,authorization:`Bearer ${apiKey}`},payload:{model:'codex/shared-model',messages:[{role:'user',content:'OK'}],max_tokens:16}});expect(response.statusCode).toBe(400);expect(response.json().error.type).toBe('region_not_supported');expect(response.body).toContain('不支持当前地区');expect(response.body).not.toContain('upstream-secret');
});
