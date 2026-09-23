import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const gatewayKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  sourceId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  agents: z.array(z.enum(['codex','claude','openai'])).max(3).default(['codex','claude','openai']).transform(ids=>[...new Set(ids)]),
  tokenLimit: z.number().int().min(0).max(1_000_000_000_000).nullable().default(null),
  models: z.array(z.string().min(3).max(300)).max(2000).transform(ids => [...new Set(ids)].sort()),
}).strict();
const storedKey = gatewayKeyInput.extend({id:z.string().uuid(), prefix:z.string(), digest:z.string().regex(/^[a-f0-9]{64}$/), createdAt:z.string(), usedTokens:z.number().nonnegative().default(0), unmeteredRequests:z.number().int().nonnegative().default(0), pending:z.array(z.string().uuid()).default([])});
type StoredKey = z.infer<typeof storedKey>;
export type GatewayKey = Omit<StoredKey, 'digest'|'pending'> & {pendingRequests:number};
const publicKey=({digest:_digest,pending,...entry}:StoredKey):GatewayKey=>({...structuredClone(entry),pendingRequests:pending.length});
const denied=(message:string,statusCode=429)=>Object.assign(new Error(message),{statusCode});
export const allowsProtocol=(agents:GatewayKey['agents'],path:string)=>path.startsWith('messages')?agents.includes('claude'):path==='chat/completions'?agents.includes('openai'):agents.includes('codex')||agents.includes('openai');
const hash = (value: string) => createHash('sha256').update(value).digest();

/** Client keys are model-scoped and stored only as hashes. They never grant desktop management access. */
export class GatewayKeys {
  private entries: StoredKey[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private path: string) {}
  static async open(root: string) {
    const store = new GatewayKeys(join(root, 'gateway-keys.json'));
    try {store.entries = z.array(storedKey).parse(JSON.parse(await readFile(store.path, 'utf8')));}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('客户端 Key 配置读取失败，请检查 gateway-keys.json；未重置已有权限。');}
    if(store.entries.some(key=>key.pending.length))await store.mutate(entries=>{for(const key of entries){key.unmeteredRequests+=key.pending.length;key.pending=[];}});
    return store;
  }
  list(): GatewayKey[] {return this.entries.map(publicKey);}
  authenticate(value: string): GatewayKey | undefined {
    if (!value || value.length > 256) return;
    const digest = hash(value);
    const entry = this.entries.find(key => key.enabled && timingSafeEqual(digest, Buffer.from(key.digest, 'hex')));
    if (entry) return publicKey(entry);
  }
  private mutate<T>(fn: (entries: StoredKey[]) => T): Promise<T> {
    const task = this.pending.then(async () => {
      const entries = structuredClone(this.entries);
      const result = fn(entries);
      await writeFile(`${this.path}.tmp`, JSON.stringify(entries, null, 2), {mode:0o600});
      await rename(`${this.path}.tmp`, this.path);
      this.entries = entries;
      return result;
    });
    this.pending = task.catch(() => undefined);
    return task;
  }
  create(input: z.infer<typeof gatewayKeyInput>) {
    return this.mutate(entries => {
      if (entries.length >= 100) throw Object.assign(new Error('最多创建 100 个客户端 Key'), {statusCode:400});
      const apiKey = `tfb_${randomBytes(32).toString('hex')}`;
      const entry:StoredKey = {...input,usedTokens:0,unmeteredRequests:0,pending:[], id:randomUUID(), prefix:apiKey.slice(0,12), digest:hash(apiKey).toString('hex'), createdAt:new Date().toISOString()};
      entries.push(entry);
      return {key:publicKey(entry), apiKey};
    });
  }
  update(id: string, input: z.infer<typeof gatewayKeyInput>) {
    return this.mutate(entries => {
      const entry = entries.find(key => key.id === id);
      if (!entry) throw Object.assign(new Error('Key 不存在'), {statusCode:404});
      Object.assign(entry, input);
      return publicKey(entry);
    });
  }
  /** Reserve before forwarding and persist in-flight requests so a restart cannot erase unreported usage. */
  reserve(id:string,model:string,path:string) {
    return this.mutate(entries=>{
      const entry=entries.find(key=>key.id===id);
      if(!entry?.enabled)throw denied('Key 已停用或删除',401);
      if(!entry.models.includes(model)||!allowsProtocol(entry.agents,path))throw denied('Key 未授权此模型或 Agent 协议',403);
      if(entry.tokenLimit!==null){
        if(entry.unmeteredRequests)throw denied('存在未结算请求，请先核对并重置用量');
        if(entry.usedTokens>=entry.tokenLimit)throw denied('此 Key 的 token 额度已耗尽');
        if(entry.pending.length)throw denied('有限额 Key 正在处理其他请求，请完成后重试');
      }
      if(entry.pending.length>=128)throw denied('此 Key 的并发请求过多');
      const reservation=randomUUID();entry.pending.push(reservation);
      return reservation;
    });
  }
  settle(id:string,reservation:string,usage:{inputTokens:number|null;outputTokens:number|null},uncertain:boolean) {
    return this.mutate(entries=>{
      const entry=entries.find(key=>key.id===id);
      if(!entry||!entry.pending.includes(reservation))return;
      entry.pending=entry.pending.filter(value=>value!==reservation);
      entry.usedTokens=Math.min(Number.MAX_SAFE_INTEGER,entry.usedTokens+Math.max(0,usage.inputTokens??0)+Math.max(0,usage.outputTokens??0));
      if(uncertain)entry.unmeteredRequests++;
    });
  }
  resetUsage(id:string) {
    return this.mutate(entries=>{
      const entry=entries.find(key=>key.id===id);if(!entry)throw denied('Key 不存在',404);
      if(entry.pending.length)throw denied('仍有在途请求，完成后才能重置用量',409);
      entry.usedTokens=0;entry.unmeteredRequests=0;return publicKey(entry);
    });
  }
  remove(id: string) {return this.mutate(entries => {
    const index = entries.findIndex(key => key.id === id);
    if (index < 0) throw Object.assign(new Error('Key 不存在'), {statusCode:404});
    entries.splice(index,1); return {ok:true};
  });}
}
