import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeAccounts } from '../packages/core/src/native-accounts.js';
import { ClaudeAccountStore, type CredentialStore } from '../packages/core/src/claude-accounts.js';
import { AntigravityAccountStore } from '../packages/core/src/antigravity-accounts.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const credential=(email='one@example.test')=>({email,access_token:`access-${email}`,refresh_token:`refresh-${email}`,expired:'2030-01-01T00:00:00Z',account_uuid:email,organization_uuid:'org'});
async function setup(keychain?:CredentialStore){
 const root=await mkdtemp(join(await realpath(tmpdir()),'native-accounts-'));roots.push(root);const dir=join(root,'claude');await mkdir(dir);
 const settings=join(dir,'settings.json');await writeFile(settings,JSON.stringify({model:'original',permissions:{allow:['Read']}}));
 const store=new ClaudeAccountStore(settings,keychain??null);let pids:number[]=[];
 const manager=new NativeAccounts(join(root,'backup.json'),store,async()=>pids);
 return {root,dir,settings,store,manager,running:(v:number[])=>{pids=v;}};
}
it('switches Claude accounts and models, restores original owned fields and keeps later preferences',async()=>{
 const {root,dir,settings,manager}=await setup();
 await writeFile(join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'old',refreshToken:'old-refresh'},other:{secret:'keep'}}));
 await writeFile(join(dir,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'original@example.test'},projects:{keep:true}}));
 for(const email of ['one@example.test','two@example.test'])await manager.switch({revision:(await manager.status()).revision,model:'claude/claude-sonnet-4-5'},credential(email));
 expect((await manager.status()).email).toBe('two@example.test');
 const prefs=JSON.parse(await readFile(settings,'utf8'));prefs.theme='dark';await writeFile(settings,JSON.stringify(prefs));
 await manager.restore({revision:(await manager.status()).revision});
 expect(JSON.parse(await readFile(settings,'utf8'))).toEqual({model:'original',permissions:{allow:['Read']},theme:'dark'});
 expect(JSON.parse(await readFile(join(dir,'.credentials.json'),'utf8'))).toEqual({claudeAiOauth:{accessToken:'old',refreshToken:'old-refresh'},other:{secret:'keep'}});
 expect((await manager.status()).email).toBe('original@example.test');expect((await manager.status()).backup).toBeNull();
 expect((await stat(join(root,'backup.json'))).mode&0o777).toBe(0o600);
});
it('writes and restores Claude keychain without losing other entries or stale fallback credentials',async()=>{
 const original=JSON.stringify({claudeAiOauth:{accessToken:'original'},other:{keep:1}});let raw:string|null=original;
 const keychain={read:async()=>raw,write:async(v:string|null)=>{raw=v;}};
 const {dir,manager}=await setup(keychain);await writeFile(join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fallback'},other:true}));
 await manager.switch({revision:(await manager.status()).revision,model:'claude/sonnet'},credential());
 expect(JSON.parse(raw!).claudeAiOauth.accessToken).toBe('access-one@example.test');expect(JSON.parse(raw!).other).toEqual({keep:1});
 expect(JSON.parse(await readFile(join(dir,'.credentials.json'),'utf8')).claudeAiOauth).toBeUndefined();
 await manager.restore({revision:(await manager.status()).revision});expect(JSON.parse(raw!)).toEqual(JSON.parse(original));
 expect(JSON.parse(await readFile(join(dir,'.credentials.json'),'utf8')).claudeAiOauth.accessToken).toBe('fallback');
});
it('keeps refreshed Claude credentials when selecting the current account',async()=>{
 const {dir,manager}=await setup();await manager.switch({revision:(await manager.status()).revision,model:'claude/sonnet'},credential());
 const path=join(dir,'.credentials.json'),current=JSON.parse(await readFile(path,'utf8'));current.claudeAiOauth.accessToken='refreshed';current.claudeAiOauth.refreshToken='rotated';await writeFile(path,JSON.stringify(current));
 await manager.switch({revision:(await manager.status()).revision,model:'claude/opus'},credential());expect(JSON.parse(await readFile(path,'utf8')).claudeAiOauth.refreshToken).toBe('rotated');
 await manager.restore({revision:(await manager.status()).revision});expect((await manager.status()).email).toBeNull();
});
it('rejects running processes, stale revisions, incomplete auth, routing overrides, and external identity changes',async()=>{
 const {dir,settings,manager,running}=await setup();const input={revision:(await manager.status()).revision,model:'claude/sonnet'};
 running([123]);await expect(manager.switch(input,credential())).rejects.toThrow('退出');running([]);
 await expect(manager.switch({...input,revision:'0'.repeat(64)},credential())).rejects.toThrow('变化');
 await expect(manager.switch(input,{access_token:'secret'})).rejects.toThrow('完整');
 await writeFile(settings,JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:'secret'}}));
 await expect(manager.switch({...input,revision:(await manager.status()).revision},credential())).rejects.toThrow('覆盖');
 await writeFile(settings,'{}');await manager.switch({...input,revision:(await manager.status()).revision},credential());
 await writeFile(join(dir,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:'external@example.test'}}));
 await expect(manager.restore({revision:(await manager.status()).revision})).rejects.toThrow('其他修改');
});
it('rolls back a failed Claude keychain write and does not expose the error payload',async()=>{
 let raw:string|null=null;const keychain={read:async()=>raw,write:async(v:string|null)=>{if(v)throw new Error('keychain locked');raw=v;}};
 const {settings,manager}=await setup(keychain);const original=await readFile(settings,'utf8');
 await expect(manager.switch({revision:(await manager.status()).revision,model:'claude/sonnet'},credential())).rejects.toThrow('locked');
 expect(await readFile(settings,'utf8')).toBe(original);expect((await manager.status()).backup).toBeNull();
});
async function antigravity(){
 const root=await mkdtemp(join(await realpath(tmpdir()),'ag-accounts-'));roots.push(root);const path=join(root,'state.vscdb');
 const db=new DatabaseSync(path);db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value TEXT)');db.prepare('INSERT INTO ItemTable VALUES (?,?)').run('history','keep history');db.close();
 let pids:number[]=[];const store=new AntigravityAccountStore(path),manager=new NativeAccounts(join(root,'backup.json'),store,async()=>pids);
 return {root,path,store,manager,running:(v:number[])=>{pids=v;}};
}
it('switches Antigravity in a transaction and restores login without changing history or other topic rows',async()=>{
 const {path,store,manager}=await antigravity(),original=await store.read();
 await manager.switch({revision:(await manager.status()).revision},credential());expect((await manager.status()).email).toBe('one@example.test');
 // Independent protobuf fixture: Topic.data["other"].value = "keep", retained during further switches/restores.
 const other=Buffer.from([10,15,10,5,...Buffer.from('other'),18,6,10,4,...Buffer.from('keep')]);
 const db=new DatabaseSync(path),key='antigravityUnifiedStateSync.oauthToken';const value=db.prepare('SELECT value FROM ItemTable WHERE key=?').get(key)!.value as string;
 db.prepare('UPDATE ItemTable SET value=? WHERE key=?').run(Buffer.concat([Buffer.from(value,'base64'),other]).toString('base64'),key);db.close();
 await manager.switch({revision:(await manager.status()).revision},credential('two@example.test'));expect((await manager.status()).email).toBe('two@example.test');
 await manager.restore({revision:(await manager.status()).revision});expect(await store.read()).toEqual(original);
 const restored=new DatabaseSync(path);expect(restored.prepare('SELECT value FROM ItemTable WHERE key=?').get('history')!.value).toBe('keep history');expect(restored.prepare('SELECT value FROM ItemTable WHERE key=?').get(key)!.value).toBe(other.toString('base64'));restored.close();
});
it('rejects Antigravity running, unsupported protobuf, symlinks, and rolls back partial SQLite failures',async()=>{
 const {root,path,manager,running}=await antigravity();running([22]);await expect(manager.switch({revision:(await manager.status()).revision},credential())).rejects.toThrow('退出');running([]);
 const db=new DatabaseSync(path);db.exec("CREATE TRIGGER fail_user BEFORE INSERT ON ItemTable WHEN NEW.key = 'antigravityUnifiedStateSync.userStatus' BEGIN SELECT RAISE(ABORT, 'fixture fail'); END");
 const original=(await manager.status()).revision;await expect(manager.switch({revision:original},credential())).rejects.toThrow();expect((await manager.status()).revision).toBe(original);expect((await manager.status()).backup).toBeNull();
 db.exec('DROP TRIGGER fail_user');db.prepare('INSERT INTO ItemTable VALUES (?,?)').run('antigravityUnifiedStateSync.oauthToken','invalid!');db.close();await expect(manager.status()).rejects.toThrow('无效');
 const link=join(root,'link');await symlink(path,link);await expect(new AntigravityAccountStore(link).read()).rejects.toThrow('符号链接');
});

it('recovers a prepared Claude switch after only credentials were written',async()=>{
 const {root,dir,store,manager}=await setup();
 const before=await store.read(),after=store.prepare(before,credential(),'claude/sonnet');
 await writeFile(join(root,'backup.json'),JSON.stringify({before,after,state:'prepared',createdAt:new Date().toISOString()}));
 await writeFile(join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:JSON.parse(after.fileAuth!)}));
 expect((await manager.status()).backup?.state).toBe('prepared');
 await manager.restore({revision:(await manager.status()).revision});expect(await store.read()).toEqual(before);expect((await manager.status()).backup).toBeNull();
});
