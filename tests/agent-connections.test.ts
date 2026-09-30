import { afterEach,expect,it } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { AgentConnections,connectedConfig } from '../packages/core/src/agent-connections.js';
import { agentConfig } from '../apps/console/src/agent-config.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){const root=await mkdtemp(join(await realpath(tmpdir()),'agent-connect-test-'));roots.push(root);const paths={qoder:join(root,'qoder/settings.json'),codex:join(root,'codex','config.toml'),claude:join(root,'claude','settings.json'),workbuddy:join(root,'workbuddy','models.json')};let pids:number[]=[];const connections=new AgentConnections(root,paths,async()=>pids);await mkdir(join(root,'codex'));await mkdir(join(root,'claude'));return {root,paths,connections,running:(next:number[])=>pids=next};}
it('backs up exact original config, preserves providers and unrelated settings, restores and recovers across reopen',async()=>{
 const {root,paths,connections}=await setup();const original='# original comment\nmodel = "old"\nprofile = "work"\n[profiles.work]\nmodel = "profile-old"\n[model_providers.original]\nbase_url = "https://example.test"\n';await writeFile(paths.codex,original);
 const status=(await connections.status())[0];const record=await connections.apply({target:'codex',revision:status.revision,origin:'http://127.0.0.1:9527',model:'codex/model',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
 const text=await readFile(paths.codex,'utf8');const parsed=parse(text);expect(parsed.profile).toBe('work');expect(parsed.model_provider).toBe('token_flow');expect(parsed.model_providers).toHaveProperty('original');expect(parsed.profiles).toHaveProperty('work.model','codex/model');
 expect((await stat(paths.codex)).mode&0o777).toBe(0o600);expect(JSON.stringify(await connections.status())).not.toContain('fixture-key');
 await new AgentConnections(root,paths,async()=>[]).restore(record.id);expect(await readFile(paths.codex,'utf8')).toBe(original);
});

it('preserves Codex local policy and active legacy profile through model switches, reviews and rollback',async()=>{
 const {paths,connections}=await setup();
 const original=`model = "old"
profile = "work"
approval_policy = "untrusted"
sandbox_mode = "read-only"
[profiles.work]
model = "profile-model"
model_provider = "original"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = "live"
[profiles.other]
model = "untouched"
approval_policy = "never"
[sandbox_workspace_write]
network_access = false
writable_roots = ["/tmp/allowed-fixture"]
[shell_environment_policy]
inherit = "none"
[mcp_servers.fixture]
command = "fixture-mcp"
[projects."/tmp/project-fixture"]
trust_level = "untrusted"
`;
 await writeFile(paths.codex,original);
 const before=parse(original);
 for(const model of ['qoder/test','workbuddy/test','codex/test']){
  const preview=await connections.preview('codex','http://127.0.0.1:9527',model);
  expect(preview.routing).toMatchObject({profile:'work',model,model_provider:'token_flow',web_search:model==='codex/test'?'live':'disabled'});
  const record=await connections.apply({target:'codex',revision:preview.revision,replaceId:preview.replaceId,origin:'http://127.0.0.1:9527',model,sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
  const after=parse(await readFile(paths.codex,'utf8'));
  expect(after).toMatchObject({profile:'work',approval_policy:'untrusted',sandbox_mode:'read-only',profiles:{work:{model,model_provider:'token_flow',approval_policy:'on-request',sandbox_mode:'workspace-write',web_search:model==='codex/test'?'live':'disabled'},other:{model:'untouched',approval_policy:'never'}}});
  for(const field of ['sandbox_workspace_write','shell_environment_policy','mcp_servers','projects'])expect(after[field]).toEqual(before[field]);
  expect((await connections.review(record.id)).checks.every(c=>c.ok)).toBe(true);
 }
 const record=(await connections.status())[0].connection!;
 const modified=parse(await readFile(paths.codex,'utf8')) as any;
 modified.profiles.work.model='wrong-model';
 const {stringify}=await import('smol-toml');await writeFile(paths.codex,stringify(modified));
 expect((await connections.review(record.id)).checks.find(c=>c.name==='模型与配置层级正确')?.ok).toBe(false);
 await writeFile(paths.codex,connectedConfig('codex',original,'http://127.0.0.1:9527','codex/test','fixture-key'));
 await connections.restore(record.id);expect(await readFile(paths.codex,'utf8')).toBe(original);
});

it('rejects invalid active legacy profiles instead of silently dropping their policy',()=>{
 for(const original of ['profile = "missing"','profile = false','profile = "work"\nprofiles.work = "invalid"']){
  expect(()=>connectedConfig('codex',original,'http://127.0.0.1:9527','codex/test','key')).toThrow();
 }
});

it('keeps local Claude and Qoder tool, hook and approval settings when adding a model provider',()=>{
 const local={permissions:{defaultMode:'default',allow:['Read'],deny:['Bash(rm *)'],ask:['Bash'],additionalDirectories:['/tmp/fixture']},sandbox:{enabled:true},hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'fixture-check'}]}]},mcpServers:{fixture:{command:'fixture-mcp'}}};
 for(const target of ['claude','qoder'] as const){
  const config=JSON.parse(connectedConfig(target,JSON.stringify(local),'http://127.0.0.1:9527','workbuddy/test','key'));
  for(const [name,value] of Object.entries(local))expect(config[name]).toEqual(value);
 }
 for(const target of ['codex','claude'] as const){
  for(const powershell of [false,true])expect(agentConfig(target,'http://127.0.0.1:9527','workbuddy/test',powershell)).not.toMatch(/approval_policy|sandbox_mode|permission-mode|skip-permissions|allowedTools/);
 }
});

it('configures supported Codex tools by source and restores search when switching back',async()=>{
 const {paths,connections}=await setup();const original='web_search = "live"\napproval_policy = "on-request"\n';await writeFile(paths.codex,original);
 for(const model of ['qoder/kmodel_latest','workbuddy/glm-5.1','codex/model']){
  const preview=await connections.preview('codex','http://127.0.0.1:9527',model);
  const expected=model.startsWith('codex/')?'live':'disabled';expect(preview.routing.web_search).toBe(expected);
  await connections.apply({target:'codex',revision:preview.revision,replaceId:preview.replaceId,origin:'http://127.0.0.1:9527',model,sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
  expect(parse(await readFile(paths.codex,'utf8'))).toMatchObject({web_search:expected,approval_policy:'on-request'});
  const manual=agentConfig('codex','http://127.0.0.1:9527',model);
  expect(manual.includes('web_search="disabled"')).toBe(expected==='disabled');
 }
 const record=(await connections.status())[0].connection!;await connections.restore(record.id);expect(await readFile(paths.codex,'utf8')).toBe(original);
});
it('refuses live processes, stale previews, external modifications, duplicate apply and symlinks',async()=>{
 const {paths,connections,running}=await setup();await writeFile(paths.claude,'{"env":{"KEEP":"yes"},"permissions":{"allow":[]}}');
 const selected=(await connections.status())[1];const input={target:'claude' as const,revision:selected.revision,origin:'http://127.0.0.1:9527',model:'codex/model',sourceId:'source',keyId:randomUUID(),key:'fixture-key'};
 running([42]);await expect(connections.apply(input)).rejects.toThrow('42');running([]);
 const record=await connections.apply(input);const updated=JSON.parse(await readFile(paths.claude,'utf8'));expect(updated.env.KEEP).toBe('yes');expect(updated.permissions).toEqual({allow:[]});
 await expect(connections.apply(input)).rejects.toThrow('配置已变更');
 await writeFile(paths.claude,'{"user":"new edit"}');await expect(connections.restore(record.id)).rejects.toThrow('外部修改');expect(await readFile(paths.claude,'utf8')).toContain('new edit');
 await symlink(paths.claude,paths.codex);await expect(connections.apply({...input,target:'codex'})).rejects.toThrow('符号链接');
});
it('restores an originally absent file and fails closed on malformed configuration',async()=>{
 const {paths,connections}=await setup();const status=(await connections.status())[1];const record=await connections.apply({target:'claude',revision:status.revision,origin:'http://127.0.0.1:9527',model:'m',sourceId:'s',keyId:randomUUID(),key:'key'});await connections.restore(record.id);await expect(readFile(paths.claude)).rejects.toMatchObject({code:'ENOENT'});
 expect(()=>connectedConfig('codex','invalid ???','http://127.0.0.1:9527','m','k')).toThrow();expect(()=>connectedConfig('claude','[]','http://127.0.0.1:9527','m','k')).toThrow();
});

it('recovers a prepared backup without overwriting changed files or losing rollback',async()=>{
 const {root,paths,connections}=await setup();const original='{"original":true}';await writeFile(paths.claude,original);
 const state=(await connections.status())[1];const record=await connections.apply({target:'claude',revision:state.revision,origin:'http://127.0.0.1:9527',model:'m',sourceId:'s',keyId:randomUUID(),key:'k'});
 const backup=join(root,'agent-backups',`${record.id}.json`);const journal=JSON.parse(await readFile(backup,'utf8'));journal.state='prepared';await writeFile(backup,JSON.stringify(journal));await writeFile(paths.claude,original);
 await connections.repair(record.id);expect(await readFile(paths.claude,'utf8')).toBe(journal.after);await connections.restore(record.id);expect(await readFile(paths.claude,'utf8')).toBe(original);
 journal.before='tampered';await writeFile(backup,JSON.stringify(journal));await expect(connections.status()).rejects.toThrow('备份记录损坏');
});

it('allows confirmed settings writes while agent runs, with backup and conflict checks intact',async()=>{
 const {paths,connections,running}=await setup();await writeFile(paths.claude,'{"original":true}');const status=(await connections.status())[1];running([42]);
 const record=await connections.apply({target:'claude',revision:status.revision,origin:'http://127.0.0.1:9527',model:'m',sourceId:'s',keyId:randomUUID(),key:'k',allowRunning:true});expect(JSON.parse(await readFile(paths.claude,'utf8')).model).toBe('m');expect(record.state).toBe('applied');running([]);await connections.restore(record.id);expect(await readFile(paths.claude,'utf8')).toBe('{"original":true}');
});

it('generates Qoder IDE parameters and pins Claude auxiliary models in both connection paths',()=>{
 const qoder=JSON.parse(agentConfig('qoder','http://127.0.0.1:9527','antigravity/gemini'));expect(qoder).toMatchObject({provider:'OpenAI Compatible',api:'Responses',baseURL:'http://127.0.0.1:9527/v1',model:'antigravity/gemini'});
 const original=JSON.stringify({env:{ANTHROPIC_SMALL_FAST_MODEL:'old',CLAUDE_CODE_SUBAGENT_MODEL:'old-sub',KEEP:'yes'}});const config=JSON.parse(connectedConfig('claude',original,'http://127.0.0.1:9527','antigravity/gemini','key'));
 for(const name of ['ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_SUBAGENT_MODEL']){expect(config.env[name]).toBe('antigravity/gemini');expect(agentConfig('claude','http://127.0.0.1:9527','antigravity/gemini')).toContain(`${name}='antigravity/gemini'`);}
 expect(config.env.KEEP).toBe('yes');
});

it('reviews actual Claude routing without exposing keys and detects stale auxiliary settings',async()=>{
 const {paths,connections}=await setup();const status=(await connections.status())[1];const record=await connections.apply({target:'claude',revision:status.revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'s',keyId:randomUUID(),key:'private-key'});const valid=await connections.review(record.id);expect(valid.checks.every(c=>c.ok)).toBe(true);expect(valid.liveCallVerified).toBe(false);expect(valid.compatibility?.autoMode).toBe('unverified');expect(JSON.stringify(valid)).not.toContain('private-key');
 const config=JSON.parse(await readFile(paths.claude,'utf8'));config.env.ANTHROPIC_SMALL_FAST_MODEL='stale';await writeFile(paths.claude,JSON.stringify(config));const drift=await connections.review(record.id);expect(drift.checks.find(c=>c.name==='主模型与辅助模型一致')?.ok).toBe(false);expect(drift.checks.find(c=>c.name==='配置与接入备份一致')?.ok).toBe(false);
});

it('refuses lossy WorkBuddy object conversion and reviews native arrays',async()=>{
 expect(()=>connectedConfig('workbuddy','{"models":[],"availableModels":[]}','http://127.0.0.1:9527','qoder/test','fixture-key')).toThrow('额外设置');
 const {paths,connections}=await setup();const status=(await connections.status())[2];const record=await connections.apply({target:'workbuddy',revision:status.revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const saved=JSON.parse(await readFile(paths.workbuddy,'utf8'));await writeFile(paths.workbuddy,JSON.stringify(Array.isArray(saved)?saved:saved.models));const review=await connections.review(record.id);expect(review.checks.find(c=>c.name==='自定义模型已写入配置')?.ok).toBe(true);expect(review.checks.find(c=>c.name==='接口地址与工具能力正确')?.ok).toBe(true);expect(review.liveCallVerified).toBe(false);expect(review.note).toContain('输入框下方');
});

it('keeps native WorkBuddy models through its array-only startup cleanup',()=>{
 for(const original of [null,'[]','{"models":[]}']){
  const config=JSON.parse(connectedConfig('workbuddy',original,'http://127.0.0.1:9527','qoder/k3','key'));
  // Installed WorkBuddy hardware-gate cleanup only retains root-array remote models.
  const retained=(Array.isArray(config)?config:[]).filter(m=>m?.local!==true);
  expect(retained).toHaveLength(1);expect(retained[0].id).toBe('qoder/k3');
 }
});
it('switches a missing WorkBuddy connection to the selected source while preserving original rollback',async()=>{
 const {paths,connections}=await setup();await mkdir(join(paths.workbuddy,'..'),{recursive:true});await writeFile(paths.workbuddy,'[]');
 const initial=(await connections.status())[2];const old=await connections.apply({target:'workbuddy',revision:initial.revision,origin:'http://127.0.0.1:9527',model:'antigravity/old',sourceId:'old',keyId:randomUUID(),key:'old-key'});
 await writeFile(paths.workbuddy,'[]');expect((await connections.status())[2].configurationState).toBe('missing');
 const preview=await connections.preview('workbuddy','http://127.0.0.1:9527','qoder/k3');expect(preview.replaceId).toBe(old.id);expect(JSON.stringify(preview)).not.toContain('old-key');
 const next=await connections.apply({target:'workbuddy',revision:preview.revision,replaceId:old.id,origin:'http://127.0.0.1:9527',model:'qoder/k3',sourceId:'qoder',keyId:randomUUID(),key:'new-key'});
 expect(JSON.parse(await readFile(paths.workbuddy,'utf8'))[0].id).toBe('qoder/k3');expect((await connections.status())[2].configurationState).toBe('configured');expect((await connections.review(next.id)).checks.every(c=>c.ok)).toBe(true);
 await connections.restore(next.id);expect(await readFile(paths.workbuddy,'utf8')).toBe('[]');expect((await connections.status())[2].backups.every(r=>r.state==='restored')).toBe(true);
});
it('redacts unrelated provider secrets from approval previews and refuses changed revisions',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.claude,JSON.stringify({env:{ANTHROPIC_CUSTOM_SECRET:'private-secret'}}));const p=await connections.preview('claude','http://127.0.0.1:9527','qoder/k3');expect(JSON.stringify(p)).not.toContain('private-secret');await writeFile(paths.claude,'{"new":true}');
 await expect(connections.apply({target:'claude',revision:p.revision,origin:'http://127.0.0.1:9527',model:'qoder/k3',sourceId:'s',keyId:randomUUID(),key:'key'})).rejects.toThrow();expect(await readFile(paths.claude,'utf8')).toBe('{"new":true}');
});
it('recovers interrupted replacement journals and verifies replacement backup checksums',async()=>{
 const {root,paths,connections}=await setup();await writeFile(paths.claude,'{}');const initial=(await connections.status())[1];const old=await connections.apply({target:'claude',revision:initial.revision,origin:'http://127.0.0.1:9527',model:'old/m',sourceId:'old',keyId:randomUUID(),key:'old-key'});const before=await readFile(paths.claude,'utf8');const preview=await connections.preview('claude','http://127.0.0.1:9527','new/m');
 const next=await connections.apply({target:'claude',revision:preview.revision,replaceId:old.id,origin:'http://127.0.0.1:9527',model:'new/m',sourceId:'new',keyId:randomUUID(),key:'new-key'});const path=join(root,'agent-backups',`${next.id}.json`);const journal=JSON.parse(await readFile(path,'utf8'));journal.state='prepared';await writeFile(path,JSON.stringify(journal));await writeFile(paths.claude,before);
 await connections.repair(next.id);expect(JSON.parse(await readFile(paths.claude,'utf8')).model).toBe('new/m');await connections.restore(next.id);expect(await readFile(paths.claude,'utf8')).toBe('{}');journal.previousConfig='corrupt';await writeFile(path,JSON.stringify(journal));await expect(connections.status()).rejects.toThrow('备份记录损坏');
});
it('recognizes WorkBuddy formatting rewrites and can replace the selected model',async()=>{
 const {root,paths,connections}=await setup();await mkdir(join(root,'workbuddy'));await writeFile(paths.workbuddy,'[]');
 const first=await connections.apply({target:'workbuddy',revision:(await connections.status())[2].revision,origin:'http://127.0.0.1:9527',model:'qoder/old',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 await writeFile(paths.workbuddy,JSON.stringify(JSON.parse(await readFile(paths.workbuddy,'utf8'))));
 expect((await connections.status())[2].configurationState).toBe('configured');expect((await connections.review(first.id)).checks.every(c=>c.ok)).toBe(true);
 const preview=await connections.preview('workbuddy','http://127.0.0.1:9527','qoder/new');
 const second=await connections.apply({target:'workbuddy',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'qoder/new',sourceId:'s',keyId:randomUUID(),key:'next-key'});
 await writeFile(paths.workbuddy,JSON.stringify(JSON.parse(await readFile(paths.workbuddy,'utf8'))));await connections.restore(second.id);expect(await readFile(paths.workbuddy,'utf8')).toBe('[]');
});

it('adds, switches and restores Qoder standalone providers while preserving unrelated settings',async()=>{
 const {paths,connections}=await setup();await mkdir(join(paths.qoder,'..'),{recursive:true});
 const original=JSON.stringify({hooks:{keep:true},providers:{existing:{apiKey:'original-key',baseUrl:'https://example.test'}}});await writeFile(paths.qoder,original);
 const first=await connections.apply({target:'qoder',revision:(await connections.status()).find(t=>t.id==='qoder')!.revision,origin:'http://127.0.0.1:9527',model:'codex/first',sourceId:'source',keyId:randomUUID(),key:'first-key'});
 expect((await connections.review(first.id)).checks.every(c=>c.ok)).toBe(true);
 const preview=await connections.preview('qoder','http://127.0.0.1:9527','codex/second');expect(JSON.stringify(preview)).not.toContain('original-key');expect(JSON.stringify(preview)).not.toContain('first-key');
 const next=await connections.apply({target:'qoder',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'codex/second',sourceId:'source',keyId:randomUUID(),key:'second-key'});
 const doc=JSON.parse(await readFile(paths.qoder,'utf8'));expect(doc.hooks).toEqual({keep:true});expect(doc.providers.existing.apiKey).toBe('original-key');expect(doc.providers['token-flow']).toMatchObject({protocol:'openai-responses',baseUrl:'http://127.0.0.1:9527/v1',model:'codex/second',apiKey:'second-key'});
 await connections.restore(next.id);expect(await readFile(paths.qoder,'utf8')).toBe(original);
 expect(()=>connectedConfig('qoder','{"providers":{"token-flow":{}}}','http://127.0.0.1:9527','codex/model','key')).toThrow();
});

it('restores and switches Codex routing while preserving unrelated client edits',async()=>{
 const {paths,connections}=await setup();await writeFile(paths.codex,'model = "original"\n');
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'antigravity/old',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 await writeFile(paths.codex,'approval_policy = "on-request"\n'+await readFile(paths.codex,'utf8'));
 const preview=await connections.preview('codex','http://127.0.0.1:9527','workbuddy/new');
 const next=await connections.apply({target:'codex',revision:preview.revision,replaceId:first.id,origin:'http://127.0.0.1:9527',model:'workbuddy/new',sourceId:'s',keyId:randomUUID(),key:'next-key'});
 await connections.remove(first.id,(await connections.status())[0].revision);expect((await connections.status())[0].connection?.id).toBe(next.id);
 await writeFile(paths.codex,'sandbox_mode = "workspace-write"\n'+await readFile(paths.codex,'utf8'));
 await connections.restore(next.id);expect(parse(await readFile(paths.codex,'utf8'))).toEqual({model:'original',approval_policy:'on-request',sandbox_mode:'workspace-write'});
});
it('deletes stale records after reinstall without touching the new config, and keeps history selectable',async()=>{
 const {root,paths,connections}=await setup();await writeFile(paths.codex,'model = "original"\n');
 const first=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'antigravity/old',sourceId:'s',keyId:randomUUID(),key:'first-key'});
 const original=await readFile(paths.codex,'utf8');await connections.restore(first.id);expect((await connections.status())[0].backups).toHaveLength(1);
 const next=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'workbuddy/new',sourceId:'s',keyId:randomUUID(),key:'next-key'});
 await writeFile(paths.codex,'model = "reinstalled"\n');
 await expect(connections.restore(next.id)).rejects.toThrow('外部修改');
 await expect(connections.remove(next.id,'0'.repeat(64))).rejects.toThrow('配置已变更');
 await connections.remove(next.id,(await connections.status())[0].revision);
 const reopened=new AgentConnections(root,paths,async()=>[]);const status=(await reopened.status())[0];expect(status.connection).toBeNull();expect(status.backups.map(r=>r.id)).toEqual([first.id]);expect(await readFile(paths.codex,'utf8')).toBe('model = "reinstalled"\n');
 await reopened.remove(first.id,status.revision);expect((await reopened.status())[0].backups).toEqual([]);expect(original).toContain('first-key');
});
it('restores a missing file without requiring a maintenance model',async()=>{
 const {paths,connections}=await setup();
 const record=await connections.apply({target:'codex',revision:(await connections.status())[0].revision,origin:'http://127.0.0.1:9527',model:'antigravity/m',sourceId:'s',keyId:randomUUID(),key:'key'});
 await rm(paths.codex);await connections.restore(record.id);expect((await connections.status())[0].connection).toBeNull();
});

it('requires a public HTTPS endpoint for manual Cursor setup and never invents a writable settings file',()=>{
 for(const url of ['http://127.0.0.1:9527','https://localhost','https://10.0.0.1','https://192.168.1.2','https://gateway.example.com/v1','https://user:password@gateway.example.com'])expect(()=>agentConfig('cursor',url,'antigravity/gemini-3-flash')).toThrow();
 expect(JSON.parse(agentConfig('cursor','https://gateway.example.com','antigravity/gemini-3-flash'))).toMatchObject({overrideOpenAIBaseURL:'https://gateway.example.com/v1',customModel:'antigravity/gemini-3-flash'});
});
