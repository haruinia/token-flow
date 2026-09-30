import { a2aCapabilities } from '@cua-sample/contracts/a2a';
import { readFile, writeFile, mkdir, rename, lstat, unlink, open, rm } from 'node:fs/promises';
import { dirname, join, resolve, parse as parsePath } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

export const targetSchema=z.enum(['codex','claude','workbuddy','qoder']);
export type Target=z.infer<typeof targetSchema>;
const exec=promisify(execFile);
const hash=(text:string|null)=>createHash('sha256').update(text===null?'missing':`file:${text}`).digest('hex');
const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const recordSchema=z.object({id:z.string().uuid(),target:targetSchema,createdAt:z.string(),before:z.string().nullable(),after:z.string(),beforeHash:z.string(),afterHash:z.string(),state:z.enum(['prepared','applied','restored']),keyId:z.string().uuid(),sourceId:z.string(),model:z.string(),supersedes:z.string().uuid().optional(),previousConfig:z.string().nullable().optional(),previousHash:z.string().optional()});
type Record=z.infer<typeof recordSchema>;
export type ConnectionRecord=Omit<Record,'before'|'after'|'previousConfig'>;
const publicRecord=({before,after,previousConfig,...record}:Record):ConnectionRecord=>record;
export type AgentPaths={[K in Target]:string};
const targetNames={codex:'Codex',claude:'Claude Code',workbuddy:'WorkBuddy',qoder:'Qoder'};
export function agentPaths(home=homedir()):AgentPaths {
  return {qoder:join(process.env.QODER_CONFIG_DIR||join(home,'.qoder'),'settings.json'),codex:join(process.env.CODEX_HOME||join(home,'.codex'),'config.toml'),claude:join(process.env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'settings.json'),workbuddy:join(process.env.WORKBUDDY_CONFIG_DIR||process.env.CODEBUDDY_CONFIG_DIR||join(home,'.workbuddy'),'models.json')};
}
// Read process names only: command arguments can contain secrets.
export async function agentProcesses(target:Target|'antigravity'):Promise<number[]> {
  try {
    if(process.platform==='win32') {
      const {stdout}=await exec('tasklist',['/FO','CSV','/NH'],{timeout:5000,maxBuffer:2*1024*1024});
      return stdout.split('\n').flatMap(line=>{const m=line.match(/^"([^"]+)","(\d+)"/);return m&&new RegExp(`^${target}${target==='antigravity'?'(?: IDE)?':''}(?:\\.exe)?$`,'i').test(m[1])?[Number(m[2])]:[];});
    }
    const {stdout}=await exec('ps',['-axo','pid=,comm='],{timeout:5000,maxBuffer:2*1024*1024});
    return stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(.+)$/);return m&&!(target==='qoder'&&m[2].includes('/Qoder IDE.app/'))&&new RegExp(`(?:^|/)${target}(?:$|[- ])`,'i').test(m[2])?[Number(m[1])]:[];});
  }catch{throw conflict('无法检查 Agent 进程，未修改配置。请确认系统进程查询可用。');}
}
export async function safePath(path:string) {
  let current=resolve(path);const root=parsePath(current).root;
  while(current!==root){try{const stat=await lstat(current);if(stat.isSymbolicLink())throw conflict('配置路径含符号链接，请手动处理以避免修改其他文件。');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}current=dirname(current);}
}
export async function readConfig(path:string):Promise<string|null> {
  await safePath(path);
  try{const stat=await lstat(path);if(!stat.isFile()||stat.size>2*1024*1024)throw conflict('配置不是普通文件或超过 2 MB，未修改。');return await readFile(path,'utf8');}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
function equivalentConfig(target:Target,a:string|null,b:string|null):boolean {
  if(a===b)return true;if(a===null||b===null)return false;
  const equal=(x:unknown,y:unknown):boolean=>{
    if(x===y)return true;
    if(!x||!y||typeof x!=='object'||typeof y!=='object'||Array.isArray(x)!==Array.isArray(y))return false;
    const left=x as {[key:string]:unknown},right=y as {[key:string]:unknown};
    return Object.keys(left).length===Object.keys(right).length&&Object.keys(left).every(k=>Object.hasOwn(right,k)&&equal(left[k],right[k]));
  };
  try{return equal(target==='codex'?parse(a):JSON.parse(a),target==='codex'?parse(b):JSON.parse(b));}catch{return false;}
}
// Reverse only the fields this connection changed. Client settings added later survive.
function restoredConfig(record:Record,current:string|null):string|null {
  if(equivalentConfig(record.target,current,record.before))return current;
  if(equivalentConfig(record.target,current,record.after))return record.before;
  const fail=()=>{throw conflict('接入字段存在外部修改，无法安全还原。请检查配置，或删除失效记录后重新接入。备份仍保留。');};
  if(current===null)return fail();
  const decode=(text:string)=>record.target==='codex'?parse(text):JSON.parse(text);
  const isObject=(value:unknown):value is {[key:string]:unknown}=>!!value&&typeof value==='object'&&!Array.isArray(value);
  const reverse=(before:unknown,after:unknown,actual:unknown):unknown=>{
    if(isDeepStrictEqual(before,after)||isDeepStrictEqual(actual,before))return actual;
    if(isDeepStrictEqual(actual,after))return before;
    if(isObject(after)&&isObject(actual)&&(before===undefined||isObject(before))){
      const result={...actual};const original=isObject(before)?before:{};
      for(const key of new Set([...Object.keys(original),...Object.keys(after)])){
        const value=reverse(original[key],after[key],actual[key]);
        if(value===undefined)delete result[key];else Object.defineProperty(result,key,{value,writable:true,enumerable:true,configurable:true});
      }
      return Object.keys(result).length||before!==undefined?result:undefined;
    }
    return fail();
  };
  try{
    const result=reverse(record.before===null?undefined:decode(record.before),decode(record.after),decode(current));
    return result===undefined?null:record.target==='codex'?stringify(object(result)):JSON.stringify(result,null,2)+'\n';
  }catch{return fail();}
}
function object(value:unknown):{[key:string]:any} {
  if(!value||typeof value!=='object'||Array.isArray(value))throw conflict('配置格式无效，未覆盖原文件。');return value;
}
function codexProfile(doc:{[key:string]:any}):{[key:string]:any}|undefined {
  if(doc.profile===undefined)return;
  if(typeof doc.profile!=='string'||!Object.hasOwn(object(doc.profiles),doc.profile))throw conflict('Codex 当前配置档案无效，未修改原设置。');
  return object(doc.profiles[doc.profile]);
}
export function connectedConfig(target:Target,original:string|null,origin:string,model:string,key:string) {
  const url=new URL(origin);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('接入地址必须是本机网关');
  if(target==='qoder'){
    const doc=original===null?{}:object(JSON.parse(original));
    const providers=doc.providers===undefined?{}:object(doc.providers);
    if(Object.hasOwn(providers,'token-flow'))throw conflict('Qoder 已有 token-flow 供应商，请先还原已有接入。');
    return JSON.stringify({...doc,providers:{...providers,'token-flow':{type:'openai-compatible',protocol:'openai-responses',authType:'bearer',baseUrl:`${url.origin}/v1`,apiKey:key,displayName:'token-flow',model,models:[{model,displayName:`token-flow · ${model}`}]}}},null,2)+'\n';
  }
  if(target==='workbuddy'){
    const value=original===null?[]:JSON.parse(original);
    const doc=Array.isArray(value)?{models:value}:object(value);
    if(Object.keys(doc).some(k=>k!=='models'))throw conflict('WorkBuddy models.json 包含额外设置，自动转换为原生数组会丢失字段，已保留原文件；请先整理这些设置再接入。');
    const models=doc.models===undefined?[]:z.array(z.object({id:z.string()}).passthrough()).parse(doc.models);
    if(models.some(m=>m.id===model||m.id===`custom-local:${model}`))throw conflict('已有同名自定义模型，请先保留或移除该配置后再接入。');
    const next:{[key:string]:any}={...doc,models:[...models,{id:model,name:`token-flow · ${model}`,url:`${url.origin}/v1/chat/completions`,apiKey:key,supportsToolCall:true}]};
    return JSON.stringify(next.models,null,2)+'\n';
  }
  if(target==='claude'){
    const doc=original===null?{}:object(JSON.parse(original));
    const env=doc.env===undefined?{}:object(doc.env);
    return JSON.stringify({...doc,model,env:{...env,ANTHROPIC_BASE_URL:url.origin,ANTHROPIC_AUTH_TOKEN:key,ANTHROPIC_API_KEY:'',ANTHROPIC_MODEL:model,ANTHROPIC_DEFAULT_OPUS_MODEL:model,ANTHROPIC_DEFAULT_SONNET_MODEL:model,ANTHROPIC_DEFAULT_HAIKU_MODEL:model,ANTHROPIC_SMALL_FAST_MODEL:model,CLAUDE_CODE_SUBAGENT_MODEL:model}},null,2)+'\n';
  }
  const doc=original===null?{}:parse(original);
  // Full original bytes remain in the backup; TOML serialization preserves semantic settings.
  const providers=doc.model_providers===undefined?{}:object(doc.model_providers);
  const routing={model,model_provider:'token_flow',...(a2aCapabilities(model)?.serverTools===false?{web_search:'disabled'}:{})};
  const next:{[key:string]:any}={...doc,...routing,model_providers:{...providers,token_flow:{name:'token-flow',base_url:`${url.origin}/v1`,wire_api:'responses',experimental_bearer_token:key,requires_openai_auth:false,supports_websockets:false}}};
  // Legacy clients overlay the selected profile. Keep its policy and selection;
  // update only model routing. Newer CLI-selected profile files stay user-owned.
  const profile=codexProfile(doc);
  if(profile)next.profiles={...object(doc.profiles),[doc.profile as string]:{...profile,...routing}};
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
    for(const file of files.filter(f=>/^[a-f0-9-]{36}\.json$/.test(f))){try{const record=recordSchema.parse(JSON.parse(await readFile(join(this.dir(),file),'utf8')));if(hash(record.before)!==record.beforeHash||hash(record.after)!==record.afterHash||(record.previousConfig!==undefined&&hash(record.previousConfig)!==record.previousHash))throw new Error('Backup checksum mismatch');records.push(record);}catch{throw conflict('接入备份记录损坏，请保留文件并人工检查。');}}
    return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  private async save(record:Record){const path=join(this.dir(),`${record.id}.json`);const temp=`${path}.tmp`;await writeFile(temp,JSON.stringify(record),{mode:0o600});await rename(temp,path);}
  private run<T>(target:Target,operation:()=>Promise<T>):Promise<T>{
    const task=this.tail.then(async()=>{
      const lock=`${this.paths[target]}.token-flow.lock`;
      await safePath(this.paths[target]);await mkdir(dirname(lock),{recursive:true,mode:0o700});
      let file;try{file=await open(lock,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw conflict('另一个接入操作持有配置锁；如应用曾异常退出，请先检查锁文件，未强行覆盖。');throw e;}
      try{await file.writeFile(String(process.pid));return await operation();}finally{await file.close();await unlink(lock);}
    });this.tail=task.catch(()=>{});return task;
  }
  private async idle(target:Target){const pids=await this.processes(target);if(pids.length)throw conflict(`请先退出 ${targetNames[target]} 再重试；检测到进程 ${pids.join(', ')}。不会强制终止运行中的任务。`);}
  private async replace(target:Target,expected:string,next:string|null,allowRunning=false){
    if(!allowRunning)await this.idle(target);const path=this.paths[target];if(hash(await readConfig(path))!==expected)throw conflict('配置已被其他应用修改，请重新检查后再操作。');
    if(next===null){await unlink(path);return;}
    const temp=`${path}.token-flow-${randomUUID()}.tmp`;
    try{await writeFile(temp,next,{mode:0o600,flag:'wx'});if(hash(await readConfig(path))!==expected)throw conflict('配置发生并发修改，已停止写入。');await rename(temp,path);}finally{await rm(temp,{force:true});}
  }
  async status(){
    const records=await this.records();
    return Promise.all(targetSchema.options.map(async target=>{
      let current:string|null=null,error='';try{current=await readConfig(this.paths[target]);}catch(e){error=e instanceof Error?e.message:'读取失败';}
      let pids:number[]=[];try{pids=await this.processes(target);}catch(e){error=e instanceof Error?e.message:'进程检查失败';}
      const latest=records.find(r=>r.target===target&&r.state!=='restored');
      return {id:target,name:targetNames[target],path:this.paths[target],exists:current!==null,revision:hash(current),pids,error,connection:latest?publicRecord(latest):null,drift:!!latest&&!equivalentConfig(target,current,latest.after),configurationState:error?'unreadable':!latest?'unmanaged':equivalentConfig(target,current,latest.after)?'configured':equivalentConfig(target,current,latest.before)?'missing':'changed',backups:records.filter(r=>r.target===target).map(publicRecord)};
    }));
  }
  async review(id:string){
    const record=(await this.records()).find(r=>r.id===id&&r.state!=='restored');if(!record)throw conflict('接入记录不存在或已还原');
    const current=await readConfig(this.paths[record.target]);
    const checks:{name:string;ok:boolean}[]=[{name:'配置与接入备份一致',ok:equivalentConfig(record.target,current,record.after)},{name:'接入写入已完成',ok:record.state==='applied'}];
    try{
      const parsed=record.target==='codex'?parse(current??''):JSON.parse(current??'{}');
      const actual=record.target==='workbuddy'&&Array.isArray(parsed)?{models:parsed}:object(parsed);
      const expectedValue=record.target==='codex'?parse(record.after):JSON.parse(record.after);
      const expected=record.target==='workbuddy'&&Array.isArray(expectedValue)?{models:expectedValue}:expectedValue;
      if(record.target==='claude'){
        checks.push({name:'主模型与辅助模型一致',ok:actual.model===record.model&&['ANTHROPIC_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_SUBAGENT_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL'].every(k=>actual.env?.[k]===record.model)},
          {name:'接口地址正确',ok:actual.env?.ANTHROPIC_BASE_URL===expected.env.ANTHROPIC_BASE_URL},
          {name:'客户端 Key 未被覆盖',ok:actual.env?.ANTHROPIC_AUTH_TOKEN===expected.env.ANTHROPIC_AUTH_TOKEN&&actual.env?.ANTHROPIC_API_KEY===''});
      }else if(record.target==='qoder'){
        const provider=actual.providers?.['token-flow'],original=expected.providers['token-flow'];
        checks.push({name:'自定义模型已写入',ok:provider?.model===record.model&&provider.models?.some((m:{model:string})=>m.model===record.model)},{name:'Responses 接口正确',ok:provider?.baseUrl===original.baseUrl&&provider?.protocol==='openai-responses'},{name:'客户端 Key 未被覆盖',ok:provider?.apiKey===original.apiKey});
      }else if(record.target==='workbuddy'){
        const model=actual.models?.find((m:{id:string})=>m.id===record.model);const original=expected.models.find((m:{id:string})=>m.id===record.model);
        checks.push({name:'自定义模型已写入配置',ok:!!model&&(!actual.availableModels?.length||actual.availableModels.includes(record.model))},{name:'接口地址与工具能力正确',ok:model?.url===original.url&&model?.supportsToolCall===true},{name:'客户端 Key 未被覆盖',ok:model?.apiKey===original.apiKey});
      }else{
        const provider=actual.model_providers?.token_flow;const original=expected.model_providers.token_flow;
        const effective={...actual,...codexProfile(actual)};
        checks.push({name:'模型与配置层级正确',ok:effective.model===record.model&&effective.model_provider==='token_flow'&&actual.profile===expected.profile},{name:'接口与协议正确',ok:provider?.base_url===original.base_url&&provider?.wire_api==='responses'},{name:'客户端 Key 未被覆盖',ok:provider?.experimental_bearer_token===original.experimental_bearer_token});
        checks.push({name:'本地配置档案选择保留',ok:actual.profile===parse(record.before??'').profile});
        if(a2aCapabilities(record.model)?.serverTools===false)checks.push({name:'来源不支持的内置网页搜索已关闭',ok:effective.web_search==='disabled'});
      }
    }catch{checks.push({name:'配置格式可解析',ok:false});}
    return {id,target:record.target,model:record.model,checks,liveCallVerified:false,...(record.target==='claude'?{compatibility:{autoMode:'unverified' as const,note:'主模型、辅助模型配置一致不代表 Auto Mode 审批可用。审批分类器与 App 的维修审批模型相互独立；Messages 文本和工具检测也不能验证分类器。'}}:{}),note:record.target==='qoder'?`重启 Qoder 独立应用，在模型菜单选择 token-flow · ${record.model}。原登录与内置模型保留；不适用于 Qoder IDE。`:record.target==='workbuddy'?`在 WorkBuddy 新建任务的输入框下方打开模型菜单，选择 token-flow · ${record.model}。若没有显示，重启 WorkBuddy 后再查看。配置检查不代表已在客户端选用。`:'重启 Agent 后加载配置；项目级设置或已有终端环境变量仍可能覆盖用户配置。'};
  }
  async apply(input:{target:Target;revision:string;origin:string;model:string;sourceId:string;keyId:string;key:string;allowRunning?:boolean;replaceId?:string}){
    return this.run(input.target,async()=>{
      if(!input.allowRunning)await this.idle(input.target);
      const before=await readConfig(this.paths[input.target]);if(hash(before)!==input.revision)throw conflict('配置已变更，请刷新接入预览。');
      const active=(await this.records()).find(r=>r.target===input.target&&r.state!=='restored');
      if(active&&active.id!==input.replaceId)throw conflict('此 Agent 已有接入记录，请审批切换方案后再接入。');
      if(input.replaceId&&!active)throw conflict('接入记录已变化，请重新生成维修方案。');
      const original=active?restoredConfig(active,before):before;
      let after:string;try{after=connectedConfig(input.target,original,input.origin,input.model,input.key);}catch{throw conflict('配置格式无法安全解析，未修改原文件。');}
      const record:Record={id:randomUUID(),target:input.target,createdAt:new Date().toISOString(),before:original,after,beforeHash:hash(original),afterHash:hash(after),state:'prepared',keyId:input.keyId,sourceId:input.sourceId,model:input.model,...(active?{supersedes:active.id,previousConfig:before,previousHash:hash(before)}:{})};
      await this.save(record);await this.replace(input.target,input.revision,after,input.allowRunning);record.state='applied';await this.save(record);await this.retirePrevious(record);return publicRecord(record);
    });
  }
  private async retirePrevious(record:Record){
    if(!record.supersedes)return;const previous=(await this.records()).find(r=>r.id===record.supersedes);
    if(previous&&previous.state!=='restored'){previous.state='restored';await this.save(previous);}
  }
  async preview(target:Target,origin:string,model:string){
    const records=await this.records();const active=records.find(r=>r.target===target&&r.state!=='restored');
    const current=await readConfig(this.paths[target]);
    const original=active?restoredConfig(active,current):current;
    const after=connectedConfig(target,original,origin,model,'<审批后由网关注入客户端 Key>');
    // Only expose gateway-owned routing fields, never the full user configuration.
    const parsed=target==='codex'?parse(after):JSON.parse(after);
    const effective=target==='codex'?{...parsed,...codexProfile(parsed)}:parsed;
    const routing=target==='qoder'?parsed.providers['token-flow']:target==='workbuddy'?(Array.isArray(parsed)?parsed:parsed.models).find((m:{id:string})=>m.id===model):target==='codex'?{model:effective.model,model_provider:effective.model_provider,...(parsed.profile!==undefined?{profile:parsed.profile}:{}),...(effective.web_search!==undefined?{web_search:effective.web_search}:{}),token_flow:parsed.model_providers.token_flow}:Object.fromEntries(Object.entries(parsed.env).filter(([k])=>['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL','ANTHROPIC_SMALL_FAST_MODEL','CLAUDE_CODE_SUBAGENT_MODEL'].includes(k)));
    return {target,path:this.paths[target],revision:hash(current),replaceId:active?.id,previousModel:active?.model,pids:await this.processes(target),routing};
  }
  async repair(id:string){
    const entry=(await this.records()).find(r=>r.id===id);if(!entry||entry.state==='restored')throw conflict('没有可修复的接入记录，请重新接入。');
    return this.run(entry.target,async()=>{
      const record=(await this.records()).find(r=>r.id===id)!;
      const currentText=await readConfig(this.paths[record.target]);const current=hash(currentText);
      if(equivalentConfig(record.target,currentText,record.after)){record.state='applied';await this.save(record);await this.retirePrevious(record);return publicRecord(record);}
      if(current!==record.beforeHash&&!(record.previousConfig!==undefined&&current===hash(record.previousConfig)))throw conflict('配置存在外部修改，无法安全自动修复，请先检查并保留备份。');
      await this.replace(record.target,current,record.after);record.state='applied';await this.save(record);await this.retirePrevious(record);return publicRecord(record);
    });
  }
  async remove(id:string,revision:string){
    const entry=(await this.records()).find(r=>r.id===id);if(!entry)throw conflict('备份不存在');
    return this.run(entry.target,async()=>{
      const records=await this.records();const record=records.find(r=>r.id===id);if(!record)throw conflict('备份不存在');
      if(hash(await readConfig(this.paths[record.target]))!==revision)throw conflict('配置已变更，请刷新后再删除记录。');
      // An interrupted replacement can still depend on the previous journal.
      if(records.some(r=>r.state==='prepared'&&r.supersedes===id))throw conflict('新接入仍依赖此备份，请先还原或删除新接入记录。');
      await this.retirePrevious(record);
      await unlink(join(this.dir(),`${id}.json`));return publicRecord(record);
    });
  }
  async restore(id:string,approval?:{revision:string;allowRunning:boolean}){
    const entry=(await this.records()).find(r=>r.id===id);if(!entry)throw conflict('备份不存在');
    return this.run(entry.target,async()=>{
      const record=(await this.records()).find(r=>r.id===id)!;
      if(record.state==='restored')return publicRecord(record);
      const currentText=await readConfig(this.paths[record.target]);const current=hash(currentText);
      if(approval&&current!==approval.revision)throw conflict('审批后配置已变更，请重新生成方案。');
      if(equivalentConfig(record.target,currentText,record.before)){record.state='restored';await this.save(record);await this.retirePrevious(record);return publicRecord(record);}
      const restored=restoredConfig(record,currentText);
      await this.replace(record.target,current,restored,approval?.allowRunning);record.state='restored';await this.save(record);await this.retirePrevious(record);return publicRecord(record);
    });
  }
}
