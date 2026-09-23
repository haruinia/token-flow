import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { ExtensionRelay } from '../packages/core/src/browser/extension-relay.js';
import { launchJavaScriptSession } from '../packages/core/src/browser/javascript-process.js';

it('rejects browser-origin pairing and unauthenticated CDP clients',async()=>{
 const relay=new ExtensionRelay();
 try{const pair=await relay.pair();
  for(const [url,origin] of [[pair.connectionURL,'https://evil.test'],[pair.connectionURL.replace('/extension','/cdp'),undefined]]){
   await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(url!,origin?{origin}:{});ws.on('open',()=>{ws.close();reject(new Error('Unexpected access'));});ws.on('error',error=>{expect(error.message).toContain('403');resolve();});});
  }
  expect(relay.state().running).toBe(false);
 }finally{await relay.close();}
});

it('connects a real extension to the selected logged-in tab, runs Playwright and detaches without closing Chrome',async()=>{
 const root=await mkdtemp(join(tmpdir(),'browser-extension-'));
 const relay=new ExtensionRelay();
 const fixture=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Logged-in fixture</title><label>Name <input aria-label="Name"></label>');});
 await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
 const address=`http://127.0.0.1:${(fixture.address() as {port:number}).port}`;
 const directory=resolve('extensions/chrome');
 const browser=await chromium.launchPersistentContext(root,{channel:'chromium',headless:false,args:[`--disable-extensions-except=${directory}`,`--load-extension=${directory}`]});
 let worker:Awaited<ReturnType<typeof launchJavaScriptSession>>|undefined;
 try{
  const background=browser.serviceWorkers()[0]??await browser.waitForEvent('serviceworker');const extensionId=new URL(background.url()).host;
  const form=await browser.newPage();await form.goto(address);await form.evaluate(()=>localStorage.setItem('session-fixture','already-logged-in'));
  const other=await browser.newPage();await other.goto(address+'/other');
  const popup=await browser.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const pair=await relay.pair();await popup.locator('#connection').fill(pair.connectionURL);await form.bringToFront();
  await popup.evaluate(()=>document.querySelector<HTMLFormElement>('#connect')!.requestSubmit());
  await expect.poll(async()=>popup.locator('#status').innerText()).toContain('已连接');
  await expect.poll(()=>relay.state().running).toBe(true);
  const launch=()=>launchJavaScriptSession({endpoint:relay.endpoint(),workerPath:resolve('packages/core/src/javascript-worker.ts'),browserMode:'headful',screenshotDir:join(root,'shots'),url:'',targetLabel:'Selected tab',executionTimeoutMs:10000});
  worker=await launch();
  expect((await worker.readState()).currentUrl).toBe(address+'/');
  const result=await worker.execute("console.log(await page.evaluate(() => localStorage.getItem('session-fixture'))); console.log('pages', context.pages().length); await page.getByLabel('Name').fill('Agent through extension');");
  expect(JSON.stringify(result)).toContain('already-logged-in');expect(JSON.stringify(result)).toContain('pages 1');
  expect(await form.getByLabel('Name').inputValue()).toBe('Agent through extension');expect(await other.getByLabel('Name').inputValue()).toBe('');
  await worker.captureScreenshot('extension');
  await worker.execute("await page.close()").catch(()=>{});expect(form.isClosed()).toBe(false);
  await worker.close();worker=undefined;expect(form.isClosed()).toBe(false);
  worker=await launch();await worker.execute("console.log(await page.getByLabel('Name').inputValue())");
  relay.disconnect();
  await expect.poll(async()=>background.evaluate('selectedTab === undefined')).toBe(true);
  await worker.execute("await page.getByLabel('Name').fill('Must not execute')").catch(()=>{});
  expect(await form.getByLabel('Name').inputValue()).toBe('Agent through extension');
  expect(form.isClosed()).toBe(false);await expect.poll(async()=>background.evaluate('selectedTab === undefined')).toBe(true);
 }finally{await worker?.close();await relay.close();await browser.close();fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));await rm(root,{recursive:true,force:true});}
},60000);
