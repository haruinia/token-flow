import { _electron as electron } from 'playwright';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'token-flowb-gateway-'));
const allocator=createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const port=allocator.address().port;await new Promise(r=>allocator.close(r));
let app;
try{
 await mkdir(join(root,'cliproxy'));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([
  {name:'codex.json',provider:'codex',email:'developer@example.test',status:'active',auth_index:'idx-codex',models:['gpt-5.6-sol','gpt-5.5']},
  {name:'claude.json',provider:'claude',email:'builder@example.test',status:'active',auth_index:'idx-claude',models:['claude-sonnet-fixture']},
 ]));
 const packaged=process.argv.includes('--packaged');
 app=await electron.launch({args:packaged?[]:['.'],...(packaged?{executablePath:resolve('release/mac-arm64/token-flowb.app/Contents/MacOS/token-flowb')}:{}),env:{...process.env,AGENT_DATA_ROOT:root,CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),WORKBUDDY_CONFIG_DIR:join(root,'workbuddy'),AGENT_PORT:'0',AGENT_PROXY_PORT:String(port),CLIPROXY_BINARY:resolve('tests/fixtures/fake-cliproxy.mjs')}});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('.a2aPage').waitFor();await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'API 总览',exact:true}).click();await page.locator('.gatewayHome').waitFor();assert.equal(await page.locator('.taskComposer').count(),0);
 await page.waitForFunction(()=>fetch('/api/local-agent').then(r=>r.json()).then(s=>s.models.length===3));
 const result=await page.evaluate(()=>fetch('/api/gateway-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'开发工具',models:['codex/gpt-5.6-sol'],agents:['codex','claude','openai'],tokenLimit:30})}).then(r=>r.json()));
 const nav=page.getByRole('navigation',{name:'主导航'});
 await nav.getByRole('button',{name:'Agent 接入',exact:true}).click();
 await page.getByLabel('调用模型',{exact:true}).selectOption('codex/gpt-5.6-sol');
 const config=page.getByLabel('Agent 接入配置',{exact:true});assert.match(await config.innerText(),/wire_api="responses"/);
 await page.getByLabel('粘贴该 Key 的完整值',{exact:true}).fill(result.apiKey);
 await page.getByRole('button',{name:'验证 Key',exact:true}).click();await page.getByText('Key 认证通过，所选模型已授权。未发起模型调用。',{exact:true}).waitFor();
 for(const name of ['Codex','Claude Code','OpenAI 兼容 Agent']){
  await page.locator('.agentChoices').getByRole('button',{name:new RegExp(name)}).click();
  await page.getByRole('button',{name:'发送测试请求',exact:true}).click();
  await page.locator('.connectionStatus').filter({hasText:'接入测试通过'}).waitFor();
 }
 const report=await page.evaluate(()=>fetch('/api/gateway/activity').then(r=>r.json()));assert.equal(report.total,3);assert.equal(report.inputTokens,21);assert.equal(report.outputTokens,9);
 const exhausted=await page.evaluate(key=>fetch('/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'codex/gpt-5.6-sol',input:'Hi'})}).then(r=>r.status),result.apiKey);assert.equal(exhausted,429);
 await page.getByLabel('粘贴该 Key 的完整值',{exact:true}).fill('');
 await mkdir('artifacts/gateway',{recursive:true});
 await page.locator('.agentChoices').getByRole('button',{name:/Claude Code/}).click();await page.screenshot({path:'artifacts/gateway/agents.png'});
 await nav.getByRole('button',{name:'API 总览',exact:true}).click();await page.locator('.apiCallRow').nth(3).waitFor();
 await page.screenshot({path:'artifacts/gateway/overview.png'});
 await nav.getByRole('button',{name:'API Keys',exact:true}).click();
 await page.getByText('额度已耗尽',{exact:true}).waitFor();
 await page.getByRole('button',{name:'编辑权限',exact:true}).click();
 assert.equal(await page.getByLabel('Token 总额度',{exact:true}).inputValue(),'30');
 await page.getByLabel('Claude Code',{exact:true}).uncheck();
 await page.getByLabel('Token 总额度',{exact:true}).fill('4000');
 await page.screenshot({path:'artifacts/gateway/key-budget-editor.png'});
 await page.getByRole('button',{name:'保存权限',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.keyEditor'));
 await page.getByText('3,970',{exact:true}).waitFor();
 await page.screenshot({path:'artifacts/gateway/key-budget.png'});
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'重置用量',exact:true}).click();
 await page.waitForFunction(()=>fetch('/api/gateway-keys').then(r=>r.json()).then(data=>data.keys[0].usedTokens===0));
 const updated=await page.evaluate(()=>fetch('/api/gateway-keys').then(r=>r.json()).then(data=>data.keys[0]));assert.deepEqual(updated.agents,['codex','openai']);assert.equal(updated.tokenLimit,4000);

 for(const width of [390,768,1320]){
  await page.setViewportSize({width,height:900});
  for(const name of ['API 总览','Agent 接入','模型中心','API Keys']){
   await nav.getByRole('button',{name,exact:true}).click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth+1),false,`${name}: overflow at ${width}`);
  }
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({gateway:'passed',packaged,protocols:['responses','messages','chat/completions'],tokens:30,widths:[390,768,1320],realProvider:false}));
}catch(error){if(app?.windows()[0]){await mkdir('artifacts/gateway',{recursive:true});await app.windows()[0].screenshot({path:'artifacts/gateway/failure.png'});console.error((await app.windows()[0].locator('body').innerText()).slice(-3000));}throw error;}finally{await app?.close();await rm(root,{recursive:true,force:true});}
