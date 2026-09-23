import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { BrowserHost, safeEnvironment } from '../packages/core/src/browser/host.js';
import { launchJavaScriptSession } from '../packages/core/src/browser/javascript-process.js';
import { RunControl } from '../packages/core/src/control.js';
import { runResponsesCodeLoop } from '../packages/core/src/responses-loop.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'browser-agent-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Application fixture</title><label>Name <input aria-label="Name"></label><button onclick="document.body.dataset.submitted=1">Submit</button>');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
 const host=new BrowserHost(root,true);const endpoint=await host.open();cleanup.push(()=>host.close());
 const page=host.context!.pages()[0];await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
 const launch=(timeout=5000,desktop=false)=>launchJavaScriptSession({endpoint,workerPath:resolve('packages/core/src/javascript-worker.ts'),browserMode:'headless',screenshotDir:join(root,'shots'),targetLabel:'test',url:'',executionTimeoutMs:timeout,desktop});
 return {root,host,page,launch};
}
describe('persistent browser + isolated worker',()=>{
 it('keeps browser and form state through worker close, timeout, reattach and profile restart',async()=>{
   const {host,page,launch}=await fixture();
   const first=await launch();cleanup.push(()=>first.close());
   await first.execute("await page.getByLabel('Name').fill('Ada'); await page.evaluate(() => localStorage.setItem('saved','yes')); console.log('filled');");
   expect(await page.getByLabel('Name').inputValue()).toBe('Ada');await first.close();
   expect(host.context).toBeDefined();expect(await page.getByLabel('Name').inputValue()).toBe('Ada');
   const blocked=await launch(300);await expect(blocked.execute('while(true) {}')).rejects.toThrow('exceeded');
   expect(await page.title()).toBe('Application fixture');
   const next=await launch();cleanup.push(()=>next.close());const result=await next.execute("console.log(await page.getByLabel('Name').inputValue());");expect(JSON.stringify(result)).toContain('Ada');
   const snapshot=await next.captureScreenshot('test');expect((await readFile(snapshot.path)).length).toBeGreaterThan(100);
   const url=page.url();await next.close();await host.close();await host.open();const restored=host.context!.pages()[0];await restored.goto(url);expect(await restored.evaluate(()=>localStorage.getItem('saved'))).toBe('yes');
 });
 it('tracks focused/new tabs on resync and excludes arbitrary credential environment',async()=>{
   const {host,launch}=await fixture();const worker=await launch();cleanup.push(()=>worker.close());
   const tab=await host.context!.newPage();await tab.goto('data:text/html,<title>New tab</title><p>Resumed</p>');await tab.bringToFront();
   expect((await worker.readState()).pageTitle).toBe('New tab');
   expect(JSON.stringify(await worker.execute('console.log(await page.title())'))).toContain('New tab');
   process.env.CUSTOM_SECRET_SENTINEL='not-in-worker';expect(safeEnvironment()).not.toHaveProperty('CUSTOM_SECRET_SENTINEL');delete process.env.CUSTOM_SECRET_SENTINEL;
 });
 it('exposes the desktop global only when desktop control is enabled, without touching the OS until used',async()=>{
   const {launch}=await fixture();
   const plain=await launch();cleanup.push(()=>plain.close());
   expect(JSON.stringify(await plain.execute('console.log(typeof desktop)'))).toContain('undefined');
   const enabled=await launch(5000,true);cleanup.push(()=>enabled.close());
   // 只检查接口形状，不触发任何 osascript / powershell 调用。
   expect(JSON.stringify(await enabled.execute("console.log(typeof desktop, ['screenshot','click','type','key','open','windows'].every(k => typeof desktop[k] === 'function'))"))).toContain('object true');
   // 桌面未被使用时，存档截图仍是浏览器页面。
   expect((await enabled.captureScreenshot('still-browser')).currentUrl).toMatch(/^http:\/\/127\.0\.0\.1/);
 });
});
describe('human control',()=>{
 it('waits at operation boundary and rejects stale resume requests; abort releases the wait',async()=>{
   const controller=new AbortController();const control=new RunControl();control.bind(controller.signal);control.pause();expect(control.state).toBe('pausing');
   const waiting=control.checkpoint();expect(control.state).toBe('human_control');expect(()=>control.resume('old-id')).toThrow('过期');control.resume(control.pending!.id);await waiting;
   const takeover=control.human('Complete login');await Promise.resolve();expect(control.state).toBe('human_control');controller.abort();await expect(takeover).rejects.toThrow('aborted');expect(control.pending).toBeUndefined();
 });
 it('uses the upstream loop to fill, yield to human, resync and finish with stateless history',async()=>{
   const {page,launch}=await fixture();const worker=await launch();cleanup.push(()=>worker.close());
   const controller=new AbortController();const outputs:unknown[]=[];const calls:Record<string,unknown>[]=[];
   const responses=[{type:'function_call',name:'exec_js',call_id:'c1',arguments:JSON.stringify({code:"await page.getByLabel('Name').fill('Agent'); console.log('filled');"})},{type:'function_call',name:'request_human_takeover',call_id:'c2',arguments:JSON.stringify({message:'Please update the name manually'})},{type:'message',role:'assistant',content:[{type:'output_text',text:'Completed'}]}];
   const result=await runResponsesCodeLoop({session:worker,historyMode:'stateless',reasoning:'off',maxResponseTurns:4,
    context:{detail:{run:{prompt:'Fill current form',model:'fixture'}},signal:controller.signal,emitEvent:async(e:unknown)=>{outputs.push(e);},syncBrowserState:async()=>{},captureScreenshot:async()=>({})} as never,
    instructions:'Test',humanTakeover:async()=>{await page.getByLabel('Name').fill('Human');}
   },{create:async request=>{calls.push(structuredClone(request));return {id:`r${calls.length}`,status:'completed',output:[responses[calls.length-1]]};}});
   expect(result.finalAssistantMessage).toBe('Completed');expect(await page.getByLabel('Name').inputValue()).toBe('Human');expect(calls[2].previous_response_id).toBeUndefined();expect(JSON.stringify(calls[2].input)).toContain('Human returned control');expect(outputs.length).toBeGreaterThan(3);
 });
});
