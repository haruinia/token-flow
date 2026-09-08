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
let accounts = [];try {accounts = JSON.parse(readFileSync(file, 'utf8'));} catch {}
const sessions = new Map();let fixtureMode = 'wait';let cancelCount = 0;let callbackCount = 0;
const saveAccount = session => {
 const name = `${session.provider}-user@example.test.json`;
 accounts = [...accounts.filter(a => a.name !== name), {name, provider:session.provider, email:'user@example.test',status:'active',disabled:false,unavailable:false,id_token:{secret:'never-expose'},access_token:'never-expose',path:'/private/credentials'}];
 writeFileSync(file,JSON.stringify(accounts));
};
const server = createServer(async(req,res) => {
 res.setHeader('content-type','application/json');const url=new URL(req.url,`http://127.0.0.1:${port}`);
 const send=(status,value)=>{res.statusCode=status;res.end(JSON.stringify(value));};
 if(url.pathname==='/fixture') {
  if(req.method==='POST'){let body='';for await(const c of req)body+=c;const input=JSON.parse(body);fixtureMode=input.mode??fixtureMode;if(input.complete)for(const s of sessions.values()){if(s.status==='wait'){s.status='ok';saveAccount(s);}}}
  return send(200,{cancelCount,callbackCount});
 }
 const management=url.pathname.startsWith('/v0/management/');
 if(req.headers.authorization!==`Bearer ${management?managementKey:key}`)return send(401,{error:'denied'});
 const path=url.pathname.replace('/v0/management','').replace('/v1','');
 if(path==='/models')return send(200,{data:accounts.some(a=>!a.disabled)?[{id:'fixture-codex-model'}]:[]});
 if(path==='/auth-files')return send(200,{files:accounts});
 if(path==='/auth-files/status'){let body='';for await(const c of req)body+=c;const input=JSON.parse(body);accounts.find(a=>a.name===input.name).disabled=input.disabled;writeFileSync(file,JSON.stringify(accounts));return send(200,{status:'ok'});}
 if(path.endsWith('-auth-url')) {
  const provider=path==='/codex-auth-url'?'codex':path==='/antigravity-auth-url'?'antigravity':'claude';const state=randomUUID();sessions.set(state,{provider,status:fixtureMode==='error'?'error':'wait'});
  return send(200,{status:'ok',state,url:fixtureMode==='unsafe'?'https://evil.test/oauth/authorize':`${provider==='antigravity'?'https://accounts.google.com/o/oauth2/v2/auth':`https://${provider==='codex'?'auth.openai.com':'claude.ai'}/oauth/authorize`}?state=${state}&code_challenge=fixture`});
 }
 if(path==='/get-auth-status'){const s=sessions.get(url.searchParams.get('state'));return send(200,{status:s?.status??'error',error:'opaque-error-secret-never-expose'});}
 if(path==='/oauth-session'){const s=sessions.get(url.searchParams.get('state'));const cancelled=s?.status==='wait';if(cancelled){s.status='error';cancelCount++;}return send(200,{status:'ok',cancelled});}
 if(path==='/oauth-callback') {
  let body='';for await(const c of req)body+=c;const input=JSON.parse(body);const callback=new URL(input.redirect_url);const s=sessions.get(callback.searchParams.get('state'));
  if(!s||s.status!=='wait')return send(409,{error:'stale'});callbackCount++;s.status='ok';saveAccount(s);return send(200,{status:'ok'});
 }
 return send(404,{error:'unknown fixture route'});
});
server.listen(port,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
