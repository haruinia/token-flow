import { crc32, inflateSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDesktopService } from '../packages/core/src/service.js';
import { ResponsesProvider, providerSchema } from '../packages/core/src/providers.js';
import { CLIProxyManager } from '../packages/core/src/cliproxy.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function root(){const p=await mkdtemp(join(tmpdir(),'browser-api-'));cleanup.push(()=>rm(p,{recursive:true,force:true}));return p;}
it('authenticates local API, blocks hostile origins/hosts and forwards SSE without exposing provider keys',async()=>{
 const upstream=createServer((req,res)=>{
   if(req.headers.authorization!=='Bearer provider-secret'){res.writeHead(401);res.end();return;}
   if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model',object:'model'}]}));return;}
   res.setHeader('content-type','text/event-stream');res.end('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n');
 });await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>upstream.close(()=>r())));
 const dir=await root();const service=await createDesktopService({root:dir,binary:'/missing',token:'local-token',localKey:'local-proxy-key',headless:true,secrets:{get:async()=> 'provider-secret',set:async()=>{}}});cleanup.push(()=>service.app.close());
 const headers={host:'127.0.0.1:9527',authorization:'Bearer local-token'};
 expect((await service.app.inject({url:'/api/settings',headers:{host:headers.host}})).statusCode).toBe(401);
 expect((await service.app.inject({url:'/api/settings',headers:{...headers,origin:'https://evil.test'}})).statusCode).toBe(403);
 expect((await service.app.inject({url:'/api/settings',headers:{...headers,host:'evil.test'}})).statusCode).toBe(403);
 expect((await service.app.inject({url:'/api/settings',headers:{host:headers.host,cookie:'agent_session=local-token'}})).statusCode).toBe(200);
 const config={kind:'custom',baseURL:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,model:'fixture-model',historyMode:'stateless',reasoning:'off'};
 expect((await service.app.inject({method:'PUT',url:'/api/settings',headers,payload:{provider:config}})).statusCode).toBe(200);
 const settings=await service.app.inject({url:'/api/settings',headers});expect(settings.body).not.toContain('provider-secret');
 expect((await service.app.inject({url:'/v1/models',headers})).json().data[0].id).toBe('fixture-model');
 const streamed=await service.app.inject({method:'POST',url:'/v1/responses',headers,payload:{model:'fixture-model',input:'Hi',stream:true}});expect(streamed.headers['content-type']).toContain('event-stream');expect(streamed.body).toContain('[DONE]');
 expect((await readFile(join(dir,'settings.json'),'utf8'))).not.toContain('secret');
 // 桌面操作默认关闭、仅内存态；开启需要显式请求，且不会写入 settings.json。
 expect((await service.app.inject({url:'/api/desktop',headers})).json()).toMatchObject({enabled:false,supported:['darwin','win32'].includes(process.platform)});
 const toggled=await service.app.inject({method:'POST',url:'/api/desktop',headers,payload:{enabled:true}});
 if(['darwin','win32'].includes(process.platform)){expect(toggled.json().enabled).toBe(true);expect((await service.app.inject({url:'/api/desktop',headers})).json().enabled).toBe(true);}else{expect(toggled.statusCode).toBe(400);}
 expect((await service.app.inject({method:'POST',url:'/api/desktop',headers,payload:{enabled:'yes'}})).statusCode).toBe(400);
 expect((await readFile(join(dir,'settings.json'),'utf8'))).not.toContain('desktop');
 expect(()=>providerSchema.parse({...config,baseURL:'http://public.example/v1'})).toThrow();expect(()=>providerSchema.parse({...config,baseURL:'https://user:pass@example.org/v1'})).toThrow();
});
it('probes actual Responses/tool continuation capabilities instead of assuming model compatibility',async()=>{
 let count=0;let imageValid=false;let effort='';
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);count++;
   if(request.reasoning)effort=request.reasoning.effort;
   const image=Array.isArray(request.input)?request.input[0]?.content?.find?.((item:{type:string})=>item.type==='input_image'):undefined;
   if(image){
     const png=Buffer.from(image.image_url.split(',')[1],'base64');let offset=8;imageValid=png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
     while(offset<png.length){const length=png.readUInt32BE(offset);const type=png.toString('ascii',offset+4,offset+8);const data=png.subarray(offset+8,offset+8+length);
       imageValid &&= crc32(png.subarray(offset+4,offset+8+length))===png.readUInt32BE(offset+8+length);
       if(type==='IHDR')imageValid &&= data.readUInt32BE(0)===64 && data.readUInt32BE(4)===64;
       if(type==='IDAT')imageValid &&= inflateSync(data).length===(64*3+1)*64;
       offset+=length+12;
     }
   }
   res.setHeader('content-type','application/json');
   if(request.previous_response_id){res.writeHead(400);res.end('{"error":{"message":"unsupported"}}');return;}
   const output=request.tool_choice?[{type:'function_call',name:'probe_echo',call_id:'probe-1',arguments:'{"value":"ping"}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}];
   res.end(JSON.stringify({id:`r-${count}`,status:'completed',output}));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
 const client=new ResponsesProvider({kind:'custom',baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,model:'test',historyMode:'stateless',reasoning:'high'},'test');
 const result=await client.probe();expect(result.responses&&result.functionCall&&result.functionOutput&&result.imageInput&&result.reasoning).toBe(true);expect(result.previousResponseId).toBe(false);expect(count).toBe(6);expect(imageValid).toBe(true);expect(effort).toBe('high');
});
it('starts the real CLIProxyAPI binary with private app config and preserves an occupied service',async()=>{
 const dir=await root();const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const binary=resolve('sidecars',`${process.platform}-${process.arch}`,process.platform==='win32'?'cliproxyapi.exe':'cliproxyapi');
 const manager=new CLIProxyManager(dir,binary,'test-random-local-key-42',port);cleanup.push(()=>manager.shutdown());
 expect((await manager.start()).state).toBe('running');
 expect((await fetch(`http://127.0.0.1:${port}/v1/models`)).status).toBe(401);
 const response=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{Authorization:'Bearer test-random-local-key-42'}});expect(response.ok).toBe(true);expect((await response.json()).data).toEqual([]);
 expect((await stat(join(dir,'cliproxy','config.yaml'))).mode&0o777).toBe(0o600);
 const other=new CLIProxyManager(await root(),binary,'other-key',port);await expect(other.start()).rejects.toThrow('占用');expect((await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{Authorization:'Bearer test-random-local-key-42'}})).ok).toBe(true);
 const login=await manager.login('codex');
 expect(login.loginState).toBe('waiting_for_browser');
 expect(new URL(login.login!.url!).hostname).toBe('auth.openai.com');
 expect((await fetch(`http://127.0.0.1:${port}/v0/management/auth-files`)).status).toBe(401);
 await manager.cancelLogin(login.login!.id);expect(manager.snapshot().loginState).toBe('cancelled');
 await manager.stop();expect(manager.snapshot().state).toBe('stopped');
});
it('exposes a copyable Local Agent API key without putting it in the status snapshot, and rotates it on a running sidecar',async()=>{
 const dir=await root();const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
 const binary=resolve('sidecars',`${process.platform}-${process.arch}`,process.platform==='win32'?'cliproxyapi.exe':'cliproxyapi');
 let stored='';
 const service=await createDesktopService({root:dir,binary,token:'local-token',localKey:'test-random-local-key-42',proxyPort:port,headless:true,secrets:{get:async()=>stored,set:async(_name,value)=>{stored=value;}}});cleanup.push(()=>service.app.close());
 const headers={host:'127.0.0.1:9527',authorization:'Bearer local-token'};
 expect((await service.app.inject({url:'/api/local-agent/gateway',headers:{host:headers.host}})).statusCode).toBe(401);
 const gateway=(await service.app.inject({url:'/api/local-agent/gateway',headers})).json();
 expect(gateway).toMatchObject({baseURL:`http://127.0.0.1:${port}/v1`,apiKey:'test-random-local-key-42',running:false});
 expect(JSON.stringify((await service.app.inject({url:'/api/local-agent',headers})).json())).not.toContain('test-random-local-key-42');
 expect((await service.app.inject({method:'PUT',url:'/api/local-agent/gateway',headers,payload:{apiKey:'short'}})).statusCode).toBe(400);
 await service.proxy.start();
 expect((await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{Authorization:'Bearer test-random-local-key-42'}})).ok).toBe(true);
 const rotated=(await service.app.inject({method:'PUT',url:'/api/local-agent/gateway',headers,payload:{apiKey:'rotated-local-client-key'}})).json();
 expect(rotated.apiKey).toBe('rotated-local-client-key');expect(stored).toBe('rotated-local-client-key');expect(rotated.running).toBe(true);
 expect((await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{Authorization:'Bearer test-random-local-key-42'}})).status).toBe(401);
 expect((await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{Authorization:'Bearer rotated-local-client-key'}})).ok).toBe(true);
});
it('distinguishes upstream transport failures and skips dependent history probes without leaking error bodies',async()=>{
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);
   const message=request.model==='tls'?'auth_unavailable: last error TLS handshake timeout https://secret.invalid/token':request.model==='eof'?'Post https://secret.invalid/token EOF':'auth_unavailable: no auth available';
   res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message}}));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
 const config={kind:'custom' as const,baseURL:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,historyMode:'stateless' as const,reasoning:'off' as const};
 for(const [model,expected] of [['tls','TLS 握手超时'],['eof','连接意外断开'],['auth','暂无可用上游账号']]){
   const result=await new ResponsesProvider({...config,model},'fixture-key').probe();
   expect(result.responses).toBe(false);expect(result.errors.responses).toContain(expected);
   expect(result.errors.previousResponseId).toMatch(/^未执行：/);expect(JSON.stringify(result)).not.toContain('secret.invalid');
 }
});
it('loads settings.json with engine property and recovers gracefully from corrupted files',async()=>{
 const dir=await root();
 const payload={kind:'custom',engine:'pi',baseURL:'http://127.0.0.1:8317/v1',model:'gemini-3.8-flash-high',historyMode:'stateless',reasoning:'off'};
 await writeFile(join(dir,'settings.json'),JSON.stringify(payload,null,2));
 const service=await createDesktopService({root:dir,binary:'/missing',token:'local-token',localKey:'local-proxy-key',headless:true,secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(()=>service.app.close());
 const headers={host:'127.0.0.1:9527',authorization:'Bearer local-token'};
 const res=await service.app.inject({url:'/api/settings',headers});
 expect(res.statusCode).toBe(200);
 expect(res.json().provider).toMatchObject({kind:'custom',engine:'pi',model:'gemini-3.8-flash-high'});

 const corruptDir=await root();
 await writeFile(join(corruptDir,'settings.json'),'{ invalid json syntax');
 const fallbackService=await createDesktopService({root:corruptDir,binary:'/missing',token:'local-token',localKey:'local-proxy-key',headless:true,secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(()=>fallbackService.app.close());
 const fallbackRes=await fallbackService.app.inject({url:'/api/settings',headers});
 expect(fallbackRes.statusCode).toBe(200);
 expect(fallbackRes.json().provider.kind).toBe('cliproxy');
});
