import { mkdir, writeFile, rename, unlink, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { agentProcesses, readConfig, safePath } from './agent-connections.js';

const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const token=z.string().min(1).max(20000);
const credential=z.object({access_token:token,refresh_token:token,id_token:token,account_id:z.string().min(1),last_refresh:z.string().optional()});
const journalSchema=z.object({before:z.object({auth:z.string().nullable(),config:z.string().nullable()}),after:z.object({auth:z.string(),config:z.string()}),accountId:z.string(),createdAt:z.string(),state:z.enum(['prepared','applied','restored'])});
type Journal=z.infer<typeof journalSchema>;
function identity(auth:string|null){try{const value=JSON.parse(auth??'{}');return typeof value.tokens?.account_id==='string'?value.tokens.account_id:null;}catch{return null;}}
function email(auth:string|null){try{const token=JSON.parse(auth??'{}').tokens.id_token;const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());return typeof claims.email==='string'?claims.email:null;}catch{return null;}}

const ownedFields=['model','model_provider','cli_auth_credentials_store','profile'] as const;
function sameValue(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const x=a as Record<string,unknown>,y=b as Record<string,unknown>;
  return Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(k=>Object.hasOwn(y,k)&&sameValue(x[k],y[k]));
}
function nativeRouting(config:Record<string,unknown>){
  return (config.model_provider??'openai')==='openai'&&(config.cli_auth_credentials_store??'file')==='file'&&!config.profile;
}
function restoredConfig(current:string|null,journal:Journal){
  const now=parse(current??''),after=parse(journal.after.config),before=parse(journal.before.config??'');
  const rest=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([k])=>!ownedFields.includes(k as typeof ownedFields[number])));
  if(sameValue(rest(now),rest(after)))return journal.before.config;
  // Restore only fields this module owns; keep new projects, preferences, MCP settings, etc.
  for(const key of ownedFields){if(Object.hasOwn(before,key))now[key]=before[key];else delete now[key];}
  return stringify(now);
}

/** Native file login is independent of the gateway pool. The keyring is left intact for rollback. */
export class CodexAccounts {
  private authPath:string;
  private backupPath:string;
  constructor(private root:string,private configPath:string,private processes=()=>agentProcesses('codex')){
    this.authPath=join(dirname(configPath),'auth.json');
    this.backupPath=join(root,'codex-account-backup.json');
  }
  private async files(){return {auth:await readConfig(this.authPath),config:await readConfig(this.configPath)};}
  private async journal():Promise<Journal|null>{const raw=await readConfig(this.backupPath);if(raw===null)return null;try{return journalSchema.parse(JSON.parse(raw));}catch{throw conflict('账号切换备份无法读取，请保留备份并检查。');}}
  private async write(path:string,value:string|null){
    await safePath(path);
    if(value===null){await rm(path,{force:true});return;}
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const temp=`${path}.${randomUUID()}.tmp`;
    try{await writeFile(temp,value,{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}
  }
  private save(value:Journal){return this.write(this.backupPath,JSON.stringify(value));}
  async status(){
    const files=await this.files();let config:Record<string,unknown>;
    try{config=parse(files.config??'');}catch{throw conflict('Codex 配置格式无效，未修改。');}
    const journal=await this.journal();
    const storage=String(config.cli_auth_credentials_store??'file');
    const fileActive=storage==='file';
    return {revision:digest(files),accountId:fileActive?identity(files.auth):null,email:fileActive?email(files.auth):null,storage,model:typeof config.model==='string'?config.model:null,provider:typeof config.model_provider==='string'?config.model_provider:'openai',pids:await this.processes(),backup:journal&&journal.state!=='restored'?{createdAt:journal.createdAt,state:journal.state}:null};
  }
  private async locked<T>(operation:()=>Promise<T>){
    await safePath(this.configPath);await mkdir(dirname(this.configPath),{recursive:true,mode:0o700});
    // Share the A2A lock: these features both own config.toml writes.
    const lock=`${this.configPath}.token-flow.lock`;let handle;
    try{handle=await open(lock,'wx',0o600);}catch{throw conflict('另一个配置操作正在进行，请稍后重试。');}
    try{return await operation();}finally{await handle.close();await unlink(lock);}
  }
  private async check(revision:string,allowRunning:boolean){
    if(digest(await this.files())!==revision)throw conflict('本机登录或配置已变化，请刷新后重试。');
    const pids=await this.processes();if(pids.length&&!allowRunning)throw conflict('检测到 Codex 仍在运行，请确认切换后重启。');
  }
  async switch(input:{revision:string;allowRunning:boolean;model:string},raw:unknown){
    const parsed=credential.safeParse(raw);if(!parsed.success)throw conflict('账号缺少完整 OAuth 凭据，请重新授权。');
    let c=parsed.data;
    if(!/^codex\/[a-zA-Z0-9._-]+$/.test(input.model)||/(?:gpt-image-|codex-auto-review)/.test(input.model))throw conflict('请选择 Codex 支持的模型。');
    return this.locked(async()=>{
      await this.check(input.revision,input.allowRunning);
      const before=await this.files();const previous=await this.journal();
      if(previous?.state==='prepared')throw conflict('上次切换尚未完成，请先还原原登录。');
      if(previous?.state==='applied'&&(!nativeRouting(parse(before.config??''))||identity(before.auth)!==previous.accountId))throw conflict('上次切换后本机配置或登录已被修改，请先检查或还原。');
      // Prefer the running client's refreshed tokens when selecting the same native account.
      if(identity(before.auth)===c.account_id){const native=credential.safeParse(JSON.parse(before.auth!).tokens);if(native.success)c={...native.data,last_refresh:JSON.parse(before.auth!).last_refresh??undefined};}
      const config=parse(before.config??'');
      if(config.forced_login_method&&config.forced_login_method!=='chatgpt')throw conflict('Codex 配置限制了登录方式，请先解除该限制。');
      if(config.forced_chatgpt_workspace_id&&config.forced_chatgpt_workspace_id!==c.account_id)throw conflict('所选账号与 Codex 限定的工作空间不一致。');
      if(config.model_providers&&typeof config.model_providers==='object'&&'openai' in config.model_providers)throw conflict('OpenAI 提供商有自定义覆盖，请先检查接口配置，未写入登录凭据。');
      config.model=input.model.slice('codex/'.length);config.model_provider='openai';config.cli_auth_credentials_store='file';delete config.profile;
      const after={auth:JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{access_token:c.access_token,refresh_token:c.refresh_token,id_token:c.id_token,account_id:c.account_id},last_refresh:c.last_refresh??null},null,2)+'\n',config:stringify(config)};
      // Retain the original login across repeated A -> B switches.
      const journal:Journal={before:previous?.state==='applied'?{...previous.before,config:restoredConfig(before.config,previous)}:before,after,accountId:c.account_id,createdAt:new Date().toISOString(),state:'prepared'};
      await this.save(journal);
      try{
        await this.check(input.revision,input.allowRunning);
        await this.write(this.authPath,after.auth);
        if((await readConfig(this.configPath))!==before.config)throw conflict('配置被其他程序修改，已停止切换。');
        await this.write(this.configPath,after.config);
        journal.state='applied';await this.save(journal);
      }catch(error){
        // Roll back only bytes we wrote. Do not overwrite a concurrent external edit.
        if(await readConfig(this.authPath)===after.auth)await this.write(this.authPath,before.auth);
        if(await readConfig(this.configPath)===after.config)await this.write(this.configPath,before.config);
        if(digest(await this.files())===digest(before)){if(previous)await this.save(previous);else await this.write(this.backupPath,null);}
        throw error;
      }
      return this.status();
    });
  }
  async restore(input:{revision:string;allowRunning:boolean}){
    return this.locked(async()=>{
      await this.check(input.revision,input.allowRunning);
      const journal=await this.journal();if(!journal||journal.state==='restored')throw conflict('没有可还原的账号切换备份。');
      const current=await this.files();
      // Refreshed tokens for the same account are expected; a different native login is not.
      if(!sameValue(parse(current.config??''),parse(journal.before.config??''))&&!nativeRouting(parse(current.config??''))||current.auth!==journal.before.auth&&identity(current.auth)!==journal.accountId)throw conflict('本机登录或配置已有其他修改，已保留备份，未覆盖。');
      await this.write(this.authPath,journal.before.auth);
      await this.write(this.configPath,restoredConfig(current.config,journal));
      journal.state='restored';await this.save(journal);
      return this.status();
    });
  }
}
export type CodexAccountStatus=Awaited<ReturnType<CodexAccounts['status']>>;
