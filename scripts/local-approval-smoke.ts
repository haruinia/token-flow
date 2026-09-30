// Real Codex client, synthetic Responses model, isolated config/workspace.
// No provider credentials or quota. The only command writes a test marker.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {connectedConfig} from '../packages/core/src/agent-connections.js';

const root=await mkdtemp(join(await realpath(tmpdir()),'local-approval-'));
const workspace=join(root,'workspace'),configDir=join(root,'codex');
let decision:'accept'|'decline'='decline',calls=0,approvals=0,toolResults=0;
const server=createServer(async(req,res)=>{
 try{
  assert.equal(req.url,'/v1/responses');assert.equal(req.headers.authorization,'Bearer fixture-key');
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());calls++;
  assert.equal(body.model,'codex/fixture');
  const results=body.input.filter((item:{type:string})=>item.type==='function_call_output');
  if(results.length)toolResults++;
  const output=results.length?[{type:'message',id:`msg_${calls}`,role:'assistant',status:'completed',content:[{type:'output_text',text:'APPROVAL_CHECK_DONE',annotations:[]}]}]:[
   {type:'function_call',id:`fc_${calls}`,call_id:`call_${calls}`,name:'exec_command',arguments:JSON.stringify({cmd:`printf local-client-approved > ${decision}.txt`,workdir:workspace,max_output_tokens:128,sandbox_permissions:'require_escalated',justification:'Allow writing this isolated test marker?'})},
  ];
  const response={id:`resp_${calls}`,object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'completed',output,usage:{input_tokens:100,output_tokens:20,total_tokens:120}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[],usage:null}},{type:'response.output_item.added',output_index:0,item:output[0]},{type:'response.output_item.done',output_index:0,item:output[0]},{type:'response.completed',response}];
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map((event,i)=>`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number:i})}\n\n`).join(''));
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:String(error)}}));}
});
let child:ReturnType<typeof spawn>|undefined;
try{
 await mkdir(workspace);await mkdir(configDir);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 const original='approval_policy = "on-request"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[analytics]\nenabled = false\n';
 await writeFile(join(configDir,'config.toml'),connectedConfig('codex',original,`http://127.0.0.1:${port}`,'codex/fixture','fixture-key'));
 child=spawn(process.env.CODEX_TEST_BIN??'codex',['app-server','--stdio'],{cwd:workspace,env:{PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,CODEX_HOME:configDir},stdio:['pipe','pipe','pipe']});
 let stderr='',nextId=0;
 const events:any[]=[];
 const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 const send=(value:unknown)=>child!.stdin!.write(JSON.stringify(value)+'\n');
 child.stderr!.on('data',data=>stderr+=data);
 const closed=new Promise<void>(resolve=>child!.once('close',()=>resolve()));
 const failure=(message:string)=>{for(const p of pending.values())p.reject(new Error(message));pending.clear();};
 child.on('error',error=>failure(error.message));
 child.on('close',code=>failure(`Codex exited ${code}: ${stderr.slice(-2000)}`));
 createInterface({input:child.stdout!}).on('line',line=>{
  let message:any;try{message=JSON.parse(line);}catch{return;}
  if(message.method){
   events.push(message);
   // Decisions belong to this test client, never to the model/proxy.
   if(message.id!==undefined){
    if(message.method==='item/commandExecution/requestApproval'){
     approvals++;
     send({id:message.id,result:{decision}});
    }else send({id:message.id,error:{code:-32601,message:'Unexpected fixture callback'}});
   }
  }else if(pending.has(message.id)){
   const p=pending.get(message.id)!;pending.delete(message.id);
   if(message.error)p.reject(new Error(JSON.stringify(message.error)));else p.resolve(message.result);
  }
 });
 const request=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});send({id,method,params});});
 const timeout=setTimeout(()=>{failure('Local approval smoke timed out');child?.kill('SIGTERM');},45000);
 try{
  await request('initialize',{clientInfo:{name:'token_flow_local_approval_test',version:'1'},capabilities:{experimentalApi:true}});
  send({method:'initialized'});
  for(const choice of ['decline','accept'] as const){
   decision=choice;
   // Do not override approval/sandbox in thread/start: exercise the saved config.
   const thread=await request('thread/start',{cwd:workspace});
   assert.equal(thread.approvalPolicy,'on-request');
   assert.equal(thread.sandbox.type,'readOnly');
   const offset=events.length,beforeApprovals=approvals;
   await request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Run the model-requested fixture command, subject to local client approval.'}]});
   const end=Date.now()+15000;let completed:any;
   while(Date.now()<end){
    completed=events.slice(offset).find(e=>e.method==='turn/completed');if(completed)break;
    await new Promise(r=>setTimeout(r,50));
   }
   assert.ok(completed,JSON.stringify(events.slice(offset))+'\n'+stderr.slice(-1500));
   assert.equal(completed.params.turn.status,'completed');
   assert.equal(approvals,beforeApprovals+1,'Each unsafe-by-default write requires local approval');
   if(choice==='decline')await assert.rejects(readFile(join(workspace,'decline.txt')),{code:'ENOENT'});
   else assert.equal(await readFile(join(workspace,'accept.txt'),'utf8'),'local-client-approved');
  }
  assert.equal(toolResults,2,'Both rejection and execution results must return to the model');
  console.log(JSON.stringify({client:'Codex',source:'synthetic Responses API',calls,approvals,toolResults,deniedWriteBlocked:true,approvedWriteExecuted:true,policy:'inherited from local config'}));
 }finally{clearTimeout(timeout);child.kill('SIGTERM');await closed;}
}finally{
 child?.kill('SIGTERM');server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});
}
