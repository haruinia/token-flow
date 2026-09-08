import { _electron as electron } from 'playwright';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = await mkdtemp(join(tmpdir(), 'login-desktop-'));
const allocator = createServer();
await new Promise((r,j) => {allocator.once('error',j);allocator.listen(0,'127.0.0.1',r);});
const port = allocator.address().port;await new Promise(r => allocator.close(r));
let app;
try {
  const packaged = process.argv.includes('--packaged');
  app = await electron.launch({args: packaged ? [] : ['.'],
    ...(packaged ? {executablePath: resolve('release/mac-arm64/Browser Agent.app/Contents/MacOS/Browser Agent')} : {}),
    env: {...process.env, AGENT_DATA_ROOT: root, AGENT_PROXY_PORT: String(port), CLIPROXY_BINARY: resolve('tests/fixtures/fake-cliproxy.mjs')},
  });
  // Only the test process intercepts shell.openExternal. Production always uses the real browser.
  await app.evaluate(({shell}) => {globalThis.openedOAuthURLs = [];shell.openExternal = async url => {globalThis.openedOAuthURLs.push(url);};});
  const page = await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'Local Agent',exact:false}).first().click();
  await page.getByRole('button',{name:'连接 Codex'}).click();
  await page.getByRole('button',{name:'取消本次授权'}).waitFor();
  assert.equal(await app.evaluate(() => globalThis.openedOAuthURLs.length),1);
  await page.getByRole('button',{name:'重新打开官方授权页'}).click();
  await page.waitForFunction(() => !document.querySelector('.busy'));
  assert.equal(await app.evaluate(() => globalThis.openedOAuthURLs.length),2);
  await page.getByRole('button',{name:'取消本次授权'}).click();
  await page.getByRole('button',{name:'重新连接 Codex'}).waitFor();
  await page.getByRole('button',{name:'重新连接 Codex'}).click();
  await page.getByRole('button',{name:'取消本次授权'}).waitFor();
  await fetch(`http://127.0.0.1:${port}/fixture`,{method:'POST',body:JSON.stringify({complete:true})});
  await page.getByText('user@example.test',{exact:false}).waitFor();
  await page.getByRole('button',{name:'停用',exact:true}).click();
  await page.getByRole('button',{name:'启用',exact:true}).waitFor();
  await page.getByRole('button',{name:'启用',exact:true}).click();
  await page.getByRole('button',{name:'使用此模型并前往能力检测'}).waitFor();
  await page.getByRole('button',{name:'使用此模型并前往能力检测'}).click();
  await page.getByRole('heading',{name:'模型与接口',exact:true}).waitFor();
  assert.equal(await page.locator('input[list=models]').inputValue(),'fixture-codex-model');
  await page.getByRole('button',{name:'Local Agent',exact:false}).first().click();
  await page.getByRole('button',{name:'连接 Claude'}).click();
  await page.getByText('已授权，但浏览器无法打开 localhost 回调？',{exact:true}).click();
  const login=await page.evaluate(() => fetch('/api/local-agent').then(r=>r.json()).then(s=>s.login));
  const state=new URL(login.url).searchParams.get('state');
  await page.getByLabel('完整回调地址',{exact:true}).fill(`http://localhost:54545/callback?state=${state}&code=test-fixture-callback`);
  await page.getByRole('button',{name:'提交回调',exact:true}).click();
  await page.getByText('Claude 授权',{exact:true}).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.accountList .account').length===2);
  await page.getByRole('button',{name:'重启',exact:true}).click();
  await page.waitForFunction(() => !document.querySelector('.busy'));
  assert.equal(await page.locator('.accountList .account').count(),2);
  assert.deepEqual(errors,[]);
  await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/local-agent-accounts.png'});
  console.log(JSON.stringify({loginUI:'passed',callbacks:'automatic + manual',accounts:2,restart:'restored',realAccountLogin:false}));
} catch(error) {
  if(app?.windows()[0]) {await mkdir('artifacts',{recursive:true});await app.windows()[0].screenshot({path:'artifacts/login-failure.png'});console.error((await app.windows()[0].locator('body').innerText()).slice(-3000));}
  throw error;
} finally {await app?.close();await rm(root,{recursive:true,force:true});}
