import { chromium } from 'playwright';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { createDesktopService } from '../packages/core/src/service.js';
const root=await mkdtemp(join(await realpath(tmpdir()),'native-ui-'));const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
const dbPath=join(root,'state.vscdb'),db=new DatabaseSync(dbPath);db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE,value TEXT)');db.close();
await mkdir(join(root,'cliproxy/auth'),{recursive:true});
const entries=['claude','antigravity'].flatMap(provider=>['one','two'].map(id=>({name:`${provider}-${id}.json`,provider,email:`${id}@${provider}.test`,status:'active',models:[provider==='claude'?'claude-sonnet-4-5':'gemini-2.5-pro']})));
await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify(entries));
for(const a of entries)await writeFile(join(root,'cliproxy/auth',a.name),JSON.stringify({...a,type:a.provider,access_token:'test-access',refresh_token:'test-refresh',expired:'2030-01-01T00:00:00Z'}));
const paths={codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),qoder:join(root,'qoder/settings.json'),workbuddy:join(root,'workbuddy/models.json')};
const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'test-admin',localKey:'test-key',secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[],nativeProcesses:async()=>[],claudeCredentialStore:null,antigravityPath:dbPath,uiRoot:resolve('dist/console')});
let browser;
try{
 browser=await chromium.launch({channel:'chromium',headless:true});
 await service.proxy.start();const address=await service.app.listen({host:'127.0.0.1',port:0});
 const page=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer test-admin'},viewport:{width:1320,height:950}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(address);await page.getByRole('navigation',{name:'辅助导航'}).getByRole('button',{name:'多账号切换',exact:true}).click();
 await page.getByRole('tab',{name:'Codex',exact:true}).waitFor();
 for(const [provider,label] of [['claude','Claude Code'],['antigravity','反重力 · Antigravity']]){
  await page.getByRole('tab',{name:label,exact:true}).click();
  for(const id of ['one','two']){
   const card=page.locator('.nativeAccountCard').filter({has:page.getByRole('heading',{name:`${id}@${provider}.test`,exact:true})});
   await card.getByRole('button',{name:'切换到此账号'}).click();
   if(provider==='claude')await page.getByLabel('默认模型',{exact:true}).selectOption('claude/claude-sonnet-4-5');
   else assert.equal(await page.getByLabel('默认模型',{exact:true}).count(),0);
   await card.getByRole('button',{name:'确认切换',exact:true}).click();await page.getByRole('status').filter({hasText:'账号已切换'}).waitFor();
   assert.match(await page.locator('.nativeAccountStatus strong').innerText(),new RegExp(`${id}@${provider}.test`));
  }
  await mkdir('artifacts/native-accounts',{recursive:true});await page.screenshot({path:`artifacts/native-accounts/${provider}.png`});
  await page.getByRole('button',{name:'还原原登录',exact:true}).click();await page.getByRole('status').filter({hasText:'原登录已还原'}).waitFor();
 }
 await page.setViewportSize({width:720,height:900});await page.screenshot({path:'artifacts/native-accounts/narrow.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);assert.deepEqual(errors,[]);
 assert.equal(JSON.parse(await readFile(join(root,'claude/.credentials.json'),'utf8')).claudeAiOauth,undefined);
 console.log(JSON.stringify({threeClientTabs:true,claudeSwitchAndRestore:true,antigravitySwitchAndRestore:true,narrowLayout:true,realUserLoginChanged:false}));
}finally{await browser?.close();await service.app.close();await rm(root,{recursive:true,force:true});}
