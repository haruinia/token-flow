#!/usr/bin/env node
// Test-only OAuth server. Never connects to a real provider or opens a browser.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const config = readFileSync(process.argv[process.argv.indexOf('-config') + 1], 'utf8');
const port = Number(config.match(/^port: (\d+)/m)[1]);
const key = JSON.parse(config.match(/^  - (.+)/m)[1]);
const managementKey = JSON.parse(config.match(/^  secret-key: (.+)/m)[1]);
const directory = dirname(process.argv[process.argv.indexOf('-config') + 1]);
const file = join(directory, 'fixture-accounts.json');
let aliases = JSON.parse(config.match(/^oauth-model-alias: (.+)/m)?.[1] ?? '{}');
let accounts = [];try {accounts = JSON.parse(readFileSync(file, 'utf8'));} catch {}
let aliasWrites=0;let fixtureOptions={};try{fixtureOptions=JSON.parse(readFileSync(join(directory,'fixture-options.json'),'utf8'));}catch{}
const fixtureStarted=Date.now();
const sessions = new Map();let fixtureMode = 'wait';let cancelCount = 0;let callbackCount = 0;const apiCalls = [];
const saveAccount = session => {
 const name = `${session.provider}-user@example.test.json`;
 accounts = [...accounts.filter(a => a.name !== name), {name, provider:session.provider, auth_index:`idx-${session.provider}`, email:'user@example.test',status:'active',disabled:false,unavailable:false,id_token:{secret:'never-expose',chatgpt_account_id:'acct-fixture',plan_type:'plus'},project_id:session.provider==='antigravity'?'proj-fixture':undefined,access_token:'never-expose',path:'/private/credentials'}];
 writeFileSync(file,JSON.stringify(accounts));
};
const server = createServer(async(req,res) => {
 res.setHeader('content-type','application/json');const url=new URL(req.url,`http://127.0.0.1:${port}`);
 const send=(status,value)=>{res.statusCode=status;res.end(JSON.stringify(value));};
 if(url.pathname==='/fixture') {
  if(req.method==='POST'){let body='';for await(const c of req)body+=c;const input=JSON.parse(body);fixtureMode=input.mode??fixtureMode;if(input.modelSets){for(const a of accounts)if(input.modelSets[a.provider])a.models=input.modelSets[a.provider];writeFileSync(file,JSON.stringify(accounts));}if(input.complete)for(const s of sessions.values()){if(s.status==='wait'){s.status='ok';saveAccount(s);}}}
  return send(200,{cancelCount,callbackCount,apiCalls});
 }
 const management=url.pathname.startsWith('/v0/management/');
 if(req.headers.authorization!==`Bearer ${management?managementKey:key}`)return send(401,{error:'denied'});
 const path=url.pathname.replace('/v0/management','').replace('/v1','');
 // Mirrors upstream /v1/models: each enabled account contributes a model carrying its provider `type`.
 const modelTypes={codex:'openai',claude:'claude',antigravity:'antigravity',kimi:'kimi',xai:'xai',qoder:'qoder',workbuddy:'workbuddy',zcode:'zcode',doubao:'doubao',trae:'trae'};
 const accountModels = a => (a.models ?? [`fixture-${a.provider}-model`]).flatMap(entry => {const {id,...meta}=typeof entry==='string'?{id:entry}:entry;return [{id,...meta,object:'model',type:modelTypes[a.provider],owned_by:a.provider==='codex'?'openai':a.provider}, ...(aliases[a.provider] ?? []).filter(alias=>alias.name===id).map(alias=>({id:alias.alias,...meta,object:'model',type:modelTypes[a.provider],owned_by:a.provider}))];});
 if((path==='/models'||path==='/auth-files/models')&&Date.now()-fixtureStarted<(fixtureOptions.modelDelayMs??0))return send(200,path==='/models'?{data:[]}:{models:[]});
 if(path==='/models')return send(200,{data:[...new Map(accounts.filter(a=>!a.disabled).flatMap(accountModels).map(m=>[m.id,m])).values()]});
 if(path==='/auth-files/models')return send(200,{models:accounts.filter(a=>a.name===url.searchParams.get('name')&&!a.disabled).flatMap(accountModels)});
 if(path==='/oauth-model-alias') {
  if(req.method==='PUT'){let body='';for await(const c of req)body+=c;aliasWrites++;if(aliasWrites<=(fixtureOptions.failAliasWrites??0))return send(503,{error:'fixture transient alias registration failure'});aliases=JSON.parse(body);}
  return send(200,{'oauth-model-alias':aliases});
 }
 if(['/responses','/responses/compact','/messages','/messages/count_tokens','/chat/completions'].includes(path)) {
  let body='';for await(const c of req)body+=c;const input=JSON.parse(body);
  const account=accounts.find(a=>!a.disabled&&(!req.headers['x-token-flowb-auth']||a.name===req.headers['x-token-flowb-auth'])&&accountModels(a).some(m=>m.id===input.model));
  if(!account)return send(404,{error:'model unavailable'});
  if(fixtureMode==='region-restricted')return send(400,{error:{message:'User location is not supported for the API use.',debug:'upstream-secret-never-expose'}});
  if(path==='/messages/count_tokens')return send(200,{input_tokens:7});
  const usage={input_tokens:7,output_tokens:3};
  const response={id:'fixture-response',object:'response',status:'completed',model:input.model,usage,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:account.provider}]}]};
  const message={id:'fixture-message',type:'message',role:'assistant',model:input.model,content:[{type:'text',text:account.provider}],stop_reason:'end_turn',usage};
  const chat={id:'fixture-chat',object:'chat.completion',model:input.model,choices:[{index:0,message:{role:'assistant',content:account.provider},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}};
  if(input.stream){
   res.setHeader('content-type','text/event-stream');
   const events=path==='/messages'?[{type:'message_start',message:{...message,content:[],usage:{input_tokens:7,output_tokens:0}}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:account.provider}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}},{type:'message_stop'}]:path==='/chat/completions'?[{...chat,choices:[{index:0,delta:{content:account.provider},finish_reason:'stop'}]},'[DONE]']:[{type:'response.created',response:{...response,status:'in_progress',usage:null,output:[]}},{type:'response.output_item.added',output_index:0,item:{id:'msg_fixture',type:'message',role:'assistant',content:[]}},{type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:''}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:account.provider},{type:'response.output_item.done',output_index:0,item:{...response.output[0],id:'msg_fixture'}},{type:'response.completed',response}];
   const outgoing=fixtureMode==='truncated-stream'?events.slice(0,2):events;
   for(const event of outgoing)res.write(`data: ${typeof event==='string'?event:JSON.stringify(event)}\n\n`);return res.end();
  }
  return send(200,path==='/messages'?message:path==='/chat/completions'?chat:response);
 }
 if(path==='/auth-files'){
  if(req.method==='POST'){let body='';for await(const c of req)body+=c;const value=JSON.parse(body);const name=url.searchParams.get('name');accounts=[...accounts.filter(a=>a.name!==name),{...value,name,provider:value.type,status:'active',models:['imported-model']}];writeFileSync(file,JSON.stringify(accounts));return send(200,{status:'ok'});}
  if(req.method==='DELETE'){accounts=accounts.filter(a=>a.name!==url.searchParams.get('name'));writeFileSync(file,JSON.stringify(accounts));return send(200,{status:'ok'});}
  return send(200,{files:accounts.map(a=>({...a,id:a.name,id_token:typeof a.id_token==='string'?undefined:a.id_token}))});
 }
 if(path==='/auth-files/status'){let body='';for await(const c of req)body+=c;const input=JSON.parse(body);accounts.find(a=>a.name===input.name).disabled=input.disabled;writeFileSync(file,JSON.stringify(accounts));return send(200,{status:'ok'});}
 if(path.endsWith('-auth-url')) {
  const provider={'/codex-auth-url':'codex','/anthropic-auth-url':'claude','/antigravity-auth-url':'antigravity','/kimi-auth-url':'kimi','/xai-auth-url':'xai','/qoder-auth-url':'qoder','/workbuddy-auth-url':'workbuddy','/zcode-auth-url':'zcode','/doubao-auth-url':'doubao','/trae-auth-url':'trae'}[path];
  if(!provider)return send(404,{error:'unknown provider'});
  const state=randomUUID();sessions.set(state,{provider,status:fixtureMode==='error'?'error':'wait'});
  if(provider==='kimi'||provider==='xai'){
   // Device flow (RFC 8628): no localhost callback; upstream polls the token endpoint itself.
   const code='FIXT-CODE';const verify=provider==='kimi'?'https://www.kimi.com/code/authorize_device':'https://accounts.x.ai/oauth2/device';
   return send(200,{status:'ok',state,flow:'device',user_code:code,expires_in:1800,url:fixtureMode==='unsafe'?`https://evil.test/device?user_code=${code}`:`${verify}?user_code=${code}`});
  }
  if(provider==='qoder'){
   return send(200,{status:'ok',state,flow:'device',expires_in:300,url:fixtureMode==='unsafe'?'https://evil.test/device':'https://qoder.com/device/selectAccounts?challenge=fixture'});
  }
  if(provider==='workbuddy'){
   return send(200,{status:'ok',state,flow:'device',expires_in:600,url:fixtureMode==='unsafe'?'https://evil.test/login':`https://copilot.tencent.com/login?platform=CLI&state=${state}`});
  }
  if(provider==='zcode'){
   return send(200,{status:'ok',state,url:fixtureMode==='unsafe'?'https://evil.test/oauth':`https://chat.z.ai/api/oauth/authorize?state=${state}`});
  }
  if(provider==='doubao'){
   return send(200,{status:'ok',state,url:fixtureMode==='unsafe'?'https://evil.test/auth':`https://www.marscode.cn/authorization?state=${state}`});
  }
  if(provider==='trae'){
   const target=encodeURIComponent(`https://www.trae.ai/authorization?state=${state}`);
   return send(200,{status:'ok',state,url:fixtureMode==='unsafe'?'https://evil.test/login':`https://www.trae.ai/login?redirect_url=${target}`});
  }
  return send(200,{status:'ok',state,url:fixtureMode==='unsafe'?'https://evil.test/oauth/authorize':`${provider==='antigravity'?'https://accounts.google.com/o/oauth2/v2/auth':`https://${provider==='codex'?'auth.openai.com':'claude.ai'}/oauth/authorize`}?state=${state}&code_challenge=fixture`});
 }
 if(path==='/get-auth-status'){const s=sessions.get(url.searchParams.get('state'));return send(200,{status:s?.status??'error',error:'opaque-error-secret-never-expose'});}
 if(path==='/oauth-session'){const s=sessions.get(url.searchParams.get('state'));const cancelled=s?.status==='wait';if(cancelled){s.status='error';cancelCount++;}return send(200,{status:'ok',cancelled});}
 if(path==='/api-call') {
  // Stands in for provider usage endpoints. $TOKEN$ must be substituted upstream, never sent by the desktop.
  let body='';for await(const c of req)body+=c;const input=JSON.parse(body);apiCalls.push({authIndex:input.auth_index,url:input.url,rawToken:Object.values(input.header??{}).some(v=>String(v).includes('$TOKEN$'))});
  if(fixtureMode==='quota-empty'&&input.url.includes('api.kimi.com'))return replyEmpty();
  function replyEmpty(){return send(200,{status_code:200,header:{},body:'{}'});}
  if(input.url.includes('openapi.qoder.sh/api/v2/quota/usage'))return send(200,{status_code:200,header:{},body:JSON.stringify({userQuota:{total:3000,used:1512,remaining:1488},orgResourcePackage:{cap:6000,used:0,remaining:6000,available:true}})});
  if(fixtureMode==='quota-401')return send(200,{status_code:401,header:{},body:'{}'});
  if(!accounts.some(a=>a.auth_index===input.auth_index))return send(200,{status_code:401,header:{},body:'{"error":"upstream-secret-never-expose"}'});
  if(fixtureMode==='quota-error')return send(200,{status_code:429,header:{},body:'{"error":"rate limited upstream-secret-never-expose"}'});
  const u=input.url;const reply=(obj)=>send(200,{status_code:200,header:{'Content-Type':['application/json']},body:JSON.stringify(obj)});
  if(u.startsWith('https://api.kimi.com/coding/v1/usages'))return reply({usage:{used:120,limit:1000,resetAt:'2026-09-14T00:00:00Z'},limits:[{name:'5h window',window:{duration:5,timeUnit:'hour'},detail:{used:30,limit:100,reset_in:3600}},{window:{duration:1,timeUnit:'week'},detail:{remaining:700,limit:1000,reset_at:'2026-09-14T00:00:00Z'}}]});
  if(u.startsWith('https://cli-chat-proxy.grok.com/v1/billing?format=credits'))return reply({config:{currentPeriod:{type:'WEEKLY',start:'2026-09-07T00:00:00Z',end:'2026-09-14T00:00:00Z'},creditUsagePercent:42.5,productUsage:[{product:'grok-build',usagePercent:10}]}});
  if(u.startsWith('https://cli-chat-proxy.grok.com/v1/billing'))return reply({config:{monthlyLimit:{val:3000},used:{val:1250},onDemandCap:{val:5000},billingPeriodEnd:'2026-10-01T00:00:00Z'}});
  if(u.startsWith('https://chatgpt.com/backend-api/wham/usage'))return reply({plan_type:'plus',rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:12,limit_window_seconds:18000,reset_after_seconds:7200},secondary_window:{used_percent:55,limit_window_seconds:604800,reset_at:1789000000}},rate_limit_reset_credits:{available_count:2}});
  if(u.startsWith('https://api.anthropic.com/api/oauth/usage'))return reply({five_hour:{utilization:33,resets_at:'2026-09-09T08:00:00Z'},seven_day:{utilization:61,resets_at:'2026-09-15T00:00:00Z'}});
  if(u.startsWith('https://api.anthropic.com/api/oauth/profile'))return reply({account:{has_claude_max:true}});
  if(u.includes('retrieveUserQuotaSummary'))return reply({groups:[{displayName:'Gemini',buckets:[{bucketId:'gemini-daily',displayName:'每日',window:'DAILY',remainingFraction:0.25,resetTime:'2026-09-10T00:00:00Z'}]}]});
  return send(200,{status_code:404,header:{},body:'not found'});
 }
 if(path==='/oauth-callback') {
  let body='';for await(const c of req)body+=c;const input=JSON.parse(body);const callback=new URL(input.redirect_url);const s=sessions.get(callback.searchParams.get('state'));
  if(!s||s.status!=='wait')return send(409,{error:'stale'});callbackCount++;s.status='ok';saveAccount(s);return send(200,{status:'ok'});
 }
 return send(404,{error:'unknown fixture route'});
});
server.listen(port,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
