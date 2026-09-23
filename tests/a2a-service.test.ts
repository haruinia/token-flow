import { it,expect,vi } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { createDesktopService } from '../packages/core/src/service.js';
it('connects and restores a local Agent through admin APIs without exposing keys or original config',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'a2a-service-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await mkdir(join(root,'claude'));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',status:'active',models:['shared-model']}]));
 const path=join(root,'claude','settings.json');const original='{"env":{"KEEP":"private-original","ANTHROPIC_SMALL_FAST_MODEL":"volcengine_kimi-k3"}}';await writeFile(path,original);
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:join(root,'codex','config.toml'),claude:path,workbuddy:join(root,'workbuddy','models.json')},agentProcesses:async()=>[]});
 try{
  await service.proxy.start();const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
  expect((await service.app.inject({url:'/api/a2a',headers:{host:headers.host}})).statusCode).toBe(401);
  await mkdir(join(root,'codex'));const credentials=JSON.stringify({tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:'x.e30.x',account_id:'fixture-account'}});await writeFile(join(root,'codex','auth.json'),credentials);
  await service.discoverLocal();expect(service.proxy.snapshot().accounts).toHaveLength(2);
  await service.proxy.importCredential('codex',{account_id:'fixture-account',access_token:'stale-copy'},true);expect(await readFile(join(root,'cliproxy','fixture-accounts.json'),'utf8')).not.toContain('stale-copy');
  const imported=await service.app.inject({method:'POST',url:'/api/a2a/import',headers,payload:{target:'codex'}});expect(imported.statusCode).toBe(200);expect(imported.body).not.toContain('fixture-access');expect(await readFile(join(root,'codex','auth.json'),'utf8')).toBe(credentials);
  const state=(await service.app.inject({url:'/api/a2a',headers})).json();const sourceId=service.proxy.snapshot().accounts[0].id;
  expect((await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId,model:'codex/shared-model'}})).statusCode).toBe(200);
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
  const response=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target:'claude',sourceId,model:'codex/shared-model',revision:state.targets[1].revision}});expect(response.statusCode).toBe(200);expect(response.body).not.toContain('tfb_');expect(response.body).not.toContain('private-original');
  expect(response.json().review.status).toBe('running');await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().status).toBe('completed');
  const care=(await service.app.inject({url:'/api/maintenance',headers})).json();expect(care.engine).toBe('pi');expect(care.messages.some((m:{role:string;text:string})=>m.role==='tool'&&m.text.includes('主模型与辅助模型一致'))).toBe(true);expect(JSON.stringify(care)).not.toContain('tfb_');
  const config=JSON.parse(await readFile(path,'utf8'));expect(config.env.KEEP).toBe('private-original');expect(config.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^tfb_/);
  const clientHeaders={host:headers.host,authorization:`Bearer ${config.env.ANTHROPIC_AUTH_TOKEN}`};expect((await service.app.inject({url:'/v1/models',headers:clientHeaders})).statusCode).toBe(200);
  const fast=await service.app.inject({method:'POST',url:'/v1/messages',headers:clientHeaders,payload:{model:config.env.ANTHROPIC_SMALL_FAST_MODEL,messages:[{role:'user',content:'OK'}],max_tokens:16}});expect(fast.statusCode,fast.body).toBe(200);
  const restored=await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:response.json().id}});expect(restored.statusCode).toBe(200);expect(await readFile(path,'utf8')).toBe(original);expect((await service.app.inject({url:'/v1/models',headers:clientHeaders})).statusCode).toBe(401);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});

it('rechecks a saved maintenance model once after delayed catalog discovery, not on status polling',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'care-startup-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',status:'active',models:['shared-model']}]));
 const options={root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]};
 let service=await createDesktopService(options);const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
 try{
  await service.proxy.start();const sourceId=service.proxy.snapshot().accounts[0].id;
  await service.app.inject({method:'PUT',url:'/api/maintenance',headers,payload:{sourceId,model:'qoder/shared-model'}});
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status).toBe('ready');
  await service.app.close();service=await createDesktopService(options);
  const sourceAuth=service.proxy.sourceAuth.bind(service.proxy);let attempts=0;
  vi.spyOn(service.proxy,'sourceAuth').mockImplementation((id,model)=>{if(++attempts<3)throw new Error('Catalog still loading');return sourceAuth(id,model);});
  await service.discoverLocal();
  await expect.poll(async()=>(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.status,{timeout:5000}).toBe('ready');
  const first=(await service.app.inject({url:'/api/maintenance',headers})).json().readiness.checkedAt;
  for(let i=0;i<5;i++)expect((await service.app.inject({url:'/api/maintenance',headers})).json().readiness.checkedAt).toBe(first);
  expect(attempts).toBe(3);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
