// Installed Codex + fixture model. Uses an isolated profile, no real account/quota.
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {GatewayContext} from '../packages/core/src/gateway-context.js';
const model=process.argv[2]??'qoder/fixture';assert.match(model,/^(qoder|workbuddy)\/fixture$/);
const root=await mkdtemp(join(await realpath(tmpdir()),'context-codex-'));
const context=await GatewayContext.open(root);let normal=0,compacts=0,summaries=0,continued=false;
const server=createServer(async(req,res)=>{
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());

  const path=req.url?.endsWith('/compact')?'responses/compact':'responses';if(path==='responses/compact'||body.input?.some((item:{type?:string})=>item.type==='compaction_trigger'))compacts++;
  if(path==='responses'&&body.input?.some((item:{type?:string})=>item.type==='compaction'))continued=true;
  const response=await context.response(path,body,'fixture-key','fixture-source',async(_path,request)=>{
   const summary=typeof request.instructions==='string'&&request.instructions.startsWith('Summarize the supplied');
   if(summary)summaries++;else normal++;
   const count=normal;const tool=!summary&&count<=6;
   const output=tool?[{type:'function_call',id:'fc_'+count,call_id:'call_'+count,name:'exec_command',arguments:JSON.stringify({cmd:'pwd',max_output_tokens:64})}]:[{type:'message',id:'msg_'+count,role:'assistant',status:'completed',content:[{type:'output_text',text:summary?'Earlier directory checks completed. Continue the remaining checks, then say CHECKPOINT_OK.':'CHECKPOINT_OK',annotations:[]}]}];
   const usage={input_tokens:count===6?12000:100,output_tokens:10,total_tokens:count===6?12010:110};
   const result={id:'fixture-'+count,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:body.model,output,usage};
   if(!request.stream)return Response.json(result);
   const events=[{type:'response.created',response:{...result,status:'in_progress',output:[],usage:null}},{type:'response.output_item.added',output_index:0,item:output[0]},{type:'response.output_item.done',output_index:0,item:output[0]},{type:'response.completed',response:result}];
   return new Response(events.map((event,i)=>'event: '+event.type+'\ndata: '+JSON.stringify({...event,sequence_number:i})+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  });
  res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>)res.write(chunk);res.end();
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error instanceof Error?error.message:'fixture error'}}));}
});
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 await mkdir(join(root,'codex'));await mkdir(join(root,'workspace'));
 await writeFile(join(root,'codex/config.toml'),`model = "${model}"\nmodel_provider = "tokenflow"\nmodel_context_window = 32000\nmodel_auto_compact_token_limit = 10000\napproval_policy = "never"\n[analytics]\nenabled = false\n[model_providers.tokenflow]\nname = "OpenAI"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nenv_key = "TOKEN_FLOW_FIXTURE_KEY"\n`);
 const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
  const child=spawn(process.env.CODEX_TEST_BIN??'codex',['exec','--skip-git-repo-check','--sandbox','read-only','--json','Run the read-only directory checks requested by the model, then report CHECKPOINT_OK.'],{cwd:join(root,'workspace'),env:{PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,CODEX_HOME:join(root,'codex'),TOKEN_FLOW_FIXTURE_KEY:'synthetic'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const timer=setTimeout(()=>child.kill('SIGTERM'),60000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
 });
 console.log(JSON.stringify({model,code:result.code,requests:normal,compacts,summaries,continued,final:result.stdout.includes('CHECKPOINT_OK')}));
 if(result.code!==0||!compacts||!continued)console.log(result.stdout.slice(-2000),result.stderr.slice(-2000));
 assert.equal(result.code,0);assert.ok(compacts>0);assert.ok(summaries>0);assert.ok(continued);assert.ok(result.stdout.includes('CHECKPOINT_OK'));
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
