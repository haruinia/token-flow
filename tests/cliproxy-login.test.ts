import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
  snapshot=manager.snapshot();expect(snapshot.accounts[0].label).toBe('user@example.test');expect(snapshot.models[0].id).toBe('fixture-codex-model');
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
  const headers={host:'127.0.0.1:4317',authorization:'Bearer desktop-token'};
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
