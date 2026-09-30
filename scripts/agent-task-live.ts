// Explicitly authorized real-source acceptance. No original login/config writes.
import {mkdtemp,mkdir,readdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
import {createDesktopService} from '../packages/core/src/service.js';
import {connectedConfig} from '../packages/core/src/agent-connections.js';
if(process.argv[2]!=='--live')throw new Error('Use --live only with authorization to spend source quota.');
const provider=process.argv[3]??'qoder',model=process.argv[4]??'qoder/kmodel_latest';
const targets=(process.argv[5]??'codex,claude,workbuddy').split(',');
const authDir=join(homedir(),'Library/Application Support/desktop-browser-agent/cliproxy/auth');
let credential:Record<string,unknown>|undefined;
for(const file of await readdir(authDir))if(file.endsWith('.json')){try{const v=JSON.parse(await readFile(join(authDir,file),'utf8'));if(v.type===provider&&v.access_token&&!v.disabled){credential=v;break;}}catch{}}
assert.ok(credential,'No active saved source credential');
const root=await mkdtemp(join(await realpath(tmpdir()),'token-flow-agent-task-'));console.log(JSON.stringify({root,provider,model,targets}));
const alloc=async()=>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;};
const proxyPort=await alloc(),gatewayPort=await alloc(),base=`http://127.0.0.1:${gatewayPort}`;
let service:Awaited<ReturnType<typeof createDesktopService>>|undefined;let active='';let apiKey='';let summaryAnchor='';
const calls:Array<{target:string;path:string;tools:boolean;result:boolean;compact:boolean;checkpoint:boolean}>=[];
const start=async()=>{
 service=await createDesktopService({root:join(root,'gateway'),proxyPort,binary:resolve(`sidecars/${process.platform}-${process.arch}/cliproxyapi`),token:'probe-admin',localKey:'probe-internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:{qoder:join(root,'unused/qoder.json'),codex:join(root,'unused/codex.toml'),claude:join(root,'unused/claude.json'),workbuddy:join(root,'workbuddy/models.json')},agentProcesses:async()=>[]});
 service.app.addHook('preHandler',async req=>{if(req.url.startsWith('/v1/')&&req.method==='POST'){const b=req.body as Record<string,unknown>;const text=JSON.stringify(b);calls.push({target:active,path:req.url,tools:Array.isArray(b.tools)&&b.tools.length>0,result:/"(function_call_output|custom_tool_call_output|tool_result)"|"role":"tool"/.test(text),compact:req.url.endsWith('/compact')||text.includes('"compaction_trigger"'),checkpoint:text.includes('"type":"compaction"')||text.includes('<conversation_history_summary>')||(!!summaryAnchor&&text.includes(summaryAnchor))});console.log(JSON.stringify({event:'request',target:active,path:req.url,number:calls.length,compact:calls.at(-1)?.compact}));}});
 await service.app.listen({host:'127.0.0.1',port:gatewayPort});await service.proxy.start();
 for(let i=0;i<100&&!service.proxy.snapshot().models.some(m=>m.id===model);i++)await new Promise(r=>setTimeout(r,200));
 assert.ok(service.proxy.snapshot().models.some(m=>m.id===model),'source model not available');
};
const restart=async()=>{await service!.app.close();await start();console.log(JSON.stringify({event:'gateway-restarted',target:active}));};
const headers={host:`127.0.0.1:${gatewayPort}`,authorization:'Bearer probe-admin'};
const firstPrompt='Work only in this temporary project. Read math.cjs and math.test.cjs using tools. Fix add(a,b), which currently subtracts. Run node math.test.cjs and fix until it passes. Do not add multiply yet. Report the test result briefly. Never read or change files outside this project.';
const nextPrompt='Continue the same task after compaction and gateway restart. Preserve the previously fixed add function. Read the current files, implement multiply(a,b), export it too, and extend math.test.cjs with a multiply(3,4)===12 assertion. Run node math.test.cjs and fix until it passes. Work only in this project.';
async function command(bin:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,label:string){
 console.log(JSON.stringify({event:'client-start',target:active,label}));
 const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((done,fail)=>{
  const child=spawn(bin,args,{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill('SIGTERM'),240000);
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  child.once('error',e=>{clearTimeout(timer);fail(e);});child.once('close',code=>{clearTimeout(timer);done({code,stdout,stderr});});
 });
 await writeFile(join(root,active+'-'+label+'.log'),result.stdout+'\n'+result.stderr,{mode:0o600});
 console.log(JSON.stringify({event:'client-end',target:active,label,code:result.code}));assert.equal(result.code,0,active+' '+label+' failed (see isolated log)');
 const results=result.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).filter(m=>m.type==='result');
 assert.ok(!results.some(m=>m.is_error),active+' '+label+' reported a model failure despite exit code 0 (see isolated log)');return result;
}
async function verify(workspace:string,multiply=false){
 const probe=`const m=require('./math.cjs');if(m.add(2,3)!==5)process.exit(1);${multiply?"if(m.multiply(3,4)!==12)process.exit(1);":''}`;
 await command(process.execPath,['-e',probe],workspace,{PATH:process.env.PATH},multiply?'verify-final':'verify-first');
 await command(process.execPath,['math.test.cjs'],workspace,{PATH:process.env.PATH},multiply?'tests-final':'tests-first');
}
function codexProcess(workspace:string,approval?:{decision:'accept'|'decline';command:string}){
 const child=spawn('codex',['app-server','--stdio'],{cwd:workspace,env:{PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,CODEX_HOME:join(root,'codex'),TOKEN_FLOW_TEST_KEY:apiKey},stdio:['pipe','pipe','pipe']});
 let id=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();const events:any[]=[];let stderr='';child.stderr.on('data',d=>stderr+=d);
 createInterface({input:child.stdout}).on('line',line=>{let m:any;try{m=JSON.parse(line);}catch{return;}if(!m.method&&m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id)!;pending.delete(m.id);if(m.error)p.reject(new Error(JSON.stringify(m.error)));else p.resolve(m.result);}else{events.push(m);if(m.method==='turn/completed'||m.method==='error')console.log(JSON.stringify({event:m.method,status:m.params?.turn?.status,target:active}));if(m.id!==undefined){
 const expected=approval&&m.method==='item/commandExecution/requestApproval'&&[approval.command,"/bin/zsh -lc '"+approval.command+"'"].includes(m.params?.command);
 child.stdin.write(JSON.stringify(expected?{id:m.id,result:{decision:approval.decision}}:{id:m.id,error:{code:-32601,message:'Unexpected test approval command'}})+'\n');
 }}});
 const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});
 const wait=async(method:string,offset:number)=>{for(let i=0;i<2400;i++){const e=events.slice(offset).find(e=>e.method===method);if(e)return e;await new Promise(r=>setTimeout(r,100));}throw new Error('Codex event timeout: '+method);};
 return {request,events,wait,async close(){child.kill('SIGTERM');await writeFile(join(root,'codex-rpc.log'),JSON.stringify(events)+'\n'+stderr,{mode:0o600});}};
}
try{
 await mkdir(join(root,'gateway/cliproxy/auth'),{recursive:true,mode:0o700});
 const copied=Object.fromEntries(['type','provider','access_token','jwt','uid','email','domain','proxy_url','project_id','expired','expires_in','timestamp'].filter(k=>credential![k]!==undefined).map(k=>[k,credential![k]]));
 await writeFile(join(root,'gateway/cliproxy/auth/source-probe.json'),JSON.stringify(copied),{mode:0o600});
 await start();const source=service!.proxy.snapshot().accounts.find(a=>a.provider===provider)!;
 const key=await service!.app.inject({method:'POST',url:'/api/gateway-keys',headers,payload:{name:'isolated full task',sourceId:source.id,models:[model],agents:['claude','codex','openai']}});assert.equal(key.statusCode,200);apiKey=key.json().apiKey;
 const reports=[];
 for(const target of targets){
 active=target;const workspace=join(root,target+'-workspace');await mkdir(workspace);await mkdir(join(root,target),{recursive:true});
 await writeFile(join(workspace,'math.cjs'),'exports.add = (a, b) => a - b;\n');await writeFile(join(workspace,'math.test.cjs'),"const assert = require('node:assert/strict');\nconst { add } = require('./math.cjs');\nassert.equal(add(2,3),5);\nconsole.log('PASS');\n");
 const initial=calls.length;
 if(target==='codex-approval'){
  await mkdir(join(root,'codex'),{recursive:true});
  const original='approval_policy = "on-request"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[analytics]\nenabled = false\n';
  await writeFile(join(root,'codex/config.toml'),connectedConfig('codex',original,base,model,apiKey),{mode:0o600});
  for(const decision of ['decline','accept'] as const){
   const marker=decision+'.txt';const cmd='printf approved > '+marker;
   const rpc=codexProcess(workspace,{decision,command:cmd});
   try{
    await rpc.request('initialize',{clientInfo:{name:'token_flow_approval_acceptance',version:'1'},capabilities:{experimentalApi:true}});
    const thread=await rpc.request('thread/start',{cwd:workspace,model,modelProvider:'token_flow'});
    assert.equal(thread.approvalPolicy,'on-request');assert.equal(thread.sandbox.type,'readOnly');
    const offset=rpc.events.length;
    await rpc.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'This is a local permission test in this temporary folder only. Use exec_command exactly once with cmd '+JSON.stringify(cmd)+', workdir '+JSON.stringify(workspace)+', sandbox_permissions require_escalated, and a short justification requesting permission to write the test marker. If declined, stop and report the denial. Do not use alternative tools or retry. If approved, report success.'}]});
    const completed=await rpc.wait('turn/completed',offset);assert.equal(completed.params.turn.status,'completed');
    const approvals=rpc.events.slice(offset).filter(e=>e.method==='item/commandExecution/requestApproval');
    assert.equal(approvals.length,1,'Expected one real local approval callback');
    assert.ok([cmd,"/bin/zsh -lc '"+cmd+"'"].includes(approvals[0].params.command),'Model must request only the fixture command or its native shell wrapper');
    if(decision==='decline')await assert.rejects(readFile(join(workspace,marker)),{code:'ENOENT'});
    else assert.equal(await readFile(join(workspace,marker),'utf8'),'approved');
    console.log(JSON.stringify({target,decision,passed:true}));
   }finally{await rpc.close();}
  }
  assert.ok(calls.slice(initial).some(c=>c.result),'No approval result forwarded');
  reports.push({target,model,passed:true,deniedWriteBlocked:true,approvedWriteExecuted:true});continue;
 }
 if(target==='codex'){
  const original='model_context_window = 128000\nmodel_auto_compact_token_limit = 100000\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[analytics]\nenabled = false\n';
  await writeFile(join(root,'codex/config.toml'),connectedConfig('codex',original,base,model,apiKey),{mode:0o600});
  let rpc=codexProcess(workspace);let threadId='';
  try{
   await rpc.request('initialize',{clientInfo:{name:'token_flow_acceptance',version:'1'},capabilities:{experimentalApi:true}});
   const thread=await rpc.request('thread/start',{cwd:workspace,model,modelProvider:'token_flow',approvalPolicy:'never',sandbox:'workspace-write'});threadId=thread.thread.id;
   let offset=rpc.events.length;await rpc.request('turn/start',{threadId,input:[{type:'text',text:firstPrompt}]});let complete=await rpc.wait('turn/completed',offset);assert.equal(complete.params.turn.status,'completed');await verify(workspace);
   offset=rpc.events.length;await rpc.request('thread/compact/start',{threadId});await rpc.wait('turn/completed',offset);assert.ok(rpc.events.slice(offset).some(e=>e.method==='item/completed'&&e.params?.item?.type==='contextCompaction'),'Codex did not complete compaction');
  }finally{await rpc.close();}
  await restart();rpc=codexProcess(workspace);
  try{
   await rpc.request('initialize',{clientInfo:{name:'token_flow_acceptance',version:'1'},capabilities:{experimentalApi:true}});
   await rpc.request('thread/resume',{threadId,cwd:workspace});const offset=rpc.events.length;await rpc.request('turn/start',{threadId,input:[{type:'text',text:nextPrompt}]});const complete=await rpc.wait('turn/completed',offset);assert.equal(complete.params.turn.status,'completed');
   assert.ok(calls.length>initial,'Codex did not continue through gateway');
  }finally{await rpc.close();}
 }else{
  const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,CLAUDE_CONFIG_DIR:join(root,target),WORKBUDDY_CONFIG_DIR:join(root,target),CODEBUDDY_CONFIG_DIR:join(root,target),CODEBUDDY_API_KEY:'',CODEBUDDY_GIT_REPO_SCAN_DISABLED:'1',CODEBUDDY_DISABLE_AUTO_MEMORY:'1',ANTHROPIC_BASE_URL:base,ANTHROPIC_AUTH_TOKEN:apiKey,ANTHROPIC_API_KEY:apiKey,CLAUDE_CODE_OAUTH_TOKEN:'',DISABLE_TELEMETRY:'1',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  if(target==='workbuddy'){
   const status=(await service!.app.inject({url:'/api/a2a',headers})).json();const connected=await service!.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target,sourceId:source.id,model,revision:status.targets.find((t:{id:string})=>t.id===target).revision}});assert.equal(connected.statusCode,200);
  }
  const bin=target==='workbuddy'?process.execPath:'claude';const prefix=target==='workbuddy'?['/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy']:[];
  if(target==='workbuddy'&&process.env.WORKBUDDY_APPROVAL_ONLY==='1'){
   for(const allowed of [false,true]){
    const marker=allowed?'accept.txt':'decline.txt',cmd='printf approved > '+marker;
    let approvals=0;
    const child=spawn(bin,[...prefix,'--print','--model',model,'--tools','Bash','--permission-mode','default','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--input-format','stream-json','--output-format','stream-json','--verbose'],{cwd:workspace,env,stdio:['pipe','pipe','pipe']});
    const logs:string[]=[];child.stderr.on('data',d=>logs.push(String(d)));
    try{
     await new Promise<void>((done,fail)=>{
      const timer=setTimeout(()=>fail(new Error('WorkBuddy approval timed out')),90000);
      child.once('error',e=>{clearTimeout(timer);fail(e);});
      child.once('close',()=>{clearTimeout(timer);fail(new Error('WorkBuddy exited before result'));});
      createInterface({input:child.stdout}).on('line',line=>{
       logs.push(line);let m:any;try{m=JSON.parse(line);}catch{return;}
       if(m.type==='control_request'&&m.request?.subtype==='can_use_tool'){
        const expected=m.request.tool_name==='Bash'&&m.request.input?.command===cmd;approvals++;
        child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{allowed:allowed&&expected,reason:allowed&&expected?'Approved isolated test command':'Denied by test operator',interrupt:false}}})+'\n');
        if(!expected){clearTimeout(timer);fail(new Error('Unexpected approval command'));}
       }
       if(m.type==='result'){clearTimeout(timer);m.is_error?fail(new Error('WorkBuddy result reported failure')):done();}
      });
      child.stdin.write(JSON.stringify({type:'user',session_id:'',message:{role:'user',content:'Use Bash exactly once to run '+JSON.stringify(cmd)+' in the current test folder. If the operator denies permission, stop and report denial. Do not retry or use another tool.'},parent_tool_use_id:null})+'\n');
     });
     assert.equal(approvals,1,'Expected one native WorkBuddy permission callback');
     if(!allowed)await assert.rejects(readFile(join(workspace,marker)),{code:'ENOENT'});
     else assert.equal(await readFile(join(workspace,marker),'utf8'),'approved');
     console.log(JSON.stringify({target,allowed,approvalPassed:true}));
    }finally{child.kill('SIGTERM');await writeFile(join(root,`workbuddy-approval-${allowed}.log`),logs.join('\n'),{mode:0o600});}
   }
   reports.push({target,model,approvalPassed:true});continue;
  }
  const common=['--print','--model',model,'--tools','Read,Edit,Write,Bash','--allowedTools','Read','Edit','Write','Bash(node *)','--max-turns','15','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--output-format','stream-json','--verbose'];
  const session=randomUUID();await command(bin,[...prefix,...common,'--session-id',session,firstPrompt],workspace,env,'first');await verify(workspace);
  const before=calls.length;const compact=await command(bin,[...prefix,...common,'--resume',session,`${target==='workbuddy'&&process.env.WORKBUDDY_NATIVE_COMPACT==='1'?'/_compact':'/compact'} Preserve completed edits, test results, and the pending requirement to implement multiply.`],workspace,env,'compact');
  assert.ok(calls.length>before,'No real summarization request');
  if(target==='workbuddy'){
   const flags:{file:string;isCompacted:boolean;isSummary:boolean;compactBoundary:boolean}[]=[];
   for(const file of await readdir(join(root,target),{recursive:true})){
    if(!/\.(jsonl|json|log)$/.test(file)||file==='models.json')continue;
    const text=await readFile(join(root,target,file),'utf8').catch(()=>'');
    const isCompacted=/"isCompacted"\s*:\s*true/.test(text),isSummary=/"isSummary"\s*:\s*true/.test(text),compactBoundary=text.includes('compact_boundary');
    if(isCompacted||isSummary||compactBoundary)flags.push({file,isCompacted,isSummary,compactBoundary});
   }
   await writeFile(join(root,'compact-metadata.json'),JSON.stringify(flags,null,2));
   console.log(JSON.stringify({event:'native-compact-markers',files:flags.length}));
   assert.ok(flags.length>0,'Native WorkBuddy history has no compact boundary or persisted summary');
  }else assert.ok(/compact_boundary|compact.*completed|compacted/i.test(compact.stdout),'Client did not produce its compaction output');
  if(target==='workbuddy'){
   // Native clients may strip the XML envelope before persisting the summary.
   // Check actual generated content, not the presentation-only wrapper.
   const messages=compact.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
   const summary=messages.filter(m=>m.type==='assistant').flatMap(m=>m.message?.content??[]).find(c=>c.type==='text'&&c.text?.includes('<conversation_history_summary>'))?.text??'';
   const plain=summary.replace(/<[^>]+>/g,'').trim();
   summaryAnchor=JSON.stringify(plain.slice(0,160)).slice(1,-1);
   assert.ok(summaryAnchor.length>=80,'Missing summary content');
  }
  await restart();const continuedAt=calls.length;await command(bin,[...prefix,...common,'--resume',session,nextPrompt],workspace,env,'continue');
  if(target==='workbuddy')assert.ok(calls.slice(continuedAt).some(c=>c.checkpoint),'WorkBuddy did not reuse the actual summary');
 }
 await verify(workspace,true);const own=calls.slice(initial);assert.ok(own.some(c=>c.result),'No tool result forwarded');
 const report={target,model,passed:true,requests:own.length,toolResultRequests:own.filter(c=>c.result).length,restarted:true};reports.push(report);console.log(JSON.stringify(report));
 }
 await writeFile(join(root,'report.json'),JSON.stringify({reports,calls},null,2));
}finally{
 await service?.app.close();
 await writeFile(join(root,'requests.json'),JSON.stringify(calls,null,2));
 // Keep only test projects/logs as evidence. Delete all copied credentials,
 // generated API keys and client configuration even if an assertion fails.
 for(const name of ['gateway','codex','claude','workbuddy','unused'])await rm(join(root,name),{recursive:true,force:true});
}
