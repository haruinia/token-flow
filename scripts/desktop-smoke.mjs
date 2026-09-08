import { _electron as electron, chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'browser-desktop-smoke-'));
let address='';let responses=0;
const upstream=createServer(async(req,res)=>{
 if(req.url==='/form'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Application fixture</title><h1>Local application fixture</h1><label>Name <input aria-label="Name"></label><p>Nothing on this page is sent anywhere.</p>');return;}
 res.setHeader('content-type','application/json');
 if(req.headers.authorization!=='Bearer smoke-key'){res.writeHead(401);res.end('{"error":"Unauthorized"}');return;}
 if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture-browser-model',object:'model'}]}));return;}
 let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);responses++;
 let output=[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}];
 if(request.tool_choice){output=[{type:'function_call',call_id:'probe-call',name:'probe_echo',arguments:'{"value":"ping"}'}];}
 if(request.tools?.some(t=>t.name==='exec_js')){
  const items=Array.isArray(request.input)?request.input:[];
  const done=id=>items.some(i=>i.type==='function_call_output'&&i.call_id===id);
  if(done('c3'))output=[{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixture task completed after human takeover.'}]}];
  else if(done('c2'))output=[{type:'function_call',name:'exec_js',call_id:'c3',arguments:JSON.stringify({code:"console.log('Verified name:', await page.getByLabel('Name').inputValue());"})}];
  else if(done('c1'))output=[{type:'function_call',name:'request_human_takeover',call_id:'c2',arguments:JSON.stringify({message:'请在测试页面把姓名改为 Human verified，然后继续。'})}];
  else output=[{type:'function_call',name:'exec_js',call_id:'c1',arguments:JSON.stringify({code:`await page.goto(${JSON.stringify(address+'/form')}); await page.getByLabel('Name').fill('Agent draft'); console.log('Draft filled');`})}];
 }
 res.end(JSON.stringify({id:`fixture-${responses}`,status:'completed',output}));
});
await new Promise((resolve,reject)=>{upstream.once('error',reject);upstream.listen(0,'127.0.0.1',resolve);});address=`http://127.0.0.1:${upstream.address().port}`;
let app,browser;
try{
 const packaged=process.argv.includes('--packaged');
 app=await electron.launch({args:packaged?[]:['.'],...(packaged?{executablePath:resolve('release/mac-arm64/Browser Agent.app/Contents/MacOS/Browser Agent')}:{}),env:{...process.env,AGENT_DATA_ROOT:root},timeout:30000});
 const page=await app.firstWindow();await page.waitForSelector('h1');
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('button',{name:'模型与接口'}).click();
 await page.locator('.settings select').first().selectOption('custom');
 await page.getByLabel('Base URL').fill(address+'/v1');
 await page.getByLabel('API Key').fill('smoke-key');
 await page.locator('input[list=models]').fill('fixture-browser-model');
 await page.getByRole('button',{name:'保存并探测能力'}).click();
 await page.getByText('✓ 通过',{exact:true}).first().waitFor({timeout:30000});
 assert.equal(await page.getByText('✓ 通过',{exact:true}).count(),6);
 await page.getByRole('button',{name:'任务工作台'}).click();
 await page.getByLabel('让 Agent 在当前网页做什么？').fill('测试任务：填写本地测试表单并在人工接管后验证姓名。');
 await page.getByRole('button',{name:'开始任务'}).click();
 await page.getByRole('button',{name:'让 Agent 继续'}).waitFor({timeout:30000});
 const port=(await readFile(join(root,'browser/profiles/default/DevToolsActivePort'),'utf8')).split('\n')[0];
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 const form=browser.contexts()[0].pages().find(p=>p.url()===address+'/form');assert.ok(form);
 assert.equal(await page.getByRole('button',{name:'确认执行这段代码'}).count(),0);assert.equal(await form.getByLabel('Name').inputValue(),'Agent draft');await form.getByLabel('Name').fill('Human verified');
 await page.getByRole('button',{name:'让 Agent 继续'}).click();
 await page.getByText('Run finished and replay bundle persisted.',{exact:true}).waitFor({timeout:30000});
 assert.equal(await form.getByLabel('Name').inputValue(),'Human verified');
 await page.locator('.stageScreenshot').waitFor();
 await page.getByRole('heading',{name:'执行结果'}).waitFor();
 const history=await page.evaluate(async()=>fetch('/api/history').then(r=>r.json()));assert.equal(history[0].status,'completed');
 const replay=JSON.parse(await readFile(join(root,'runs',history[0].id,'replay.json'),'utf8'));assert.ok(replay.browser.screenshots.length>=4);assert.ok(replay.events.some(e=>e.type==='function_call_completed'));
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/desktop-smoke.png'});
 await page.getByRole('button',{name:'执行历史'}).click();assert.equal(await page.locator('.historyRow').count(),1);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({desktop:'passed',providerCalls:responses,status:history[0].status,screenshots:replay.browser.screenshots.length,events:replay.events.length,screenshot:resolve('artifacts/desktop-smoke.png')}));
}catch(error){if(app){const windows=app.windows();await mkdir('artifacts',{recursive:true});if(windows[0]){await windows[0].screenshot({path:'artifacts/desktop-failure.png'});console.error((await windows[0].locator('body').innerText()).slice(-4000));}}throw error;}finally{await browser?.close();await app?.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(root,{recursive:true,force:true});}
