import { afterEach,expect,it } from 'vitest';
import { mkdtemp,mkdir,readFile,writeFile,rm,realpath,stat,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { CodexAccounts } from '../packages/core/src/codex-accounts.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const oauth=(id:string)=>({account_id:id,access_token:`secret-access-${id}`,refresh_token:`secret-refresh-${id}`,id_token:`x.${Buffer.from(JSON.stringify({email:`${id}@example.test`})).toString('base64url')}.x`});
async function setup(){const root=await mkdtemp(join(await realpath(tmpdir()),'codex-switch-'));roots.push(root);await mkdir(join(root,'codex'));const config=join(root,'codex/config.toml'),auth=join(root,'codex/auth.json');let pids:number[]=[];return {root,config,auth,manager:new CodexAccounts(root,config,async()=>pids),running:(value:number[])=>pids=value};}
it('switches two accounts and default models, retains original backup and restores after restart',async()=>{
 const {root,config,auth,manager}=await setup();const original='cli_auth_credentials_store = "keyring"\nmodel = "original"\nprofile = "work"\n[profiles.work]\nmodel = "profile-model"\n';await writeFile(config,original);await writeFile(auth,'{"original":"secret-native"}');
 expect((await manager.status()).email).toBeNull();
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-sol'},oauth('a'));
 expect(parse(await readFile(config,'utf8'))).toMatchObject({model:'gpt-6-sol',model_provider:'openai',cli_auth_credentials_store:'file',profiles:{work:{model:'profile-model'}}});expect(parse(await readFile(config,'utf8')).profile).toBeUndefined();
 expect((await manager.status()).email).toBe('a@example.test');
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-astra'},oauth('b'));
 expect(JSON.parse(await readFile(auth,'utf8')).tokens.account_id).toBe('b');
 expect(JSON.stringify(await manager.status())).not.toMatch(/secret-|refresh_token|access_token/);
 for(const path of [auth,config,join(root,'codex-account-backup.json')])expect((await stat(path)).mode&0o777).toBe(0o600);
 const restarted=new CodexAccounts(root,config,async()=>[]);await restarted.restore({revision:(await restarted.status()).revision,allowRunning:false});expect(await readFile(config,'utf8')).toBe(original);expect(await readFile(auth,'utf8')).toBe('{"original":"secret-native"}');expect((await restarted.status()).backup).toBeNull();
});
it('rejects stale previews, running processes, invalid credentials and external edits',async()=>{
 const {manager,config,auth,running}=await setup();const input={revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-sol'};
 running([42]);await expect(manager.switch(input,oauth('a'))).rejects.toThrow('仍在运行');running([]);
 await expect(manager.switch(input,{...oauth('a'),refresh_token:''})).rejects.toThrow('完整 OAuth');
 await writeFile(config,'model = "external"');await expect(manager.switch(input,oauth('a'))).rejects.toThrow('已变化');
 await manager.switch({...input,revision:(await manager.status()).revision},oauth('a'));
 await writeFile(auth,JSON.stringify({tokens:oauth('external')}));await expect(manager.restore({revision:(await manager.status()).revision,allowRunning:false})).rejects.toThrow('其他修改');
});
it('restores missing original files and allows explicit running-process confirmation',async()=>{
 const {manager,config,auth,running}=await setup();running([42]);await manager.switch({revision:(await manager.status()).revision,allowRunning:true,model:'codex/gpt-6-sol'},oauth('a'));
 await manager.restore({revision:(await manager.status()).revision,allowRunning:true});await expect(readFile(config)).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(auth)).rejects.toMatchObject({code:'ENOENT'});
});
it('does not follow symlinked credentials',async()=>{
 const {root,manager,auth}=await setup();await writeFile(join(root,'other'),'private');await symlink(join(root,'other'),auth);await expect(manager.status()).rejects.toThrow('符号链接');expect(await readFile(join(root,'other'),'utf8')).toBe('private');
});
it('recovers an interrupted two-file switch and preserves refreshed native tokens',async()=>{
 const {root,manager,config,auth}=await setup();await writeFile(config,'model = "original"\n');
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-sol'},oauth('a'));
 const refreshed={...oauth('a'),access_token:'refreshed-access',refresh_token:'refreshed-refresh'};await writeFile(auth,JSON.stringify({tokens:refreshed}));
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-astra'},oauth('a'));
 expect(JSON.parse(await readFile(auth,'utf8')).tokens.refresh_token).toBe('refreshed-refresh');
 const path=join(root,'codex-account-backup.json');const journal=JSON.parse(await readFile(path,'utf8'));journal.state='prepared';await writeFile(path,JSON.stringify(journal));await writeFile(config,journal.before.config);
 await expect(manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-sol'},oauth('b'))).rejects.toThrow('尚未完成');
 await manager.restore({revision:(await manager.status()).revision,allowRunning:false});expect(await readFile(config,'utf8')).toBe('model = "original"\n');await expect(readFile(auth)).rejects.toMatchObject({code:'ENOENT'});
});
it('switches back after Codex changes its model and settings without losing those settings',async()=>{
 const {manager,config,auth}=await setup();await writeFile(config,'model = "original"\n');
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-sol'},oauth('a'));
 await writeFile(config,(await readFile(config,'utf8')).replace('gpt-6-sol','gpt-5.6-sol')+'\nmodel_reasoning_effort = "high"\n');
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-astra'},oauth('b'));
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-sol'},oauth('a'));
 expect(JSON.parse(await readFile(auth,'utf8')).tokens.account_id).toBe('a');expect(parse(await readFile(config,'utf8')).model_reasoning_effort).toBe('high');
 await manager.restore({revision:(await manager.status()).revision,allowRunning:false});expect(parse(await readFile(config,'utf8'))).toMatchObject({model:'original',model_reasoning_effort:'high'});
});
it('accepts formatting-only rewrites but blocks another provider and preserves original backup',async()=>{
 const {manager,config}=await setup();await writeFile(config,'model = "original"\n');
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-sol'},oauth('a'));
 await writeFile(config,'# rewritten by Codex\n'+(await readFile(config,'utf8')).replaceAll(' = ','='));
 await manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-astra'},oauth('b'));
 const native=await readFile(config,'utf8');await writeFile(config,native.replace('model_provider = "openai"','model_provider = "another"'));
 await expect(manager.switch({revision:(await manager.status()).revision,allowRunning:false,model:'codex/gpt-6-sol'},oauth('a'))).rejects.toThrow('已被修改');
 await expect(manager.restore({revision:(await manager.status()).revision,allowRunning:false})).rejects.toThrow('其他修改');
 await writeFile(config,'# another format rewrite\n'+native);await manager.restore({revision:(await manager.status()).revision,allowRunning:false});expect(await readFile(config,'utf8')).toBe('model = "original"\n');
});
