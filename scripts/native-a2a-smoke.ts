// Runs installed clients against a fixture upstream; never reads or changes their normal auth/config.
import { mkdtemp,mkdir,writeFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,dirname } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createDesktopService } from '../packages/core/src/service.js';
const [workbuddyCLI,claudeCLI]=process.argv.slice(2);
if(!workbuddyCLI||!claudeCLI)throw new Error('Pass WorkBuddy bundled CLI JS and Claude Code executable paths');
const root=await mkdtemp(join(await realpath(tmpdir()),'native-a2a-'));
const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
await mkdir(join(root,'cliproxy'));await mkdir(join(root,'workspace'));
await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify(['qoder','workbuddy','claude'].map(provider=>({name:`${provider}.json`,provider,status:'active',models:['shared-model']}))));
const paths={qoder:join(root,'qoder','settings.json'),codex:join(root,'codex','config.toml'),claude:join(root,'claude','settings.json'),workbuddy:join(root,'workbuddy','models.json')};
const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'fixture-admin',localKey:'fixture-internal',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[]});
try{
 await service.app.listen({port:0,host:'127.0.0.1'});const address=service.app.server.address() as {port:number};const host=`127.0.0.1:${address.port}`;const headers={host,authorization:'Bearer fixture-admin'};await service.proxy.start();
 for(const [target,provider] of [['workbuddy','qoder'],['claude','workbuddy'],['workbuddy','claude'],['workbuddy','workbuddy'],['claude','claude']] as const){
  const state=(await service.app.inject({url:'/api/a2a',headers})).json();const source=service.proxy.snapshot().accounts.find(a=>a.provider===provider)!;
  const connected=await service.app.inject({method:'POST',url:'/api/a2a/connect',headers,payload:{target,sourceId:source.id,model:`${provider}/shared-model`,revision:state.targets.find((t:{id:string})=>t.id===target).revision}});assert.equal(connected.statusCode,200);
  const env={PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR,SYSTEMROOT:process.env.SYSTEMROOT,USERPROFILE:process.env.USERPROFILE,CODEX_HOME:dirname(paths.codex),CLAUDE_CONFIG_DIR:dirname(paths.claude),WORKBUDDY_CONFIG_DIR:dirname(paths.workbuddy),CODEBUDDY_CONFIG_DIR:dirname(paths.workbuddy),DISABLE_TELEMETRY:'1',DISABLE_AUTOUPDATER:'1',CODEBUDDY_GIT_REPO_SCAN_DISABLED:'1',CODEBUDDY_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CODE_OAUTH_TOKEN:'',CODEBUDDY_API_KEY:''};
  const args=['--print','Return the provider name. Do not use tools.','--model',`${provider}/shared-model`,'--tools','','--max-turns','1','--no-session-persistence','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'];
  const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((res,rej)=>{const child=spawn(target==='workbuddy'?process.execPath:claudeCLI,target==='workbuddy'?[workbuddyCLI,...args]:args,{cwd:join(root,'workspace'),env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const timer=setTimeout(()=>child.kill('SIGTERM'),45000);child.once('error',rej);child.once('close',code=>{clearTimeout(timer);res({code,stdout,stderr});});});
  // Output contains fixture data only; redact local client keys before diagnostics.
  console.log(JSON.stringify({target,provider,...result},null,2).replace(/tfl_[A-Za-z0-9_-]+/g,'[fixture-key]'));
  assert.equal(result.code,0);assert.ok(result.stdout.includes(provider));
  assert.equal((await service.app.inject({method:'POST',url:'/api/a2a/restore',headers,payload:{id:connected.json().id}})).statusCode,200);
 }
}finally{await service.app.close();await rm(root,{recursive:true,force:true});}
