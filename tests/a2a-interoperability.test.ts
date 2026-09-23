import { it,expect } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { parse } from 'smol-toml';
import { createDesktopService } from '../packages/core/src/service.js';
import { connectedConfig,type Target } from '../packages/core/src/agent-connections.js';

it('shares each source with every local target, preserving the source pool during simultaneous connections and rollback',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'a2a-pool-'));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const paths={qoder:join(root,'qoder/settings.json'),codex:join(root,'codex','config.toml'),claude:join(root,'claude','settings.json'),workbuddy:join(root,'workbuddy','models.json')};
 const original={qoder:'{"theme":"system"}',codex:'model = "original"\n',claude:'{"env":{"KEEP":"yes"}}',workbuddy:'[{"id":"own-model","apiKey":"original-key"}]'};
 for(const target of Object.keys(paths) as Target[]){await mkdir(dirname(paths[target]),{recursive:true});await writeFile(paths[target],original[target]);}
 const credentials={qoder:join(root,'qoder/auth-fixture.json'),codex:join(root,'codex','auth.json'),claude:join(root,'claude','.credentials.json'),workbuddy:join(root,'workbuddy','.access_token')};
 for(const path of Object.values(credentials))await writeFile(path,'original-oauth-never-overwrite');
 await mkdir(join(root,'cliproxy'));const pool=join(root,'cliproxy','fixture-accounts.json');
 await writeFile(pool,JSON.stringify(['qoder','workbuddy','claude','codex'].map(provider=>({name:`${provider}.json`,provider,status:'active',models:['shared-model'],access_token:`original-${provider}`,refresh_token:`refresh-${provider}`}))));
 const poolBefore=await readFile(pool,'utf8');
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[]});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
 try{
  await service.proxy.start();
  await service.proxy.importLocal('workbuddy',true);expect(await readFile(pool,'utf8')).toBe(poolBefore);
  const connect=async(target:Target,provider:string)=>{
   const source=service.proxy.snapshot().accounts.find(a=>a.provider===provider)!;
   const state=(await service.app.inject({url:'/api/a2a',headers})).json();
   const result=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target,sourceId:source.id,model:`${provider}/shared-model`,revision:state.targets.find((t:{id:string})=>t.id===target).revision,tokenLimit:1000}});
   expect(result.statusCode,result.body).toBe(200);
   const text=await readFile(paths[target],'utf8');const config=target==='codex'?parse(text):JSON.parse(text);
   const key=target==='qoder'?config.providers['token-flow'].apiKey:target==='codex'?config.model_providers.token_flow.experimental_bearer_token:target==='claude'?config.env.ANTHROPIC_AUTH_TOKEN:config.at(-1).apiKey;
   const protocol=['codex','qoder'].includes(target)?'responses':target==='claude'?'messages':'chat/completions';
   const payload=['codex','qoder'].includes(target)?{input:'reply provider name'}:{messages:[{role:'user',content:'reply provider name'}],max_tokens:16};
   const call=()=>service.app.inject({method:'POST',url:`/v1/${protocol}`,headers:{host:headers.host,authorization:`Bearer ${key}`},payload:{...payload,model:`${provider}/shared-model`,stream:true}});
   const response=await call();expect(response.statusCode,response.body).toBe(200);expect(response.body).toContain(provider);
   return {id:result.json().id,key,call};
  };
  // The exact reported case: WorkBuddy consumes Qoder while supplying Claude Code.
  const qoder=await connect('workbuddy','qoder');const workbuddy=await connect('claude','workbuddy');
  expect((await workbuddy.call()).statusCode).toBe(200);
  const updated=JSON.parse(await readFile(paths.workbuddy,'utf8'));expect(updated[0].apiKey).toBe('original-key');expect(updated.map((m:{id:string})=>m.id)).toEqual(['own-model','qoder/shared-model']);
  expect((await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:qoder.id}})).statusCode).toBe(200);
  expect((await workbuddy.call()).statusCode).toBe(200);expect(await readFile(paths.workbuddy,'utf8')).toBe(original.workbuddy);
  await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:workbuddy.id}});
  // All 16 paths, including self-consumption; same model name cannot cross account boundaries.
  for(const provider of ['qoder','workbuddy','claude','codex'])for(const target of ['workbuddy','claude','codex','qoder'] as const){
   const connection=await connect(target,provider);
   const restored=await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:connection.id}});expect(restored.statusCode).toBe(200);
   expect(await readFile(paths[target],'utf8')).toBe(original[target]);expect((await connection.call()).statusCode).toBe(401);
   expect(await readFile(pool,'utf8')).toBe(poolBefore);
  }
  for(const path of Object.values(credentials))expect(await readFile(path,'utf8')).toBe('original-oauth-never-overwrite');
  expect(service.proxy.snapshot().accounts).toHaveLength(4);
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
},30000);

it('does not overwrite colliding WorkBuddy models and handles the legacy array format',()=>{
 expect(()=>connectedConfig('workbuddy','{"models":[{"id":"qoder/model"}]}','http://127.0.0.1:9527','qoder/model','key')).toThrow('同名');
 expect(()=>connectedConfig('workbuddy','{"models":{}}','http://127.0.0.1:9527','qoder/model','key')).toThrow();
 const config=JSON.parse(connectedConfig('workbuddy','[{"id":"original","url":"https://example.test"}]','http://127.0.0.1:9527','qoder/model','key'));
 expect(config).toHaveLength(2);expect(config[1].url).toBe('http://127.0.0.1:9527/v1/chat/completions');
});
