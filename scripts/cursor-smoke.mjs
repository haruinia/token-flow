import {_electron as electron} from 'playwright';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createServer} from 'node:net';import assert from 'node:assert/strict';
const root=await mkdtemp(join(await realpath(tmpdir()),'cursor-ui-'));const allocator=createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const port=allocator.address().port;await new Promise(r=>allocator.close(r));let app;
try{
 await mkdir(join(root,'cliproxy'));await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'qoder.json',provider:'qoder',label:'Qoder',auth_index:'qoder',status:'active',models:['fixture']},...['a','b'].map(name=>({name:`kimi-${name}.json`,provider:'kimi',label:'Kimi',auth_index:`kimi-${name}`,status:'active',models:['fixture']}))]));
 app=await electron.launch({...(process.env.CURSOR_SMOKE_PACKAGED==='1'?{executablePath:resolve(process.env.CURSOR_SMOKE_EXECUTABLE??'release/mac-arm64/token-flow.app/Contents/MacOS/token-flow'),args:[]}:{args:['.']}),env:{...process.env,AGENT_DATA_ROOT:root,CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),WORKBUDDY_CONFIG_DIR:join(root,'workbuddy'),AGENT_PORT:'0',AGENT_PROXY_PORT:String(port),CLIPROXY_BINARY:resolve('tests/fixtures/fake-cliproxy.mjs')}});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.locator('.a2aPage').waitFor();
 await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({mode:'quota-empty'})});
 await page.evaluate(()=>fetch('/api/local-agent/quota',{method:'POST'}));await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'模型中心',exact:true}).click();
 const qoder=page.locator('[data-provider="qoder"]');await qoder.locator('.providerCardHead').click();await qoder.getByText('套餐 Credits',{exact:true}).waitFor();assert.match(await qoder.innerText(),/1,512/);assert.match(await qoder.innerText(),/3,000/);
 const kimi=page.locator('[data-provider="kimi"]');await kimi.locator('.providerCardHead').click();assert.equal(await kimi.getByText(/官方暂未返回额度/).count(),2);assert.doesNotMatch(await kimi.innerText(),/重复账号|额度查询失败/);
 await app.evaluate(({shell})=>{shell.openExternal=async url=>{if(new URL(url).hostname!=='cursor.com')throw new Error('Unexpected auth host');};});
 await page.locator('[data-provider="cursor"]').getByRole('button',{name:/连接 Cursor/}).click();
 await page.waitForFunction(()=>fetch('/api/local-agent').then(r=>r.json()).then(s=>s.login?.provider==='cursor'&&s.login.status==='waiting_for_browser'),{timeout:20000});
 await page.getByRole('button',{name:'取消本次授权',exact:true}).click();await page.waitForFunction(()=>fetch('/api/local-agent').then(r=>r.json()).then(s=>s.login?.status==='cancelled'));
 await page.evaluate(async()=>{const local=await fetch('/api/local-agent').then(r=>r.json());await fetch('/api/gateway-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Qoder target',models:[local.models.find(m=>m.provider==='qoder').id],agents:['openai']})});});
 await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'Agent 接入',exact:true}).click();assert.equal(await page.locator('.agentChoices').getByRole('button',{name:/Cursor/}).count(),0);await page.locator('.agentChoices').getByRole('button',{name:/Qoder 独立应用/}).click();const config=JSON.parse(await page.getByLabel('Agent 接入配置',{exact:true}).innerText());assert.equal(config.provider,'OpenAI Compatible');assert.equal(config.api,'Responses');assert.match(config.baseURL,/^http:\/\/127\.0\.0\.1:\d+\/v1$/);assert.match(config.model,/^qoder\//);
 await page.route('**/api/local-agent',async route=>{
  const response=await route.fetch();const local=await response.json();local.accounts.push({id:'cursor-fixture',provider:'cursor',label:'Cursor test account',disabled:false,unavailable:false,status:'模型同步失败',modelError:'Cursor 官方返回 plan_required：当前账号套餐不支持此 API，请在官方确认 Pro 或团队套餐后刷新。',models:[]});
  await route.fulfill({response,json:local});
 });
 await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'模型中心',exact:true}).click();
 const cursor=page.locator('[data-provider="cursor"]');await cursor.getByText('1 个账号 · 模型同步失败',{exact:true}).waitFor();
 if(await cursor.locator('.providerCardHead').getAttribute('aria-expanded')!=='true')await cursor.locator('.providerCardHead').click();
 assert.match(await cursor.innerText(),/plan_required/);assert.doesNotMatch(await cursor.innerText(),/模型同步中|暂不支持外部工具调用/);assert.match(await cursor.innerText(),/支持文本与客户端工具/);
 await mkdir('artifacts/cursor',{recursive:true});await page.screenshot({path:'artifacts/cursor/source-and-targets.png'});assert.deepEqual(errors,[]);console.log(JSON.stringify({packaged:process.env.CURSOR_SMOKE_PACKAGED==='1',qoder:'Credits shown',kimi:'unknown, no false duplicate',cursor:'SDK login and cancellation; plan_required displayed; no endless sync; client tools shown',inference:'mocked in integration tests; no real Cursor login or paid request'}));
}finally{await app?.close();await rm(root,{recursive:true,force:true});}
