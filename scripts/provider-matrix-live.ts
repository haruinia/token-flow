// Opt-in live source checks. Copies access tokens into a disposable service only.
import {mkdtemp,mkdir,readdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';import {join,resolve} from 'node:path';import {createServer} from 'node:net';
import {createDesktopService} from '../packages/core/src/service.js';
if(process.argv[2]!=='--live')throw new Error('Explicit --live required');
const providers=(process.argv[3]??'zcode,antigravity').split(',');
const root=await mkdtemp(join(await realpath(tmpdir()),'token-flow-provider-matrix-'));
const authDir=join(homedir(),'Library/Application Support/desktop-browser-agent/cliproxy/auth');
const alloc=createServer();await new Promise<void>(r=>alloc.listen(0,'127.0.0.1',r));const proxyPort=(alloc.address() as {port:number}).port;await new Promise<void>(r=>alloc.close(()=>r()));
let service:Awaited<ReturnType<typeof createDesktopService>>|undefined;
try{
 await mkdir(join(root,'cliproxy/auth'),{recursive:true,mode:0o700});
 for(const provider of providers){const candidates=[];for(const f of await readdir(authDir)){try{const v=JSON.parse(await readFile(join(authDir,f),'utf8'));if(v.type===provider&&v.access_token&&!v.disabled)candidates.push(v);}catch{}}
 candidates.sort((a,b)=>Date.parse(b.expired??'')-Date.parse(a.expired??''));const v=candidates[0];if(!v){console.log(JSON.stringify({provider,error:'no enabled credential'}));continue;}
 const fields=['type','provider','access_token','jwt','uid','email','domain','proxy_url','project_id','expired','expires_in','timestamp'];
 await writeFile(join(root,`cliproxy/auth/${provider}.json`),JSON.stringify(Object.fromEntries(fields.filter(k=>v[k]!==undefined).map(k=>[k,v[k]]))),{mode:0o600});
 console.log(JSON.stringify({provider,expires:v.expired,subprovider:v.provider}));}
 service=await createDesktopService({root,proxyPort,binary:resolve(`sidecars/${process.platform}-${process.arch}/cliproxyapi`),token:'matrix-admin',localKey:'matrix-internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{qoder:join(root,'qoder.json'),codex:join(root,'codex.toml'),claude:join(root,'claude.json'),workbuddy:join(root,'workbuddy.json')},agentProcesses:async()=>[]});
 const address=await service.app.listen({host:'127.0.0.1',port:0});await service.proxy.start();
 for(let i=0;i<75&&!providers.every(p=>service!.proxy.snapshot().models.some(m=>m.id.startsWith(p+'/')));i++)await new Promise(r=>setTimeout(r,200));
 if(process.env.PROBE_QUOTA_ONLY==='1')await service.proxy.refreshQuota();
 const snapshot=service.proxy.snapshot();const headers={host:new URL(address).host,authorization:'Bearer matrix-admin'};
 for(const provider of providers){const source=snapshot.accounts.find(a=>a.provider===provider);const models=snapshot.models.filter(m=>m.id.startsWith(provider+'/')).map(m=>m.id);console.log(JSON.stringify({provider,models}));if(!source)continue;
 if(process.env.PROBE_QUOTA_ONLY==='1'){const q=snapshot.quotas[source.id];console.log(JSON.stringify({provider,quotaStatus:q?.status,plan:q?.plan,windows:q?.windows.length,error:q?.error}));continue;}
 const key=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'temporary model acceptance',sourceId:source.id,models,agents:['codex','claude','openai']}});if(key.statusCode!==200)throw new Error('test key failed');
 const selected=process.argv[4]?[process.argv[4]]:models.filter(id=>provider==='zcode'?/glm-5\.1$|glm-4\.7$/.test(id):/gemini-3-flash$|gemini-3\.8-flash-high$/.test(id));
 for(const model of (selected.length?selected:models.slice(0,2))){for(const path of ['/v1/chat/completions','/v1/messages','/v1/responses']){const body=path.endsWith('responses')?{model,input:'Reply OK only.',max_output_tokens:256}:{model,messages:[{role:'user',content:'Reply OK only.'}],max_tokens:256};
 const t=Date.now();try{const response=await fetch(address+path,{method:'POST',headers:{authorization:`Bearer ${key.json().apiKey}`,'content-type':'application/json','anthropic-version':'2023-06-01'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});const raw=await response.text();let v:any;try{v=JSON.parse(raw);}catch{v={};}
 const category=/余额|balance|套餐|subscription|coding plan|insufficient/i.test(raw)?'plan or balance':/permission|forbidden|403|project/i.test(raw)?'permission denied':/401|unauth|expired/i.test(raw)?'unauthorized':/model.*(unavailable|not found)|capacity|503/i.test(raw)?'model unavailable':response.ok?'success':'other upstream error';
 const answer=v.choices?.[0]?.message?.content??v.content?.find((x:any)=>x.type==='text')?.text??v.output?.flatMap((x:any)=>x.content??[]).find((x:any)=>x.type==='output_text')?.text;
 console.log(JSON.stringify({provider,model,path,http:response.status,category,hasText:!!answer,ms:Date.now()-t,error:v.error?.type??v.error?.code}));
 }catch(e){console.log(JSON.stringify({provider,model,path,error:e instanceof Error?e.name:'error',ms:Date.now()-t}));}}
 }
 }
}finally{await service?.app.close();await rm(root,{recursive:true,force:true});}
