// Explicit opt-in: uses a small amount of source quota. Never modifies the original auth or Agent config.
import {mkdtemp, mkdir, readdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {createDesktopService} from '../packages/core/src/service.js';

if(process.argv[2]!=='--live')throw new Error('Pass --live to use saved source credentials and quota.');
const provider=process.argv[3]??'qoder';
assert.ok(['qoder','workbuddy','antigravity','zcode'].includes(provider),'Choose an enabled source provider');
const model=process.argv[4]??(provider==='qoder'?'qoder/kmodel_latest':'workbuddy/glm-5.1');
const authDir=process.argv[5]??join(homedir(),'Library/Application Support/desktop-browser-agent/cliproxy/auth');
const claudeCLI=process.argv[6]??'claude';
const target=process.env.PROBE_TARGET==='workbuddy'?'workbuddy':'claude';
const autoMode=process.env.PROBE_AUTO==='1';
assert.ok(!autoMode||target==='claude','Auto Mode probe requires Claude Code');
const workbuddyCLI='/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
let credential:Record<string,unknown>|undefined;
for(const file of await readdir(authDir)){
 if(!file.endsWith('.json'))continue;
 try{const value=JSON.parse(await readFile(join(authDir,file),'utf8'));if(value.type===provider&&value.access_token&&!value.disabled){credential=value;break;}}catch{/* Unrelated auth files. */}
}
if(!credential)throw new Error('No saved active source credential.');
const root=await mkdtemp(join(await realpath(tmpdir()),'token-flow-source-live-'));
const nativeFetch=globalThis.fetch;
let service:Awaited<ReturnType<typeof createDesktopService>>|undefined;
try{
const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));
const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
globalThis.fetch=async (...args)=>{
 const response=await nativeFetch(...args);
 if(String(args[0]).startsWith(`http://127.0.0.1:${port}/v1/`)&&!response.ok){
  const text=await response.clone().text();
  let parsed:any;try{parsed=JSON.parse(text);}catch{}
  console.log(JSON.stringify({check:'upstream error',http:response.status,errorCode:parsed?.error?.code,type:parsed?.error?.type,category:/RESOURCE_EXHAUSTED|Resource has been exhausted/.test(text)?'upstream resource exhausted':/cooling down/.test(text)?'upstream cooldown':'other'}));
  const known=['upstream returned no model events','upstream reported an error','model response reported an error','upstream stream ended before completion','upstream stream read failed','invalid model response'];
  console.log(JSON.stringify({check:'sidecar failure category',provider,http:response.status,category:known.find(value=>text.includes(value))??'other'}));
 }
 return response;
};
await mkdir(join(root,'cliproxy/auth'),{recursive:true,mode:0o700});
await mkdir(join(root,'workspace'));await mkdir(join(root,'claude'));
// Access token only: this isolated probe must never rotate a shared refresh token.
const isolated=Object.fromEntries(['type','provider','jwt','access_token','uid','email','domain','proxy_url','project_id','expired','expires_in','timestamp'].filter(k=>credential![k]!==undefined).map(k=>[k,credential![k]]));
await writeFile(join(root,'cliproxy/auth/source-probe.json'),JSON.stringify(isolated),{mode:0o600});
service=await createDesktopService({root,proxyPort:port,binary:resolve(`sidecars/${process.platform}-${process.arch}/cliproxyapi`),token:'probe-admin-key',localKey:'probe-internal-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{qoder:join(root,'qoder/models.json'),codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]});
 const nativeCalls:{stream:boolean;toolResult:boolean;classifier:boolean}[]=[];
 service.app.addHook('preHandler',async req=>{if(req.url.split('?')[0]===(target==='workbuddy'?'/v1/chat/completions':'/v1/messages')){const b=req.body as {stream?:boolean;stop_sequences?:unknown;messages?:{content?:unknown}[]};console.log(JSON.stringify({check:'native request shape',maxTokens:(b as any).max_tokens,tools:(b as any).tools?.length,bodyBytes:JSON.stringify(b).length}));nativeCalls.push({stream:b.stream===true,classifier:b.stream!==true&&Array.isArray(b.stop_sequences)&&b.stop_sequences.includes("</block>"),toolResult:JSON.stringify(b.messages??[]).includes(target==='workbuddy'?'"role":"tool"':'"type":"tool_result"')});}});
 service.app.addHook('onResponse',async (req,reply)=>{if(req.url.split('?')[0]===(target==='workbuddy'?'/v1/chat/completions':'/v1/messages')){const b=req.body as {stream?:boolean};console.log(JSON.stringify({check:'native target request finished',target,provider,stream:b.stream===true,http:reply.statusCode,elapsedMs:Math.round(reply.elapsedTime)}));}});
 await service.app.listen({host:'127.0.0.1',port:0});await service.proxy.start();
 const deadline=Date.now()+15000;
 while(Date.now()<deadline&&!service.proxy.snapshot().models.some(m=>m.id===model))await new Promise(r=>setTimeout(r,200));
 const source=service.proxy.snapshot().accounts.find(a=>a.provider===provider);assert.ok(source?.models?.includes(model),'Requested source model was not discovered');
 const host=`127.0.0.1:${(service.app.server.address() as {port:number}).port}`;
 const keyResponse=await service.app.inject({method:'POST',url:'/api/gateway-keys',headers:{host,authorization:'Bearer probe-admin-key'},payload:{name:'isolated source probe',sourceId:source.id,models:[model],agents:['claude','codex','openai']}});
 assert.equal(keyResponse.statusCode,200);const {apiKey}=keyResponse.json();
 if(!autoMode&&process.env.PROBE_NATIVE_ONLY!=='1'){
 const response=await fetch(`http://${host}/v1/messages`,{method:'POST',headers:{'x-api-key':apiKey,'content-type':'application/json','anthropic-version':'2023-06-01'},body:JSON.stringify({model:model,max_tokens:1024,messages:[{role:'user',content:'Reply OK only.'}]}),signal:AbortSignal.timeout(90000)});
 const body=await response.json() as {type?:string;content?:{type:string;text?:string}[];error?:{type?:string}};
 console.log(JSON.stringify({check:'live non-streaming Messages',http:response.status,type:body.type,contentTypes:body.content?.map(c=>c.type),errorType:body.error?.type}));
 assert.equal(response.status,200);assert.equal(body.type,'message');assert.ok(body.content?.some(c=>c.text?.trim()));
 const responsesReply=await fetch(`http://${host}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify({model,max_output_tokens:1024,input:'Reply OK only.'}),signal:AbortSignal.timeout(90000)});
 const responseObject=await responsesReply.json() as {object?:string;status?:string};
 console.log(JSON.stringify({check:'live Responses API',provider,model,http:responsesReply.status,object:responseObject.object,status:responseObject.status}));
 assert.equal(responsesReply.status,200);assert.equal(responseObject.object,'response');
 // Exercise the real Pi Responses adapter, including a tool result round trip.
 const adminHeaders={host,authorization:'Bearer probe-admin-key'};
 const selected=await service.app.inject({method:'PUT',url:'/api/maintenance',headers:adminHeaders,payload:{sourceId:source.id,model}});assert.equal(selected.statusCode,200);
 const waitCare=async(field:'readiness'|'status')=>{for(let i=0;i<650;i++){const state=(await service!.app.inject({url:'/api/maintenance',headers:adminHeaders})).json();const status=field==='readiness'?state.readiness.status:state.status;if(['ready','completed','failed'].includes(status))return state;await new Promise(r=>setTimeout(r,200));}throw new Error('Pi probe timed out');};
 const checked=await waitCare('readiness');console.log(JSON.stringify({check:'real Pi Responses readiness',status:checked.readiness.status}));assert.equal(checked.readiness.status,'ready');
 const review=await service.app.inject({method:'POST',url:'/api/maintenance/run',headers:adminHeaders,payload:{prompt:'请调用 inspect_gateway 一次，然后只简短说明网关是否运行，不再重复检查。'}});assert.equal(review.statusCode,200);
 const reviewed=await waitCare('status');console.log(JSON.stringify({check:'real Pi repair tool round trip',status:reviewed.status,toolExecuted:reviewed.messages.some((m:{role:string;text:string})=>m.role==='tool'&&m.text.startsWith('inspect_gateway:'))}));assert.equal(reviewed.status,'completed');
 if(target==='workbuddy'){
  const status=(await service.app.inject({url:'/api/a2a',headers:adminHeaders})).json();
  const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers:adminHeaders,payload:{target,sourceId:source.id,model,revision:status.targets.find((t:{id:string})=>t.id===target).revision}});assert.equal(connected.statusCode,200);
 }
 }
 nativeCalls.length=0;
 const marker=`probe-${randomUUID()}`;const probeFile=join(root,'workspace/probe.txt');await writeFile(probeFile,marker);
 const env={CLAUDE_CODE_MAX_OUTPUT_TOKENS:'4096',PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,CLAUDE_CONFIG_DIR:autoMode?undefined:join(root,'claude'),WORKBUDDY_CONFIG_DIR:join(root,'workbuddy'),CODEBUDDY_CONFIG_DIR:join(root,'workbuddy'),CODEBUDDY_API_KEY:'',CODEBUDDY_GIT_REPO_SCAN_DISABLED:'1',CODEBUDDY_DISABLE_AUTO_MEMORY:'1',ANTHROPIC_BASE_URL:`http://${host}`,ANTHROPIC_AUTH_TOKEN:apiKey,ANTHROPIC_API_KEY:'',CLAUDE_CODE_OAUTH_TOKEN:'',DISABLE_TELEMETRY:'1',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
 // Auto Mode uses the installed client's feature eligibility; all model routing
 // is overridden for this child only. No permission allowlist bypass is used.
 const routing={ANTHROPIC_BASE_URL:`http://${host}`,ANTHROPIC_AUTH_TOKEN:apiKey,ANTHROPIC_API_KEY:'',ANTHROPIC_MODEL:model,ANTHROPIC_DEFAULT_OPUS_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model,ANTHROPIC_DEFAULT_HAIKU_MODEL:model,ANTHROPIC_SMALL_FAST_MODEL:model,CLAUDE_CODE_SUBAGENT_MODEL:model};
 const autoFile=join(root,'workspace/auto-result.txt');
 const prompt=autoMode?`Use Bash exactly once to execute: node -e "require('node:fs').writeFileSync('auto-result.txt','${marker}')". This writes only the test file in the current temporary directory. Do not access the network or run other commands. If approval fails, report it and stop without retrying.`:`Use Read to read ${probeFile}, then reply with exactly its contents.`;
 const cliOptions=autoMode?['--permission-mode','auto','--tools','Bash','--settings',JSON.stringify({env:routing})]:['--tools','Read','--allowedTools','Read','--setting-sources',''];
 const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((done,fail)=>{
  const child=spawn(target==='workbuddy'?process.execPath:claudeCLI,[...(target==='workbuddy'?[workbuddyCLI]:[]),'--print',prompt,'--model',model,...cliOptions,'--max-turns','3','--no-session-persistence','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],{cwd:join(root,'workspace'),env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
  child.once('error',e=>{clearTimeout(timer);fail(e);});child.once('close',code=>{clearTimeout(timer);done({code,stdout,stderr});});
 });
 if(autoMode){
 const wroteMarker=await readFile(autoFile,'utf8').then(value=>value===marker,()=>false);
 const classifierRequests=nativeCalls.filter(c=>c.classifier).length;
 const passed=result.code===0&&wroteMarker&&classifierRequests>0&&nativeCalls.some(c=>c.toolResult);
 console.log(JSON.stringify({check:'native Claude Auto Mode + Bash execution + tool result',provider,model,exitCode:result.code,passed,wroteMarker,classifierRequests,toolResultForwarded:nativeCalls.some(c=>c.toolResult)}));
 assert.ok(passed,'Auto Mode did not complete approval and execute the isolated test command.');
 }else{
 const passed=result.code===0&&result.stdout.includes(marker)&&nativeCalls.filter(c=>c.stream).length>=2&&nativeCalls.some(c=>c.toolResult)&&nativeCalls.every(c=>c.stream);
 console.log(JSON.stringify({check:`native ${target} streaming + Read tool + follow-up`,provider,model,exitCode:result.code,passed,returnedFileContents:result.stdout.includes(marker),streamRequests:nativeCalls.filter(c=>c.stream).length,toolResultForwarded:nativeCalls.some(c=>c.toolResult),malformedResponse:/malformed|no_events|StreamNoEvents/.test(result.stdout+result.stderr)}));
 assert.ok(passed,'Native target did not return the isolated file marker.');
 }
}finally{globalThis.fetch=nativeFetch;try{await service?.app.close();}finally{await rm(root,{recursive:true,force:true});}}
