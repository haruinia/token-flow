import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safePath } from './agent-connections.js';
import { nativeConflict, nativeDigest, type NativeStore, type NativeState, type NativeCredential } from './native-accounts.js';

const oauthKey='antigravityUnifiedStateSync.oauthToken',userKey='antigravityUnifiedStateSync.userStatus';
const enterpriseKey='antigravityUnifiedStateSync.enterprisePreferences';
const keys=[oauthKey,userKey,enterpriseKey,'antigravityOnboarding'];
const oauthSentinel='oauthTokenInfoSentinelKey',userSentinel='userStatusSentinelKey';
const sentinels:Record<string,string>={[oauthKey]:oauthSentinel,[userKey]:userSentinel,[enterpriseKey]:'enterpriseGcpProjectId'};
function varint(value:number){const bytes:number[]=[];do{let b=value%128;value=Math.floor(value/128);if(value)b|=128;bytes.push(b);}while(value);return Buffer.from(bytes);}
function field(n:number,value:Buffer|string){const b=typeof value==='string'?Buffer.from(value):value;return Buffer.concat([varint(n*8+2),varint(b.length),b]);}
function fields(data:Buffer){
  let offset=0;const result:{number:number;wire:number;value:Buffer;raw:Buffer}[]=[];
  const read=()=>{let value=0,scale=1;for(let i=0;i<10;i++){if(offset>=data.length)throw new Error();const b=data[offset++];value+=(b&127)*scale;if(!(b&128)){if(!Number.isSafeInteger(value))throw new Error();return value;}scale*=128;}throw new Error();};
  try{while(offset<data.length){const start=offset,tag=read(),wire=tag%8,number=Math.floor(tag/8);if(!number)throw new Error();let begin=offset;
    if(wire===2){const len=read();begin=offset;offset+=len;}else if(wire===0)read();else if(wire===1)offset+=8;else if(wire===5)offset+=4;else throw new Error();
    if(offset>data.length)throw new Error();result.push({number,wire,value:data.subarray(begin,offset),raw:data.subarray(start,offset)});
  }}catch{throw nativeConflict('反重力登录数据库格式不受支持，未修改。');}return result;
}
const get=(data:Buffer,n:number)=>fields(data).find(f=>f.number===n&&f.wire===2)?.value;
function decode(raw:string){if(raw.length>2*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw))throw nativeConflict('反重力登录数据无效，未修改。');return Buffer.from(raw,'base64');}
function topicValue(raw:string|null,key:string){
  if(raw===null)return null;
  for(const f of fields(decode(raw))){if(f.number!==1||f.wire!==2)continue;if(get(f.value,1)?.toString()===key){const row=get(f.value,2),value=row&&get(row,1);return value?decode(value.toString()):null;}}
  return null;
}
function updateTopic(raw:string|null,key:string,payload:Buffer|null){
  const kept=fields(decode(raw??'')).filter(f=>f.number!==1||f.wire!==2||get(f.value,1)?.toString()!==key).map(f=>f.raw);
  if(payload)kept.push(field(1,Buffer.concat([field(1,key),field(2,field(1,payload.toString('base64')))])));
  return Buffer.concat(kept).toString('base64');
}
export async function antigravityDatabasePath(){
  if(process.env.ANTIGRAVITY_USER_DATA_DIR)return join(process.env.ANTIGRAVITY_USER_DATA_DIR,'User/globalStorage/state.vscdb');
  const base=process.platform==='darwin'?join(homedir(),'Library/Application Support'):process.platform==='win32'?(process.env.APPDATA||join(homedir(),'AppData/Roaming')):(process.env.XDG_CONFIG_HOME||join(homedir(),'.config'));
  for(const name of ['Antigravity IDE','Antigravity']){const path=join(base,name,'User/globalStorage/state.vscdb');try{await lstat(path);return path;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  return join(base,'Antigravity IDE/User/globalStorage/state.vscdb');
}
export class AntigravityAccountStore implements NativeStore {
  lockPath:string;storage='本地登录数据库';
  constructor(private path:string){this.lockPath=`${path}.token-flow.lock`;}
  private async database(readOnly:boolean){
    await safePath(this.path);await safePath(`${this.path}-wal`);await safePath(`${this.path}-shm`);
    try{if(!(await lstat(this.path)).isFile())throw new Error();}catch{throw nativeConflict('未找到反重力登录数据库，请先安装并启动一次反重力。');}
    try{const db=new DatabaseSync(this.path,{readOnly});db.exec('PRAGMA busy_timeout=3000');return db;}catch{throw nativeConflict('无法打开反重力登录数据库，请退出客户端后重试。');}
  }
  private snapshot(db:DatabaseSync):NativeState{return Object.fromEntries(keys.map(key=>{const row=db.prepare('SELECT value FROM ItemTable WHERE key=?').get(key);const v=row?.value;if(v!==undefined&&typeof v!=='string')throw nativeConflict('反重力登录数据库格式不受支持。');return [key,sentinels[key]?topicValue(v as string|undefined??null,sentinels[key])?.toString('base64')??null:v??null];}));}
  async read(){const db=await this.database(true);try{return this.snapshot(db);}finally{db.close();}}
  describe(state:NativeState){const user=state[userKey]?decode(state[userKey]):null;return {email:user?get(user,7)?.toString()??null:null,model:null};}
  prepare(before:NativeState,c:NativeCredential){
    // Topic -> map entry -> Row.value (base64 protobuf), verified against the native IDE schema.
    const expiry=Buffer.concat([varint(8),varint(Math.floor(Date.parse(c.expired)/1000))]);
    const token=Buffer.concat([field(1,c.access_token),field(2,'Bearer'),field(3,c.refresh_token),field(4,expiry),...(c.id_token?[field(5,c.id_token)]:[])]);
    return {...before,[oauthKey]:this.describe(before).email===c.email&&before[oauthKey]?before[oauthKey]:token.toString('base64'),[userKey]:Buffer.concat([field(3,c.email),field(7,c.email)]).toString('base64'),[enterpriseKey]:c.project_id?field(3,c.project_id).toString('base64'):null,'antigravityOnboarding':'true'};
  }
  async write(before:NativeState,after:NativeState){
    const db=await this.database(false);let transaction=false;
    try{
      db.exec('BEGIN IMMEDIATE');transaction=true;
      if(nativeDigest(this.snapshot(db))!==nativeDigest(before))throw nativeConflict('反重力登录被其他程序修改，请刷新后重试。');
      for(const key of keys){let value=after[key];if(sentinels[key]){const row=db.prepare('SELECT value FROM ItemTable WHERE key=?').get(key);value=updateTopic(row?.value as string|undefined??null,sentinels[key],value?decode(value):null)||null;}if(value===null)db.prepare('DELETE FROM ItemTable WHERE key=?').run(key);else db.prepare('INSERT OR REPLACE INTO ItemTable (key,value) VALUES (?,?)').run(key,value);}
      db.exec('COMMIT');transaction=false;
    }catch(e){if(transaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
  }
}
