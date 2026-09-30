import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createDesktopService} from '../packages/core/src/service.js';
import {GatewayKeys} from '../packages/core/src/gateway-keys.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())await fn();});
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'context-service-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify(['qoder','workbuddy','codex'].map(provider=>({name:provider+'.json',provider,email:provider+'@example.test',status:'active',models:['model']}))));
 const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'admin-token',localKey:'internal-key',secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(()=>service.app.close());await service.proxy.start();
 const admin={host:'127.0.0.1:9527',authorization:'Bearer admin-token'};
 return {root,port,service,admin};
}
const transcript=[{role:'user',content:'Keep /app/main.ts compatible.'},{role:'assistant',content:'Already checked: '.repeat(1000)},{role:'user',content:'Test it.'},{role:'assistant',content:'Passed.'},{role:'user',content:'Continue.'}];
it('gateway authenticates and pins compaction, charges summary usage, resumes history and leaves native providers on their native route',async()=>{
 const {root,port,service,admin}=await setup();
 const originalFetch=globalThis.fetch;const calls:Array<{path:string;body:Record<string,unknown>;pin:string|null}>=[];
 vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
  const parsed=new URL(String(url));
  if(parsed.port===String(port)&&parsed.pathname.startsWith('/v1/responses')){
   const body=JSON.parse(String(init?.body));calls.push({path:parsed.pathname,body,pin:new Headers(init?.headers).get('X-Token-Flow-Auth')});
   return Response.json(parsed.pathname.endsWith('/compact')?{object:'response.compaction',output:[],usage:{input_tokens:1,output_tokens:1}}:{id:'upstream',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Compatibility preserved. Tests passed.'}]}],usage:{input_tokens:7,output_tokens:3,total_tokens:10}});
  }
  return originalFetch(url,init);
 });
 for(const provider of ['qoder','workbuddy']){
  const account=service.proxy.snapshot().accounts.find(a=>a.provider===provider)!;
  const created=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:admin,payload:{name:provider,sourceId:account.id,models:[provider+'/model'],agents:['codex'],tokenLimit:1000}});
  const {apiKey}=created.json();const headers={host:admin.host,authorization:'Bearer '+apiKey};
  const compact=await service.app.inject({method:'POST',url:'/v1/responses/compact',headers,payload:{model:provider+'/model',input:transcript}});
  expect(compact.statusCode).toBe(200);expect(compact.json().object).toBe('response.compaction');expect(calls.at(-1)?.path).toBe('/v1/responses');expect(calls.at(-1)?.pin).toBe(provider+'.json');
  const first=await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:provider+'/model',input:[...compact.json().output,{role:'user',content:'Inspect next.'}]}});
  expect(first.statusCode).toBe(200);expect(first.json().id).toMatch(/^resp_tf_/);expect(JSON.stringify(calls.at(-1)?.body.input)).toContain('Tests passed');
  const next=await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:provider+'/model',previous_response_id:first.json().id,input:'Next step',store:false}});
  expect(next.statusCode).toBe(200);expect(calls.at(-1)?.body).not.toHaveProperty('previous_response_id');expect(JSON.stringify(calls.at(-1)?.body.input)).toContain('Inspect next.');
  const keys=await GatewayKeys.open(root);expect(keys.authenticate(apiKey)).toMatchObject({usedTokens:30,unmeteredRequests:0,pendingRequests:0});
  const count=calls.length;
  const bad=await service.app.inject({method:'POST',url:'/v1/responses/compact',headers,payload:{model:'codex/model',input:transcript}});expect(bad.statusCode).toBe(403);expect(calls).toHaveLength(count);
 }
 const native=await service.app.inject({method:'POST',url:'/v1/responses/compact',headers:admin,payload:{model:'codex/model',input:transcript}});expect(native.statusCode).toBe(200);expect(calls.at(-1)?.path).toBe('/v1/responses/compact');
});
