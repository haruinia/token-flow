import { it,expect } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { createDesktopService } from '../packages/core/src/service.js';
it('switches only permitted Codex accounts via admin API and preserves the gateway pool',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'native-account-api-'));const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy/auth'),{recursive:true});
 await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'a.json',provider:'codex',status:'active',models:['model-a']},{name:'b.json',provider:'codex',status:'active',models:['model-b']}]));
 const a=JSON.stringify({account_id:'account-a',access_token:'secret-access',refresh_token:'secret-refresh',id_token:'x.e30.x'});const b=JSON.stringify({account_id:'account-b',access_token:'secret-b'});
 await writeFile(join(root,'cliproxy/auth/a.json'),a);await writeFile(join(root,'cliproxy/auth/b.json'),b);
 const paths={qoder:join(root,'qoder/settings.json'),codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),workbuddy:join(root,'workbuddy/models.json')};
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[]});
 const headers={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
 try{
  await service.proxy.start();
  expect((await service.app.inject({url:'/api/codex-accounts',headers:{host:headers.host}})).statusCode).toBe(401);
  let status=(await service.app.inject({url:'/api/codex-accounts',headers})).json();expect(status.accounts.map((a:{switchable:boolean})=>a.switchable)).toEqual([true,false]);
  const source=service.proxy.snapshot().accounts.find(a=>a.models?.includes('codex/model-a'))!;
  const payload={revision:status.revision,sourceId:source.id,model:'codex/model-b'};
  expect((await service.app.inject({url:'/api/codex-accounts/switch',method:'POST',headers,payload})).statusCode).toBe(409);
  const switched=await service.app.inject({url:'/api/codex-accounts/switch',method:'POST',headers,payload:{...payload,model:'codex/model-a'}});expect(switched.statusCode,switched.body).toBe(200);expect(switched.body).not.toMatch(/secret-|refresh_token|access_token/);
  expect(JSON.parse(await readFile(join(root,'codex/auth.json'),'utf8')).tokens.account_id).toBe('account-a');
  expect(await readFile(join(root,'cliproxy/auth/a.json'),'utf8')).toBe(a);expect(await readFile(join(root,'cliproxy/auth/b.json'),'utf8')).toBe(b);
  status=switched.json();expect((await service.app.inject({url:'/api/codex-accounts/restore',method:'POST',headers,payload:{revision:status.revision}})).statusCode).toBe(200);
  const targets=(await service.app.inject({url:'/api/a2a',headers})).json().targets;
  expect((await service.app.inject({url:'/api/a2a/connect',method:'POST',headers,payload:{target:'codex',revision:targets.find((t:{id:string})=>t.id==='codex').revision,sourceId:source.id,model:'codex/model-a'}})).statusCode).toBe(200);
  status=(await service.app.inject({url:'/api/codex-accounts',headers})).json();expect(status.gatewayConnected).toBe(true);
  const blocked=await service.app.inject({url:'/api/codex-accounts/switch',method:'POST',headers,payload:{...payload,revision:status.revision,model:'codex/model-a'}});expect(blocked.statusCode).toBe(409);expect(blocked.body).toContain('先还原接口');
 }finally{await service.app.close();await rm(root,{recursive:true,force:true});}
});
