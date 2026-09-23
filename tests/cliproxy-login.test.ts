import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { CLIProxyManager, validateAuthorizationURL } from '../packages/core/src/cliproxy.js';
import { createDesktopService } from '../packages/core/src/service.js';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const fn of cleanup.splice(0).reverse()) await fn();});
const binary = resolve('tests/fixtures/fake-cliproxy.mjs');
async function setup(timeout = 5000) {
  const root = await mkdtemp(join(tmpdir(), 'cliproxy-login-'));
  cleanup.push(() => rm(root, {recursive: true, force: true}));
  const server = createServer();await new Promise<void>((r,j) => {server.once('error',j);server.listen(0,'127.0.0.1',r);});
  const port=(server.address() as {port:number}).port;await new Promise<void>(r => server.close(() => r()));
  const opened: string[] = [];
  const manager=new CLIProxyManager(root,binary,'fixture-key',port,{openExternal:async url => {opened.push(url);},pollIntervalMs:20,loginTimeoutMs:timeout});
  cleanup.push(() => manager.shutdown());
  const fixture=async(body?: unknown) => (await fetch(`http://127.0.0.1:${port}/fixture`, {method:body?'POST':'GET',body:body?JSON.stringify(body):undefined})).json();
  return {manager,root,port,opened,fixture};
}
it('auto-starts, opens only official OAuth, confirms automatic callback and restores saved accounts on restart',async () => {
  const {manager,opened,fixture}=await setup();
  let snapshot=await manager.login('codex');expect(snapshot.state).toBe('running');expect(snapshot.loginState).toBe('waiting_for_browser');expect(opened[0]).toMatch(/^https:\/\/auth.openai.com\/oauth\/authorize/);
  await expect(manager.login('claude')).rejects.toThrow('已有授权');
  await manager.openLogin(snapshot.login!.id);expect(opened).toHaveLength(2);
  const state=new URL(snapshot.login!.url!).searchParams.get('state');
  expect((await fetch('http://127.0.0.1:1455/auth/callback?state=wrong&code=nope')).status).toBe(400);
  expect((await fetch(`http://127.0.0.1:1455/auth/callback?state=${state}&code=fixture-code`)).ok).toBe(true);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  snapshot=manager.snapshot();expect(snapshot.accounts[0].label).toBe('user@example.test');expect(snapshot.models[0].id).toBe('codex/fixture-codex-model');
  expect(JSON.stringify(snapshot)).not.toMatch(/never-expose|private\/credentials|fixture-key|code_challenge/);
  await manager.setAccountEnabled(snapshot.accounts[0].id,false);expect(manager.snapshot().accounts[0].disabled).toBe(true);expect(manager.snapshot().models).toEqual([]);
  await manager.setAccountEnabled(snapshot.accounts[0].id,true);await manager.stop();await manager.start();expect(manager.snapshot().accounts).toHaveLength(1);
});
it('validates manual callback origin, session and provider, without persisting callback secrets in snapshots',async () => {
  const {manager,fixture}=await setup();const started=await manager.login('claude');const id=started.login!.id;const state=new URL(started.login!.url!).searchParams.get('state');
  await expect(manager.submitCallback(id,`http://localhost:54545/callback?state=stale&code=callback-secret`)).rejects.toThrow('旧会话');
  await expect(manager.submitCallback(id,`https://evil.test/callback?state=${state}&code=callback-secret`)).rejects.toThrow();
  await expect(manager.submitCallback('stale',`http://localhost:54545/callback?state=${state}&code=callback-secret`)).rejects.toThrow('过期');
  expect((await fixture()).callbackCount).toBe(0);
  await manager.submitCallback(id,`http://localhost:54545/callback?state=${state}&code=callback-secret`);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts[0].provider).toBe('claude');expect(JSON.stringify(manager.snapshot())).not.toContain('callback-secret');
  await expect(manager.submitCallback(id,`http://localhost:54545/callback?state=${state}&code=callback-secret`)).rejects.toThrow();
});
it('cancels upstream OAuth sessions, retries, times out, and never treats provider errors as successful login',async () => {
  const {manager,fixture}=await setup(600);
  const first=await manager.login('codex');await manager.cancelLogin(first.login!.id);expect(manager.snapshot().loginState).toBe('cancelled');expect((await fixture()).cancelCount).toBe(1);
  await fixture({mode:'error'});await manager.login('codex');await expect.poll(() => manager.snapshot().loginState).toBe('failed');expect(JSON.stringify(manager.snapshot())).not.toContain('opaque-error-secret');
  await fixture({mode:'wait'});await manager.login('codex');await expect.poll(() => manager.snapshot().loginState).toBe('expired');expect((await fixture()).cancelCount).toBe(2);
});
it('rejects non-official authorization links and cancels the upstream session before opening anything',async () => {
  const {manager,fixture,opened}=await setup();await manager.start();await fixture({mode:'unsafe'});await manager.login('codex');expect(manager.snapshot().loginState).toBe('failed');expect(opened).toEqual([]);expect((await fixture()).cancelCount).toBe(1);
  expect(() => validateAuthorizationURL('https://auth.openai.com.evil.test/oauth/authorize','codex')).toThrow();
});
it('serves protected desktop login actions and never returns management credentials',async () => {
  const {root,port}=await setup();
  const service=await createDesktopService({root,proxyPort:port,binary,token:'desktop-token',localKey:'fixture-key',secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(() => service.app.close());
  const headers={host:'127.0.0.1:9527',authorization:'Bearer desktop-token'};
  const unauthorized=await service.app.inject({method:'POST',url:'/api/local-agent/codex',payload:{},headers:{host:headers.host}});expect(unauthorized.statusCode).toBe(401);
  const start=await service.app.inject({method:'POST',url:'/api/local-agent/codex',headers,payload:{}});expect(start.statusCode).toBe(200);const login=start.json().login;expect(login.status).toBe('waiting_for_browser');expect(start.body).not.toContain('fixture-key');
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/login/cancel',headers,payload:{id:login.id}})).json().login.status).toBe('cancelled');
});

it('connects Antigravity through the Google authorization endpoint and validates its own callback',async () => {
  const {manager,opened}=await setup();const snapshot=await manager.login('antigravity');
  expect(opened[0]).toMatch(/^https:\/\/accounts.google.com\/o\/oauth2\/v2\/auth/);
  const state=new URL(snapshot.login!.url!).searchParams.get('state');
  await expect(manager.submitCallback(snapshot.login!.id,`http://localhost:1455/auth/callback?state=${state}&code=test`)).rejects.toThrow();
  expect((await fetch(`http://[::1]:51121/oauth-callback?state=${state}&code=test`)).ok).toBe(true);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts[0].provider).toBe('antigravity');
  expect(() => validateAuthorizationURL('https://accounts.google.com.evil.test/o/oauth2/v2/auth','antigravity')).toThrow();
});
it('connects Kimi through the device-code flow: shows the user code, has no callback, routes models to the login provider',async () => {
  const {manager,opened,fixture}=await setup();
  expect(manager.snapshot().providers.map(p => p.id)).toEqual(['codex','claude','antigravity','kimi','xai','qoder','workbuddy','zcode','doubao','trae','cursor']);
  const snapshot=await manager.login('kimi');const login=snapshot.login!;
  expect(login.flow).toBe('device');expect(login.userCode).toBe('FIXT-CODE');expect(login.status).toBe('waiting_for_browser');
  expect(opened[0]).toBe('https://www.kimi.com/code/authorize_device?user_code=FIXT-CODE');
  await expect(manager.submitCallback(login.id,`http://localhost:1455/auth/callback?state=x&code=y`)).rejects.toThrow('设备码');
  expect((await fixture()).callbackCount).toBe(0);
  await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  const done=manager.snapshot();
  expect(done.accounts[0].provider).toBe('kimi');expect(done.models).toEqual([{id:'kimi/fixture-kimi-model',provider:'kimi'}]);
  expect(done.login!.userCode).toBeUndefined();expect(JSON.stringify(done)).not.toMatch(/never-expose|FIXT-CODE/);
  expect(() => validateAuthorizationURL('https://www.kimi.com.evil.test/code/authorize_device','kimi')).toThrow();
  expect(() => validateAuthorizationURL('https://www.kimi.com/other','kimi')).toThrow();
});
it('connects xAI through the device-code flow, cancels upstream on unsafe links and expires by the shorter limit',async () => {
  const {manager,opened,fixture}=await setup(600);await manager.start();
  await fixture({mode:'unsafe'});await manager.login('xai');expect(manager.snapshot().loginState).toBe('failed');expect(opened).toEqual([]);expect((await fixture()).cancelCount).toBe(1);
  await fixture({mode:'wait'});const snapshot=await manager.login('xai');
  expect(opened[0]).toBe('https://accounts.x.ai/oauth2/device?user_code=FIXT-CODE');
  // Upstream reports expires_in 1800s; the explicit test limit (600ms) must win.
  expect(Date.parse(snapshot.login!.expiresAt!)-Date.now()).toBeLessThan(5000);
  await expect.poll(() => manager.snapshot().loginState).toBe('expired');expect((await fixture()).cancelCount).toBe(2);
  await manager.login('xai');await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.map(a => a.provider)).toEqual(['xai']);expect(manager.snapshot().models[0]).toEqual({id:'xai/fixture-xai-model',provider:'xai'});
  expect(() => validateAuthorizationURL('https://accounts.x.ai.evil.test/oauth2/device','xai')).toThrow();
});
it('queries per-account quota through upstream api-call without handling tokens, and keeps failures opaque',async () => {
  const {manager,fixture}=await setup();
  for (const provider of ['kimi','xai'] as const) {await manager.login(provider);await fixture({complete:true});await expect.poll(() => manager.snapshot().loginState).toBe('completed');}
  let snapshot=await manager.refreshQuota();
  const byProvider=Object.fromEntries(Object.values(snapshot.quotas).map(q => [q.provider,q]));
  expect(byProvider.kimi.status).toBe('ok');expect(byProvider.kimi.windows.map(w => w.label)).toEqual(['5h window','1 周','周用量']);
  expect(byProvider.xai.status).toBe('ok');expect(byProvider.xai.plan).toBe('subscription');expect(byProvider.xai.windows.map(w => w.id)).toEqual(['credits','product-0','monthly','on-demand']);
  const calls=(await fixture()).apiCalls as {authIndex:string;url:string;rawToken:boolean}[];
  expect(calls.length).toBeGreaterThanOrEqual(3);expect(calls.every(c => c.rawToken)).toBe(true);expect(new Set(calls.map(c => c.authIndex))).toEqual(new Set(['idx-kimi','idx-xai']));
  expect(JSON.stringify(snapshot)).not.toMatch(/idx-|never-expose|\$TOKEN\$/);
  await manager.setAccountEnabled(snapshot.accounts.find(a => a.provider==='xai')!.id,false);
  await fixture({mode:'quota-error'});snapshot=await manager.refreshQuota();
  const kimi=Object.values(snapshot.quotas).find(q => q.provider==='kimi')!;
  expect(kimi.status).toBe('error');expect(kimi.error).toMatch(/HTTP 429/);expect(JSON.stringify(snapshot)).not.toContain('upstream-secret');
  expect(Object.values(snapshot.quotas).find(q => q.provider==='xai')!.status).toBe('ok');
  expect((await fixture()).apiCalls.length).toBeGreaterThanOrEqual(calls.length+1);
});
it('exposes Kimi and xAI login actions through the desktop API',async () => {
  const {root,port}=await setup();
  const service=await createDesktopService({root,proxyPort:port,binary,token:'desktop-token',localKey:'fixture-key',secrets:{get:async()=>'',set:async()=>{}}});cleanup.push(() => service.app.close());
  const headers={host:'127.0.0.1:9527',authorization:'Bearer desktop-token'};
  const start=await service.app.inject({method:'POST',url:'/api/local-agent/kimi',headers,payload:{}});expect(start.statusCode).toBe(200);
  const login=start.json().login;expect(login.flow).toBe('device');expect(login.userCode).toBe('FIXT-CODE');
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/login/callback',headers,payload:{id:login.id,redirectURL:'http://localhost:1455/auth/callback?state=x&code=y'}})).statusCode).toBe(400);
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/login/cancel',headers,payload:{id:login.id}})).json().login.status).toBe('cancelled');
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/grok',headers,payload:{}})).statusCode).toBe(400);
  expect((await service.app.inject({method:'POST',url:'/api/local-agent/xai',headers,payload:{}})).json().login.provider).toBe('xai');
  const quota=await service.app.inject({method:'POST',url:'/api/local-agent/quota',headers,payload:{}});expect(quota.statusCode).toBe(200);expect(quota.json().quotas).toEqual({});
});

it('connects Qoder and WorkBuddy through device/web flow without required user code',async () => {
  const {manager,opened,fixture}=await setup();
  // Qoder
  const qoderSnap=await manager.login('qoder');const qLogin=qoderSnap.login!;
  expect(qLogin.flow).toBe('device');expect(qLogin.userCode).toBeUndefined();
  expect(opened[0]).toMatch(/^https:\/\/qoder.com\/device\/selectAccounts/);
  await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts[0].provider).toBe('qoder');
  expect(manager.snapshot().models[0]).toEqual({id:'qoder/fixture-qoder-model',provider:'qoder'});
  await fixture({modelSets:{qoder:[{id:'kmodel_latest',display_name:'Kimi K3 (Qoder)'},'auto']}});
  await manager.refreshAccounts();await manager.refreshAccounts();
  expect(manager.snapshot().models).toContainEqual({id:'qoder/kmodel_latest',provider:'qoder',displayName:'Kimi K3 (Qoder)'});
  expect(manager.snapshot().accounts[0].models).toContain('qoder/kmodel_latest');
  expect(manager.snapshot().models.some(m=>m.id==='qoder/Kimi-K3')).toBe(false);
  expect(manager.sourceAuth(manager.snapshot().accounts[0].id,'qoder/kmodel_latest')).toBeTruthy();
  expect(() => validateAuthorizationURL('https://qoder.com.evil.test/device/selectAccounts','qoder')).toThrow();

  // WorkBuddy
  const wbSnap=await manager.login('workbuddy');const wbLogin=wbSnap.login!;
  expect(wbLogin.flow).toBe('device');expect(wbLogin.userCode).toBeUndefined();
  expect(opened[1]).toMatch(/^https:\/\/copilot.tencent.com\/login/);
  await fixture({complete:true});
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.some(a => a.provider==='workbuddy')).toBe(true);
  expect(manager.snapshot().models.some(m => m.provider==='workbuddy')).toBe(true);
  expect(() => validateAuthorizationURL('https://copilot.tencent.com.evil.test/login','workbuddy')).toThrow();
});

it('connects ZCode, Doubao, and Trae through callback flows and validates authorization URLs',async () => {
  const {manager,opened,fixture}=await setup();
  // ZCode
  const zSnap=await manager.login('zcode');
  expect(opened[0]).toMatch(/^https:\/\/chat.z.ai\/api\/oauth\/authorize/);
  const zState=new URL(zSnap.login!.url!).searchParams.get('state');
  expect((await fetch(`http://127.0.0.1:9999/zcode/callback?state=${zState}&code=zcode-code`)).ok).toBe(true);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.some(a => a.provider==='zcode')).toBe(true);
  expect(manager.snapshot().models.some(m => m.provider==='zcode')).toBe(true);
  expect(() => validateAuthorizationURL('https://chat.z.ai.evil.test/api/oauth/authorize','zcode')).toThrow();

  // Doubao
  const dbSnap=await manager.login('doubao');
  expect(opened[1]).toMatch(/^https:\/\/www.marscode.cn\/authorization/);
  const dbState=new URL(dbSnap.login!.url!).searchParams.get('state');
  expect((await fetch(`http://127.0.0.1:1455/doubao/callback?state=${dbState}&code=doubao-code`)).ok).toBe(true);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.some(a => a.provider==='doubao')).toBe(true);
  expect(manager.snapshot().models.some(m => m.provider==='doubao')).toBe(true);
  expect(() => validateAuthorizationURL('https://www.marscode.cn.evil.test/authorization','doubao')).toThrow();

  // Trae (validates nested state in redirect_url)
  const traeSnap=await manager.login('trae');
  expect(opened[2]).toMatch(/^https:\/\/www.trae.ai\/login\?redirect_url=/);
  const traeState=new URL(new URL(traeSnap.login!.url!).searchParams.get('redirect_url')!).searchParams.get('state');
  expect((await fetch(`http://127.0.0.1:1455/trae/callback?state=${traeState}&code=trae-code`)).ok).toBe(true);
  await expect.poll(() => manager.snapshot().loginState).toBe('completed');
  expect(manager.snapshot().accounts.some(a => a.provider==='trae')).toBe(true);
  expect(manager.snapshot().models.some(m => m.provider==='trae')).toBe(true);
  expect(() => validateAuthorizationURL('https://www.trae.ai.evil.test/login','trae')).toThrow();
});

it('loads saved account models after delayed registration without navigating or manually refreshing',async()=>{
 const {root,manager}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy','fixture-options.json'),JSON.stringify({modelDelayMs:700}));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex-saved.json',provider:'codex',status:'active',auth_index:'saved',models:['gpt-6-astra']}]));
 await manager.start();
 expect(manager.snapshot().accounts).toHaveLength(1);
 await expect.poll(()=>manager.snapshot().accounts[0]?.models,{timeout:5000}).toContain('codex/gpt-6-astra');
 expect(manager.snapshot().models.some(m=>m.id==='codex/gpt-6-astra')).toBe(true);
});

it('retries failed namespace registration instead of caching it as successful',async()=>{
 const {root,manager}=await setup();await mkdir(join(root,'cliproxy'),{recursive:true});
 await writeFile(join(root,'cliproxy','fixture-options.json'),JSON.stringify({failAliasWrites:1}));
 await writeFile(join(root,'cliproxy','fixture-accounts.json'),JSON.stringify([{name:'codex-saved.json',provider:'codex',status:'active',models:['gpt-6-astra']}]));
 await manager.start();expect(manager.snapshot().models).toEqual([]);
 await expect.poll(()=>manager.snapshot().models.map(m=>m.id),{timeout:5000}).toContain('codex/gpt-6-astra');
 expect(manager.snapshot().accountError).toBeUndefined();
});
