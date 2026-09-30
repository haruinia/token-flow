import { chromium,type Browser } from 'playwright';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { createDesktopService } from '../packages/core/src/service.js';

const root=await mkdtemp(join(await realpath(tmpdir()),'a2a-history-ui-'));
const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
const paths={codex:join(root,'codex/config.toml'),claude:join(root,'claude/settings.json'),workbuddy:join(root,'workbuddy/models.json'),qoder:join(root,'qoder/settings.json')};
await mkdir(join(root,'cliproxy'));await mkdir(join(root,'codex'));
await writeFile(paths.codex,'model = "original"\n');
await writeFile(join(root,'cliproxy/fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',email:'source@example.test',status:'active',models:['first','second']}]));
const service=await createDesktopService({root,proxyPort:port,binary:resolve('tests/fixtures/fake-cliproxy.mjs'),token:'fixture-admin',localKey:'fixture-internal',uiRoot:resolve('dist/console'),secrets:{get:async()=>'',set:async()=>{}},agentPaths:paths,agentProcesses:async()=>[]});
let browser:Browser|undefined;
try{
 browser=await chromium.launch({channel:'chromium'});
 await service.proxy.start();const address=await service.app.listen({host:'127.0.0.1',port:0});
 const context=await browser.newContext({viewport:{width:1320,height:1000}});await context.addCookies([{name:'agent_session',value:'fixture-admin',url:address}]);const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>void dialog.accept());await page.goto(address);
 const choose=async(model:string)=>{await page.locator('.a2aFlow .a2aSource').filter({hasText:'source@example.test'}).click();await page.getByRole('dialog').getByRole('button',{name:`codex/${model}`,exact:true}).click();};
 await choose('first');await page.locator('.a2aTargets button').filter({hasText:'Codex'}).click();await page.getByRole('button',{name:'接入 Codex',exact:true}).click();await page.getByRole('button',{name:'已接入',exact:true}).waitFor();
 await writeFile(paths.codex,'approval_policy = "on-request"\n'+await readFile(paths.codex,'utf8'));
 await choose('second');await page.getByRole('button',{name:'还原并接入所选模型',exact:true}).click();await page.getByRole('button',{name:'已接入',exact:true}).waitFor();assert.equal(parse(await readFile(paths.codex,'utf8')).model,'codex/second');
 const history=page.getByRole('region',{name:'历史接入记录'});await history.getByText('codex/first',{exact:true}).waitFor();
 // Remounting the page and choosing a different target retains the last model.
 await page.reload();await page.locator('.selectedSourceModel').filter({hasText:'codex/second'}).waitFor();await page.locator('.a2aTargets button').filter({hasText:'WorkBuddy'}).click();await page.getByRole('button',{name:'接入 WorkBuddy',exact:true}).click();await page.getByRole('button',{name:'已接入',exact:true}).waitFor();assert.equal(JSON.parse(await readFile(paths.workbuddy,'utf8'))[0].id,'codex/second');
 await history.getByRole('button',{name:'使用此接入',exact:true}).first().click();await page.getByRole('button',{name:'还原并接入所选模型',exact:true}).click();await page.getByRole('button',{name:'已接入',exact:true}).waitFor();assert.equal(parse(await readFile(paths.codex,'utf8')).model,'codex/first');
 const active=page.locator('.a2aConnections').filter({has:page.getByRole('heading',{name:'接入记录与实际配置',exact:true})});const codex=active.locator('.a2aConnection').filter({has:page.getByText('Codex',{exact:true})});
 await codex.getByRole('button',{name:'还原原接口',exact:true}).click();await page.getByText('原接口已还原，请重启 Codex 生效。也可以选择新模型重新接入。',{exact:true}).waitFor();assert.deepEqual(parse(await readFile(paths.codex,'utf8')),{model:'original',approval_policy:'on-request'});
 await page.getByRole('button',{name:'接入 Codex',exact:true}).click();await page.getByRole('button',{name:'已接入',exact:true}).waitFor();await writeFile(paths.codex,'model = "reinstalled"\n');
 await active.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('button',{name:'重新接入所选模型',exact:true}).waitFor();await codex.getByRole('button',{name:'还原原接口',exact:true}).click();await page.getByRole('alert').filter({hasText:'外部修改'}).waitFor();await codex.getByRole('button',{name:'删除记录',exact:true}).click();await page.getByText('接入记录及备份已删除，客户端配置未改动。可以选择模型重新接入。',{exact:true}).waitFor();assert.equal(await readFile(paths.codex,'utf8'),'model = "reinstalled"\n');
 await page.getByRole('button',{name:'接入 Codex',exact:true}).click();await page.getByRole('button',{name:'已接入',exact:true}).waitFor();
 await mkdir('artifacts/a2a',{recursive:true});
 for(const width of [390,768,1320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('main')!.scrollWidth>document.querySelector('main')!.clientWidth+1),false,`overflow at ${width}`);await history.evaluate(element=>element.scrollIntoView({block:'start'}));await page.screenshot({path:`artifacts/a2a/history-${width}.png`,fullPage:true});}
 assert.deepEqual(errors,[]);console.log('A2A history UI passed: switch, remembered model, history reuse, safe restore, stale deletion, reconnect, responsive widths.');
}finally{await browser?.close();await service.app.close();await rm(root,{recursive:true,force:true});}
