import {_electron as electron} from 'playwright';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(await realpath(tmpdir()),'token-flowb-startup-'));
const allocator=createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const port=allocator.address().port;await new Promise(r=>allocator.close(r));let app;
try{
 await mkdir(join(root,'cliproxy'));await mkdir(join(root,'codex'));
 await writeFile(join(root,'codex','auth.json'),JSON.stringify({tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:'x.e30.x',account_id:'local-fixture'}}));
 await writeFile(join(root,'cliproxy','fixture-options.json'),JSON.stringify({modelDelayMs:4500}));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex.json',provider:'codex',email:'source@example.test',auth_index:'source',status:'active',models:['gpt-6-astra']},{name:'qoder.json',provider:'qoder',label:'Qoder',auth_index:'qoder',status:'active',models:[{id:'kmodel_latest',display_name:'Kimi K3 (Qoder)'}]}]));
 app=await electron.launch({executablePath:resolve('release/mac-arm64/token-flowb.app/Contents/MacOS/token-flowb'),args:[],env:{...process.env,AGENT_DATA_ROOT:root,CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),WORKBUDDY_CONFIG_DIR:join(root,'workbuddy'),AGENT_PORT:'0',AGENT_PROXY_PORT:String(port),CLIPROXY_BINARY:resolve('tests/fixtures/fake-cliproxy.mjs')}});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.locator('.a2aPage').waitFor();
 // A failed auxiliary endpoint must not block the independently loaded source pool.
 await page.route('**/api/browser',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'fixture browser unavailable'})}));await page.reload();
 await page.getByText('授权已读取，正在自动同步模型，无需重新登录。',{exact:true}).waitFor();
 assert.equal(await page.getByText('暂无可用授权，登录一个 Agent 就能开始。',{exact:true}).count(),0);
 await page.locator('.a2aSource').filter({hasText:'source@example.test'}).waitFor({timeout:15000});
 await page.locator('.a2aSource').filter({hasText:'本地 Codex 授权'}).waitFor();
 assert.equal(await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'A2A 接入',exact:true}).getAttribute('aria-current'),'page');
 await page.unroute('**/api/browser');await page.reload();await page.locator('.a2aSource').filter({hasText:'source@example.test'}).waitFor();
 await mkdir('artifacts/startup',{recursive:true});await page.screenshot({path:'artifacts/startup/sources.png'});
 await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'模型中心',exact:true}).click();
 const codex=page.locator('[data-provider="codex"]');await codex.locator('.providerCardHead').click();await codex.getByRole('button',{name:'选择 codex/gpt-6-astra',exact:true}).waitFor();
 const qoder=page.locator('[data-provider="qoder"]');await qoder.locator('.providerCardHead').click();
 const full=qoder.getByRole('img',{name:'组织资源包 · 剩余 100%',exact:true});await full.waitFor();
 assert.equal(await full.locator('.quotaRingValue').getAttribute('stroke-dasharray'),'100 100');
 assert.equal(await qoder.locator('.bar').count(),0);
 for(const width of [390,768,1320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth+1),false);await page.screenshot({path:`artifacts/startup/quota-rings-${width}.png`});}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({packaged:true,delayedModels:'automatic, no navigation required',localOAuth:'imported at startup',auxiliaryFailure:'does not block accounts',quota:'remaining rings, full capacity = 100%, responsive'}));
}finally{await app?.close();await rm(root,{recursive:true,force:true});}
