import { readFile, writeFile, mkdir, rename, lstat, unlink, open, rm } from 'node:fs/promises';
import { dirname, join, resolve, parse as parsePath } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

export const targetSchema=z.enum(['codex','claude','workbuddy']);
export type Target=z.infer<typeof targetSchema>;
const exec=promisify(execFile);
const hash=(text:string|null)=>createHash('sha256').update(text===null?'missing':`file:${text}`).digest('hex');
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const recordSchema=z.object({id:z.string().uuid(),target:targetSchema,createdAt:z.string(),before:z.string().nullable(),after:z.string(),beforeHash:z.string(),afterHash:z.string(),state:z.enum(['prepared','applied','restored']),keyId:z.string().uuid(),sourceId:z.string(),model:z.string()});
type Record=z.infer<typeof recordSchema>;
export type ConnectionRecord=Omit<Record,'before'|'after'>;
const publicRecord=({before,after,...record}:Record):ConnectionRecord=>record;
export type AgentPaths={[K in Target]:string};
const targetNames={codex:'Codex',claude:'Claude Code',workbuddy:'WorkBuddy'};
export function agentPaths(home=homedir()):AgentPaths {
  return {codex:join(process.env.CODEX_HOME||join(home,'.codex'),'config.toml'),claude:join(process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'settings.json'),workbuddy:join(process.env.WORKBUDDY_CONFIG_DIR||process.env.CODEBUDDY_CONFIG_DIR||join(home,'.workbuddy'),'models.json')};
}
// Read process names only: command arguments can contain secrets.
export async function agentProcesses(target:Target):Promise<number[]> {
  try {
    if(process.platform==='win32') {
      const {stdout}=await exec('tasklist',['/FO','CSV','/NH'],{timeout:5000,maxBuffer:2*1024*1024});
      return stdout.split('\n').flatMap(line=>{const m=line.match(/^"([^"]+)","(\d+)"/);return m&&new RegExp(`^${target}(?:\\.exe)?$`,'i').test(m[1])?[Number(m[2])]:[];});
    }
    const {stdout}=await exec('ps',['-axo','pid=,comm='],{timeout:5000,maxBuffer:2*1024*1024});
    return stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(.+)$/);return m&&new RegExp(`(?:^|/)${target}(?:$|[- ])`,'i').test(m[2])?[Number(m[1])]:[];});
  }catch{throw conflict('无法检查 Agent 进程，未修改配置。请确认系统进程查询可用。');}
}
async function safePath(path:string) {
  let current=resolve(path);const root=parsePath(current).root;
  while(current!==root){try{const stat=await lstat(current);if(stat.isSymbolicLink())throw conflict('配置路径含符号链接，请手动处理以避免修改其他文件。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}current=dirname(current);}
}
async function readConfig(path:string):Promise<string|null> {
  await safePath(path);
  try{const stat=await lstat(path);if(!stat.isFile()||stat.size>2*1024*1024)throw conflict('配置不是普通文件或超过 2 MB，未修改。');return await readFile(path,'utf8');}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
function object(value:unknown):{[key:string]:any} {
  if(!value||typeof value!=='object'||Array.isArray(value))throw conflict('配置格式无效，未覆盖原文件。');return value;
}
export function connectedConfig(target:Target,original:string|null,origin:string,model:string,key:string) {
  const url=new URL(origin);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('接入地址必须是本机网关');
  if(target==='workbuddy'){
    const value=original===null?{}:JSON.parse(original);
    const doc=Array.isArray(value)?{models:value}:object(value);
    const models=doc.models===undefined?[]:z.array(z.object({id:z.string()}).passthrough()).parse(doc.models);
    if(models.some(m=>m.id===model||m.id===`custom-local:${model}`))throw conflict('已有同名自定义模型，请先保留或移除该配置后再接入。');
    const next:{[key:string]:any}={...doc,models:[...models,{id:model,name:`token-flowb · ${model}`,url:`${url.origin}/v1/chat/completions`,apiKey:key,supportsToolCall:true}]};
    if(doc.availableModels!==undefined&&z.array(z.string()).parse(doc.availableModels).length)next.availableModels=[...new Set([...z.array(z.string()).parse(doc.availableModels),model])];
    return JSON.stringify(next,null,2)+'\n';
  }
  if(target==='claude'){
    const doc=original===null?{}:object(JSON.parse(original));
    const env=doc.env===undefined?{}:object(doc.env);
    return JSON.stringify({...doc,model,env:{...env,ANTHROPIC_BASE_URL:url.origin,ANTHROPIC_AUTH_TOKEN:key,ANTHROPIC_API_KEY:'',ANTHROPIC_MODEL:model,ANTHROPIC_DEFAULT_OPUS_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model,ANTHROPIC_DEFAULT_HAIKU_MODEL:model,ANTHROPIC_SMALL_FAST_MODEL:model,CLAUDE_CODE_SUBAGENT_MODEL:model}},null,2)+'\n';
  }
  const doc=original===null?{}:parse(original);
  // Full original bytes remain in the backup; TOML serialization preserves semantic settings.
  const providers=doc.model_providers===undefined?{}:object(doc.model_providers);
  const next={...doc,model,model_provider:'token_flowb',model_providers:{...providers,token_flowb:{name:'token-flowb',base_url:`${url.origin}/v1`,wire_api:'responses',experimental_bearer_token:key,requires_openai_auth:false,supports_websockets:false}}};
  // An active profile takes precedence over root model settings; leave its contents untouched.
  delete (next as {[key:string]:unknown}).profile;
  return stringify(next);
}

/** Backups are journaled before a single atomic configuration replacement. Never expose their contents. */
export class AgentConnections {
  private tail:Promise<unknown>=Promise.resolve();
  constructor(private root:string,readonly paths:AgentPaths=agentPaths(),private processes:(target:Target)=>Promise<number[]>=agentProcesses) {}
  private dir(){return join(this.root,'agent-backups');}
  private async records():Promise<Record[]> {
    const {readdir}=await import('node:fs/promises');await mkdir(this.dir(),{recursive:true,mode:0o700});
    const files=await readdir(this.dir());const records:Record[]=[];
    for(const file of files.filter(f=>/^[a-f0-9-]{36}\.json$/.test(f))){try{const record=recordSchema.parse(JSON.parse(await readFile(join(this.dir(),file),'utf8')));if(hash(record.before)!==record.beforeHash||hash(record.after)!==record.afterHash)throw new Error('Backup checksum mismatch');records.push(record);}catch{throw conflict('接入备份记录损坏，请保留文件并人工检查。');}}
    return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  private async save(record:Record){const path=join(this.dir(),`${record.id}.json`);const temp=`${path}.tmp`;await writeFile(temp,JSON.stringify(record),{mode:0o600});await rename(temp,path);}
  private run<T>(target:Target,operation:()=>Promise<T>):Promise<T>{
    const task=this.tail.then(async()=>{
      const lock=`${this.paths[target]}.token-flowb.lock`;
      await safePath(this.paths[target]);await mkdir(dirname(lock),{recursive:true,mode:0o700});
      let file;try{file=await open(lock,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw conflict('另一个接入操作持有配置锁；如应用曾异常退出，请先检查锁文件，未强行覆盖。');throw e;}
      try{await file.writeFile(String(process.pid));return await operation();}finally{await file.close();await unlink(lock);}
    });this.tail=task.catch(()=>{});return task;
  }
  private async idle(target:Target){const pids=await this.processes(target);if(pids.length)throw conflict(`请先退出 ${targetNames[target]} 再重试；检测到进程 ${pids.join(', ')}。不会强制终止运行中的任务。`);}
  private async replace(target:Target,expected:string,next:string|null,allowRunning=false){
    if(!allowRunning)await this.idle(target);const path=this.paths[target];if(hash(await readConfig(path))!==expected)throw conflict('配置已被其他应用修改，请重新检查后再操作。');
    if(next===null){await unlink(path);return;}
    const temp=`${path}.token-flowb-${randomUUID()}.tmp`;
    try{await writeFile(temp,next,{mode:0o600,flag:'wx'});if(hash(await readConfig(path))!==expected)throw conflict('配置发生并发修改，已停止写入。');await rename(temp,path);}finally{await rm(temp,{force:true});}
  }
  async status(){
    const records=await this.records();
    return Promise.all(targetSchema.options.map(async target=>{
      let current:string|null=null,error='';try{current=await readConfig(this.paths[target]);}catch(e){error=e instanceof Error?e.message:'读取失败';}
      let pids:number[]=[];try{pids=await this.processes(target);}catch(e){error=e instanceof Error?e.message:'进程检查失败';}
      const latest=records.find(r=>r.target===target&&r.state!=='restored');
      return {id:target,name:targetNames[target],path:this.paths[target],exists:current!==null,revision:hash(current),pids,error,connection:latest?publicRecord(latest):null,drift:!!latest&&hash(current)!==latest.afterHash,backups:records.filter(r=>r.target===target).map(publicRecord)};
    }));
  }
  async review(id:string){
    const record=(await this.records()).find(r=>r.id===id&&r.state!=='restored');if(!record)throw conflict('接入记录不存在或已还原');
    const current=await readConfig(this.paths[record.target]);
    const checks:{name:string;ok:boolean}[]=[{name:'配置与接入备份一致',ok:hash(current)===record.afterHash},{name:'接入写入已完成',ok:record.state==='applied'}];
    try{
      const parsed=record.target==='codex'?parse(current??''):JSON.parse(current??'{}');
      const actual=record.target==='workbuddy'&&Array.isArray(parsed)?{models:parsed}:object(parsed);
      const expected=record.target==='codex'?parse(record.after):JSON.parse(record.after);
      if(record.target==='claude'){
        checks.push({name:'主模型与辅助模型一致',ok:actual.model===record.model&&['ANTHROPIC_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_SUBAGENT_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL'].every(k=>actual.env?.[k]===record.model)},
          {name:'接口地址正确',ok:actual.env?.ANTHROPIC_BASE_URL===expected.env.ANTHROPIC_BASE_URL},
          {name:'客户端 Key 未被覆盖',ok:actual.env?.ANTHROPIC_AUTH_TOKEN===expected.env.ANTHROPIC_AUTH_TOKEN&&actual.env?.ANTHROPIC_API_KEY===''});
      }else if(record.target==='workbuddy'){
        const model=actual.models?.find((m:{id:string})=>m.id===record.model);const original=expected.models.find((m:{id:string})=>m.id===record.model);
        checks.push({name:'自定义模型已写入配置',ok:!!model&&(!actual.availableModels?.length||actual.availableModels.includes(record.model))},{name:'接口地址与工具能力正确',ok:model?.url===original.url&&model?.supportsToolCall===true},{name:'客户端 Key 未被覆盖',ok:model?.apiKey===original.apiKey});
      }else{
        const provider=actual.model_providers?.token_flowb;const original=expected.model_providers.token_flowb;
        checks.push({name:'模型与配置层级正确',ok:actual.model===record.model&&actual.model_provider==='token_flowb'&&!actual.profile},{name:'接口与协议正确',ok:provider?.base_url===original.base_url&&provider?.wire_api==='responses'},{name:'客户端 Key 未被覆盖',ok:provider?.experimental_bearer_token===original.experimental_bearer_token});
      }
    }catch{checks.push({name:'配置格式可解析',ok:false});}
    return {id,target:record.target,model:record.model,checks,liveCallVerified:false,note:record.target==='workbuddy'?`在 WorkBuddy 新建任务的输入框下方打开模型菜单，选择 token-flowb · ${record.model}。若没有显示，重启 WorkBuddy 后再查看。配置检查不代表已在客户端选用。`:'重启 Agent 后加载配置；项目级设置或已有终端环境变量仍可能覆盖用户配置。'};
  }
  async apply(input:{target:Target;revision:string;origin:string;model:string;sourceId:string;keyId:string;key:string;allowRunning?:boolean}){
    return this.run(input.target,async()=>{
      if(!input.allowRunning)await this.idle(input.target);
      const before=await readConfig(this.paths[input.target]);if(hash(before)!==input.revision)throw conflict('配置已变更，请刷新接入预览。');
      if((await this.records()).some(r=>r.target===input.target&&r.state!=='restored'))throw conflict('此 Agent 已有接入记录，请先还原，避免叠加覆盖。');
      let after:string;try{after=connectedConfig(input.target,before,input.origin,input.model,input.key);}catch{throw conflict('配置格式无法安全解析，未修改原文件。');}
      const record:Record={id:randomUUID(),target:input.target,createdAt:new Date().toISOString(),before,after,beforeHash:hash(before),afterHash:hash(after),state:'prepared',keyId:input.keyId,sourceId:input.sourceId,model:input.model};
      await this.save(record);await this.replace(input.target,input.revision,after,input.allowRunning);record.state='applied';await this.save(record);return publicRecord(record);
    });
  }
  async repair(id:string){
    const entry=(await this.records()).find(r=>r.id===id);if(!entry||entry.state==='restored')throw conflict('没有可修复的接入记录，请重新接入。');
    return this.run(entry.target,async()=>{
      const record=(await this.records()).find(r=>r.id===id)!;
      const current=hash(await readConfig(this.paths[record.target]));
      if(current===record.afterHash){record.state='applied';await this.save(record);return publicRecord(record);}
      if(current!==record.beforeHash)throw conflict('配置存在外部修改，无法安全自动修复，请先检查并保留备份。');
      await this.replace(record.target,current,record.after);record.state='applied';await this.save(record);return publicRecord(record);
    });
  }
  async restore(id:string){
    const entry=(await this.records()).find(r=>r.id===id);if(!entry)throw conflict('备份不存在');
    return this.run(entry.target,async()=>{
      const record=(await this.records()).find(r=>r.id===id)!;
      if(record.state==='restored')return publicRecord(record);
      const current=hash(await readConfig(this.paths[record.target]));
      if(current===record.beforeHash){record.state='restored';await this.save(record);return publicRecord(record);}
      if(current!==record.afterHash)throw conflict('接入后配置已被外部修改，自动还原会覆盖新内容，已停止。备份仍保留。');
      await this.replace(record.target,current,record.before);record.state='restored';await this.save(record);return publicRecord(record);
    });
  }
}
