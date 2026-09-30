// Real desktop acceptance: temporary providers only; existing logins remain untouched.
import {mkdtemp,mkdir,readdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline';
import {createDesktopService} from '../packages/core/src/service.js';
import {connectedConfig} from '../packages/core/src/agent-connections.js';
if(process.argv[2]!=='--live')throw new Error('Explicit live opt-in required');
const providers=(process.argv[3]??'antigravity,workbuddy').split(',');
const root=await mkdtemp(join(await realpath(tmpdir()),'token-flow-desktop-acceptance-'));
const authDir=join(homedir(),'Library/Application Support/desktop-browser-agent/cliproxy/auth');
const qoderPath=join(homedir(),'.qoder/settings.json');
const qoderOriginal=await readFile(qoderPath,'utf8');
const added=new Map<string,unknown>();
const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
let service:Awaited<ReturnType<typeof createDesktopService>>|undefined;
const calls:{model:unknown;path:string;tools:boolean;toolResult:boolean;status?:number}[]=[];
try{
 await mkdir(join(root,'gateway/cliproxy/auth'),{recursive:true,mode:0o700});
 for(const provider of providers){
  for(const file of await readdir(authDir)){
   if(!file.endsWith('.json'))continue;
   const v=JSON.parse(await readFile(join(authDir,file),'utf8'));if(v.type!==provider||!v.access_token||v.disabled)continue;
   const fields=['type','provider','jwt','access_token','project_id','expired','expires_in','timestamp','uid','email','domain','proxy_url'];
   await writeFile(join(root,`gateway/cliproxy/auth/${provider}.json`),JSON.stringify(Object.fromEntries(fields.filter(k=>v[k]!==undefined).map(k=>[k,v[k]]))),{mode:0o600});break;
  }
 }
 service=await createDesktopService({root:join(root,'gateway'),proxyPort:port,binary:resolve(`sidecars/${process.platform}-${process.arch}/cliproxyapi`),token:'acceptance-admin',localKey:'acceptance-internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{qoder:join(root,'qoder.json'),codex:join(root,'codex.toml'),claude:join(root,'claude.json'),workbuddy:join(root,'workbuddy.json')},agentProcesses:async()=>[]});
 service.app.addHook('onResponse',async(req,reply)=>{if(req.url.startsWith('/v1/')&&req.method==='POST'){const b=req.body as any;calls.push({model:b?.model,path:req.url,tools:!!b?.tools?.length,toolResult:/"(function_call_output|tool_result)"|"role":"tool"/.test(JSON.stringify(b)),status:reply.statusCode});console.log(JSON.stringify({event:'request',...calls.at(-1)}));}});
 const address=await service.app.listen({host:'127.0.0.1',port:0});await service.proxy.start();
 for(let i=0;i<100&&!providers.every(p=>service!.proxy.snapshot().models.some(m=>m.id.startsWith(p+'/')));i++)await new Promise(r=>setTimeout(r,200));
 const snapshot=service.proxy.snapshot();const headers={host:new URL(address).host,authorization:'Bearer acceptance-admin'};
 const modelList=snapshot.models.map(m=>m.id);console.log(JSON.stringify({root,address,models:modelList}));
 const doc=JSON.parse(qoderOriginal);
 for(const provider of providers){
  const source=snapshot.accounts.find(a=>a.provider===provider);if(!source)throw new Error('Source not available: '+provider);
  const model=provider==='zcode'?'zcode/glm-5.1':provider==='workbuddy'?'workbuddy/hy4-preview':modelList.find(id=>id.startsWith('antigravity/')&&/flash/.test(id))??modelList.find(id=>id.startsWith('antigravity/'));
  if(!model)throw new Error('Model unavailable');
  const key=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'temporary desktop acceptance',sourceId:source.id,models:[model],agents:['codex','claude','openai']}});
  if(key.statusCode!==200)throw new Error('Cannot create scoped test key');
  const config=JSON.parse(connectedConfig('qoder',null,address,model,key.json().apiKey));
  const id=`token-flow-acceptance-${provider}`;if(doc.providers?.[id])throw new Error('Test provider already exists');
  const entry={...config.providers['token-flow'],displayName:`验收 ${provider}`,models:[{model,displayName:`验收 ${provider}`} ]};added.set(id,entry);
  doc.providers={...doc.providers,[id]:entry};
 }
 await writeFile(join(root,'qoder-original.json'),qoderOriginal,{mode:0o600});
 await writeFile(qoderPath,JSON.stringify(doc,null,2)+'\n',{mode:0o600});
 for(const provider of providers){const ws=join(root,provider+'-workspace');await mkdir(ws);await writeFile(join(ws,'probe.txt'),`ACCEPTANCE_${provider.toUpperCase()}_7391`);}
 console.log(JSON.stringify({event:'ready',root,providers:[...added.keys()]}));
 const input=createInterface({input:process.stdin});await new Promise<void>(resolve=>{input.on('line',line=>{if(line.trim()==='quit'){input.close();resolve();}});process.once('SIGTERM',()=>{input.close();resolve();});process.once('SIGINT',()=>{input.close();resolve();});});
}finally{
 const current=JSON.parse(await readFile(qoderPath,'utf8'));
 for(const [id,entry] of added){if(JSON.stringify(current.providers?.[id])===JSON.stringify(entry))delete current.providers[id];}
 const original=JSON.parse(qoderOriginal);
 await writeFile(qoderPath,JSON.stringify(current)===JSON.stringify(original)?qoderOriginal:JSON.stringify(current,null,2)+'\n',{mode:0o600});
 await service?.app.close();await writeFile(join(root,'requests.json'),JSON.stringify(calls,null,2));
 await rm(join(root,'gateway'),{recursive:true,force:true});await rm(join(root,'qoder-original.json'),{force:true});
 console.log(JSON.stringify({event:'cleaned',root,requests:calls.length}));
}
