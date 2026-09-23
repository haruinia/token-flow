import { createServer as allocatePort } from 'node:net';
const allocator=allocatePort();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const proxyPort=allocator.address().port;await new Promise(r=>allocator.close(r));
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Real desktop service in an isolated profile; no accounts or model calls.
const root = await mkdtemp(join(tmpdir(), 'agent-design-'));
const output = resolve('artifacts/design');
const packaged = process.argv.includes('--packaged');
let app;
try {
  await mkdir(output, {recursive:true});
  app = await electron.launch({args:packaged?[]:['.'],
    ...(packaged?{executablePath:resolve('release/mac-arm64/token-flowb.app/Contents/MacOS/token-flowb')} : {}),
    env:{...process.env,AGENT_DATA_ROOT:root,CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),WORKBUDDY_CONFIG_DIR:join(root,'workbuddy'),AGENT_PORT:'0',AGENT_PROXY_PORT:String(proxyPort),CLIPROXY_BINARY:resolve('tests/fixtures/fake-cliproxy.mjs')}});
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.a2aPage').waitFor();await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'API 总览',exact:true}).click();await page.locator('.gatewayHome').waitFor();
  await page.getByRole('button',{name:'任务调试',exact:true}).click();await page.getByRole('tab',{name:'浏览器任务',exact:true}).click();
  await page.locator('.workspaceIntro').waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.title(),'token-flowb');
  assert.equal(await app.evaluate(({app})=>app.getName()),'token-flowb');
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),root);
  assert.match(await page.locator('.brand').innerText(),/token-flowb/);
  assert.equal(await page.getByRole('complementary',{name:'运行环境'}).isVisible(),true);
  assert.equal(await page.locator('.preview').count(), 0);
  assert.equal(await page.locator('#task-options').isVisible(), false);
  assert.equal(await page.getByRole('button',{name:'开始任务',exact:true}).isDisabled(), true);
  const nav = page.locator('.sidebar');
  await page.getByRole('button',{name:'整理网页信息'}).click();
  assert.match(await page.locator('#task').inputValue(), /当前打开的网页/);
  assert.equal(await page.locator('#task').evaluate(el => el === document.activeElement), true);
  await page.locator('#task').press(process.platform==='darwin'?'Meta+Enter':'Control+Enter');
  assert.equal(await page.evaluate(() => fetch('/api/history').then(r=>r.json()).then(h=>h.length)), 0);
  await nav.getByRole('button',{name:'模型中心',exact:true}).click();
  await nav.getByRole('button',{name:'任务调试',exact:true}).click();await page.getByRole('tab',{name:'浏览器任务',exact:true}).click();
  assert.match(await page.locator('#task').inputValue(), /当前打开的网页/);
  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  assert.equal(await page.locator('#task').inputValue(), '');
  await page.screenshot({animations:'disabled',path:join(output,'workspace.png')});
  await page.getByRole('button',{name:'浏览器与桌面设置',exact:true}).click();
  await page.getByLabel('浏览器来源').waitFor();
  assert.equal(await page.getByLabel('最大轮次').inputValue(), '24');
  await page.getByRole('button',{name:'收起任务设置',exact:true}).click();
  assert.equal(await page.locator('#task-options').isVisible(), false);
  await page.getByRole('button',{name:'查看浏览器与回放'}).click();
  await page.locator('.preview').waitFor();
  await page.getByRole('button',{name:'收起浏览器观察'}).click();
  assert.equal(await page.locator('.preview').count(), 0);
  const pages = [['任务调试','workspace'],['模型中心','accounts'],['执行历史','history']];
  for (const width of [390,768,1320]) {
    await page.setViewportSize({width,height:900});
    for (const [name,file] of pages) {
      await nav.getByRole('button',{name,exact:true}).click();
      assert.equal(await page.evaluate(() => {
        const main=document.querySelector('main');
        return document.documentElement.scrollWidth>innerWidth || main.scrollWidth>main.clientWidth+1;
      }),false,`${name} overflows at ${width}px`);
      if(width===1320||name==='任务调试') await page.screenshot({animations:'disabled',path:join(output,`${file}-${width}.png`)});
    }
  }
  await nav.getByRole('button',{name:'模型中心',exact:true}).click();
  for (const width of [390,768,1320]) {
    await page.setViewportSize({width,height:900});
    for (const name of ['账号与模型','接口与能力','API Keys','网关设置']) {
      await page.getByRole('tab',{name,exact:true}).click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.querySelector('main').scrollWidth>document.querySelector('main').clientWidth+1),false,`${name} overflows at ${width}px`);
    }
  }
  await page.route('**/api/history',route=>route.fulfill({json:[
    {id:'design-complete',prompt:'整理产品信息',model:'fixture-model',status:'completed',startedAt:'2026-09-21T00:00:00Z'},
    {id:'design-failed',prompt:'填写申请表单',model:'fixture-model',status:'failed',startedAt:'2026-09-20T00:00:00Z'}
  ]}));
  await page.reload();
  await nav.getByRole('button',{name:'执行历史',exact:true}).click();
  await page.locator('.historyRow').nth(1).waitFor();
  await page.getByLabel('搜索任务记录').fill('产品');
  assert.equal(await page.locator('.historyRow').count(),1);
  await page.getByLabel('任务状态',{exact:true}).selectOption('failed');
  await page.getByRole('heading',{name:'没有匹配的任务'}).waitFor();
  await page.getByRole('button',{name:'清除筛选'}).click();
  assert.equal(await page.locator('.historyRow').count(),2);
  await page.getByLabel('任务状态',{exact:true}).selectOption('failed');
  assert.match(await page.locator('.historyRow').innerText(),/填写申请表单/);
  await page.unroute('**/api/history');
  const prefs = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.contextIsolation,true);
  assert.equal(prefs.nodeIntegration,false);
  assert.equal(prefs.sandbox,true);
  assert.deepEqual(errors,[]);
  if(!packaged) {
    await app.close();app=undefined;
    // Exercise the actual startup with a fake OS appData directory, never the user's profile.
    for(const existing of [true,false]) {
      const appData=join(root,existing?'legacy-os':'fresh-os');
      await mkdir(appData,{recursive:true});
      if(existing) await mkdir(join(appData,'desktop-browser-agent'));
      const bootstrap=join(root,existing?'legacy-bootstrap.cjs':'fresh-bootstrap.cjs');
      await writeFile(bootstrap,`const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});import(${JSON.stringify(new URL('../dist/main.js',import.meta.url).href)});`);
      app=await electron.launch({args:[bootstrap],env:{...process.env,AGENT_DATA_ROOT:'',AGENT_PORT:'0',AGENT_PROXY_PORT:String(proxyPort),CLIPROXY_BINARY:resolve('tests/fixtures/fake-cliproxy.mjs')}});
      const profilePage=await app.firstWindow();await profilePage.locator('.brand').waitFor();
      assert.equal(await app.evaluate(({app})=>app.getPath('userData')),join(appData,existing?'desktop-browser-agent':'token-flowb'));
      assert.equal(await app.evaluate(({app})=>app.getName()),'token-flowb');
      await app.close();app=undefined;
    }
  }
  console.log(JSON.stringify({design:'passed',packaged,pages:3,widths:[390,768,1320],checks:['examples','draft preserved','new task','unconfigured shortcut blocked','settings toggle','preview toggle','overflow','renderer sandbox','product identity','profile override','legacy and fresh profile startup','history search and filters'],screenshots:output}));
} finally {
  await app?.close();
  await rm(root,{recursive:true,force:true});
}
