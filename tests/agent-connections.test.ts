import { afterEach,expect,it } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { AgentConnections,connectedConfig } from '../packages/core/src/agent-connections.js';
import { agentConfig } from '../apps/console/src/agent-config.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){const root=await mkdtemp(join(await realpath(tmpdir()),'agent-connect-test-'));roots.push(root);const paths={codex:join(root,'codex','config.toml'),claude:join(root,'claude','settings.json'),workbuddy:join(root,'workbuddy','models.json')};let pids:number[]=[];const connections=new AgentConnections(root,paths,async()=>pids);await mkdir(join(root,'codex'));await mkdir(join(root,'claude'));return {root,paths,connections,running:(next:number[])=>pids=next};}
it('backs up exact original config, preserves providers and unrelated settings, restores and recovers across reopen',async()=>{
 const {root,paths,connections}=await setup();const original='# original comment\nmodel = "old"\nprofile = "work"\n[profiles.work]\nmodel = "profile-old"\n[model_providers.original]\nbase_url = "https://example.test"\n';await writeFile(paths.codex,original);
 const status=(await connections.status())[0];const record=await connections.apply({target:'codex',revision:status.revision,origin:'http://127.0.0.1:9527',model:'codex/model',sourceId:'source',keyId:randomUUID(),key:'fixture-key'});
 const text=await readFile(paths.codex,'utf8');const parsed=parse(text);expect(parsed.profile).toBeUndefined();expect(parsed.model_provider).toBe('token_flowb');expect(parsed.model_providers).toHaveProperty('original');expect(parsed.profiles).toHaveProperty('work');
 expect((await stat(paths.codex)).mode&0o777).toBe(0o600);expect(JSON.stringify(await connections.status())).not.toContain('fixture-key');
 await new AgentConnections(root,paths,async()=>[]).restore(record.id);expect(await readFile(paths.codex,'utf8')).toBe(original);
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
 const {paths,connections}=await setup();const status=(await connections.status())[1];const record=await connections.apply({target:'claude',revision:status.revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'s',keyId:randomUUID(),key:'private-key'});const valid=await connections.review(record.id);expect(valid.checks.every(c=>c.ok)).toBe(true);expect(valid.liveCallVerified).toBe(false);expect(JSON.stringify(valid)).not.toContain('private-key');
 const config=JSON.parse(await readFile(paths.claude,'utf8'));config.env.ANTHROPIC_SMALL_FAST_MODEL='stale';await writeFile(paths.claude,JSON.stringify(config));const drift=await connections.review(record.id);expect(drift.checks.find(c=>c.name==='主模型与辅助模型一致')?.ok).toBe(false);expect(drift.checks.find(c=>c.name==='配置与接入备份一致')?.ok).toBe(false);
});

it('keeps WorkBuddy empty availableModels unrestricted and reviews models rewritten as an array',async()=>{
 const config=JSON.parse(connectedConfig('workbuddy','{"models":[],"availableModels":[]}','http://127.0.0.1:9527','qoder/test','fixture-key'));expect(config.availableModels).toEqual([]);
 const {paths,connections}=await setup();const status=(await connections.status())[2];const record=await connections.apply({target:'workbuddy',revision:status.revision,origin:'http://127.0.0.1:9527',model:'qoder/test',sourceId:'s',keyId:randomUUID(),key:'fixture-key'});
 const saved=JSON.parse(await readFile(paths.workbuddy,'utf8'));await writeFile(paths.workbuddy,JSON.stringify(saved.models));const review=await connections.review(record.id);expect(review.checks.find(c=>c.name==='自定义模型已写入配置')?.ok).toBe(true);expect(review.checks.find(c=>c.name==='接口地址与工具能力正确')?.ok).toBe(true);expect(review.liveCallVerified).toBe(false);expect(review.note).toContain('输入框下方');
});
