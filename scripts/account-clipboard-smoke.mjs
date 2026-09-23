import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'token-flowb-actions-'));
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
let app;
try {
 await mkdir(join(root,'cliproxy'));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([
  {name:'expired.json',provider:'antigravity',email:'expired@example.test',disabled:true,unavailable:true},
  {name:'codex.json',provider:'codex',email:'active@example.test',status:'active',auth_index:'idx-codex',models:['gpt-5.6-sol']},
 ]));
 const packaged=process.argv.includes('--packaged');
 app=await electron.launch({args:packaged?[]:['.'],...(packaged?{executablePath:resolve('release/mac-arm64/token-flowb.app/Contents/MacOS/token-flowb')}:{}),env:{...process.env,AGENT_DATA_ROOT:root,CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),WORKBUDDY_CONFIG_DIR:join(root,'workbuddy'),AGENT_PORT:'0',AGENT_PROXY_PORT:String(port),CLIPROXY_BINARY:resolve('tests/fixtures/fake-cliproxy.mjs')}});
 await app.evaluate(({clipboard})=>{globalThis.savedClipboard=clipboard.readText();});
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>fetch('/api/local-agent').then(r=>r.json()).then(s=>s.accounts.length===2));
 const nav=page.getByRole('navigation',{name:'主导航'});
 await nav.getByRole('button',{name:'模型中心',exact:true}).click();
 const account=page.locator('.account').filter({hasText:'expired@example.test'});
 page.once('dialog',dialog=>dialog.accept());
 const deleted=page.waitForResponse(r=>r.request().method()==='DELETE');
 await account.getByRole('button',{name:'删除',exact:true}).click();
 const response=await deleted;const deletionStatus=response.status();
 const deletionError=deletionStatus===200?'':(await response.json()).error;
 await nav.getByRole('button',{name:'API Keys',exact:true}).click();
 await page.getByRole('button',{name:'创建 Key',exact:true}).click();
 await page.getByLabel('Key 名称',{exact:true}).fill('Clipboard regression');
 await page.getByLabel('全选所有提供商与模型',{exact:true}).check();
 await page.getByRole('button',{name:'生成 Key',exact:true}).click();
 const key=await page.getByLabel('新建 API Key',{exact:true}).inputValue();
 await page.getByRole('button',{name:'复制 Key',exact:true}).click();
 const copied=await app.evaluate(({clipboard},value)=>clipboard.readText()===value,key);
 console.log(JSON.stringify({packaged,deletionStatus,deletionError,copied}));
 assert.equal(deletionStatus,200,'Account deletion failed');
 assert.equal(copied,true,'Copy Key did not write the system clipboard');
 await page.getByRole('button',{name:'已复制',exact:true}).waitFor();
 await nav.getByRole('button',{name:'Agent 接入',exact:true}).click();
 await page.getByLabel('调用模型',{exact:true}).selectOption('codex/gpt-5.6-sol');
 const config=await page.getByLabel('Agent 接入配置',{exact:true}).innerText();
 await page.getByRole('button',{name:'复制配置',exact:true}).click();
 await page.getByRole('button',{name:'已复制',exact:true}).waitFor();
 assert.equal(await app.evaluate(({clipboard},value)=>clipboard.readText()===value,config),true);
 await nav.getByRole('button',{name:'API 总览',exact:true}).click();
 await page.getByRole('button',{name:'复制',exact:true}).click();
 await page.getByRole('button',{name:'已复制',exact:true}).waitFor();
 assert.equal(await app.evaluate(({clipboard},value)=>clipboard.readText()===value,new URL('/v1',page.url()).href),true);
 await nav.getByRole('button',{name:'API Keys',exact:true}).click();
 page.once('dialog',dialog=>dialog.accept());
 const keyDeleted=page.waitForResponse(r=>r.request().method()==='DELETE');
 await page.getByRole('button',{name:'删除',exact:true}).click();
 assert.equal((await keyDeleted).status(),200,'Key deletion failed');
 assert.equal(await page.evaluate(async()=>{try{await window.desktop.copyText({invalid:true});return false;}catch{return true;}}),true);
 await nav.getByRole('button',{name:'模型中心',exact:true}).click();
 assert.equal(await page.locator('.account').filter({hasText:'expired@example.test'}).count(),0);
 assert.deepEqual(errors,[]);
 console.log('Account + Key deletion, Key + config + URL clipboard, invalid clipboard input: passed.');
} finally {
 if(app)await app.evaluate(({clipboard})=>clipboard.writeText(globalThis.savedClipboard??'')).catch(()=>{});
 await app?.close();await rm(root,{recursive:true,force:true});
}
