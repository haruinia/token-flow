import { afterEach,it,expect } from 'vitest';
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayKeys,gatewayKeyInput } from '../packages/core/src/gateway-keys.js';
const cleanup:string[]=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function setup(){const root=await mkdtemp(join(tmpdir(),'key-budget-'));cleanup.push(root);return {root,store:await GatewayKeys.open(root)};}
const input=(extra={})=>gatewayKeyInput.parse({name:'Test',models:['codex/model'],tokenLimit:100,...extra});
it('serializes limited-key admissions and rejects reset while a request is pending',async()=>{
 const {store}=await setup();const {key}=await store.create(input());
 const attempts=await Promise.allSettled([store.reserve(key.id,'codex/model','responses'),store.reserve(key.id,'codex/model','responses')]);
 expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(store.list()[0].pendingRequests).toBe(1);
 await expect(store.resetUsage(key.id)).rejects.toMatchObject({statusCode:409});
 const reservation=(attempts.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
 await store.settle(key.id,reservation,{inputTokens:25,outputTokens:5},false);await store.settle(key.id,reservation,{inputTokens:25,outputTokens:5},false);
 expect(store.list()[0].usedTokens).toBe(30);expect(store.list()[0].pendingRequests).toBe(0);
 await expect(store.reserve(key.id,'codex/model','responses')).resolves.toBeTypeOf('string');
});
it('restores crashed reservations as unmetered usage and blocks finite keys until explicit reset',async()=>{
 const {root,store}=await setup();const {key}=await store.create(input());await store.reserve(key.id,'codex/model','responses');
 const reopened=await GatewayKeys.open(root);expect(reopened.list()[0]).toMatchObject({pendingRequests:0,unmeteredRequests:1});
 await expect(reopened.reserve(key.id,'codex/model','responses')).rejects.toMatchObject({statusCode:429});
 const again=await GatewayKeys.open(root);expect(again.list()[0].unmeteredRequests).toBe(1);
 await again.resetUsage(key.id);await expect(again.reserve(key.id,'codex/model','responses')).resolves.toBeTypeOf('string');
});
it('counts partial usage, blocks unknown consumption, honors zero limit and supports unlimited keys',async()=>{
 const {store}=await setup();const {key}=await store.create(input());const id=await store.reserve(key.id,'codex/model','responses');
 await store.settle(key.id,id,{inputTokens:8,outputTokens:null},true);expect(store.list()[0]).toMatchObject({usedTokens:8,unmeteredRequests:1});
 await expect(store.reserve(key.id,'codex/model','responses')).rejects.toMatchObject({statusCode:429});
 await store.update(key.id,input({tokenLimit:null}));await expect(store.reserve(key.id,'codex/model','responses')).resolves.toBeTypeOf('string');
 const zero=await store.create(input({tokenLimit:0}));await expect(store.reserve(zero.key.id,'codex/model','responses')).rejects.toMatchObject({statusCode:429});
});
it('migrates old keys without resetting secrets or scopes, refuses invalid limits and protocol bypass',async()=>{
 const {root,store}=await setup();const {key,apiKey}=await store.create(input());
 const old=JSON.parse(await readFile(join(root,'gateway-keys.json'),'utf8'));for(const field of ['agents','tokenLimit','usedTokens','unmeteredRequests','pending'])delete old[0][field];
 await writeFile(join(root,'gateway-keys.json'),JSON.stringify(old));const migrated=await GatewayKeys.open(root);
 expect(migrated.authenticate(apiKey)).toMatchObject({id:key.id,tokenLimit:null,usedTokens:0,agents:['codex','claude','openai']});
 for(const tokenLimit of [-1,0.5,Infinity,1e15])expect(()=>input({tokenLimit})).toThrow();
 await migrated.update(key.id,input({agents:['claude']}));await expect(migrated.reserve(key.id,'codex/model','responses')).rejects.toMatchObject({statusCode:403});
 await expect(migrated.reserve(key.id,'other/model','messages')).rejects.toMatchObject({statusCode:403});
});
