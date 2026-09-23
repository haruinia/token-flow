import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {CLIProxyManager} from '../packages/core/src/cliproxy.js';

// Real bundled sidecar, synthetic credentials, model discovery only: no inference.
const root=await mkdtemp(join(tmpdir(),'token-flow-catalog-'));
const allocator=createServer();await new Promise<void>(r=>allocator.listen(0,'127.0.0.1',r));
const port=(allocator.address() as {port:number}).port;await new Promise<void>(r=>allocator.close(()=>r()));
const manager=new CLIProxyManager(root,resolve('sidecars/darwin-arm64/cliproxyapi'),'fixture-internal-key',port);
try{
 await mkdir(join(root,'cliproxy','auth'),{recursive:true});
 const claims={exp:4102444800,email:'fixture@example.test','https://api.openai.com/auth':{chatgpt_plan_type:'prolite',chatgpt_account_id:'fixture-account'}};
 await writeFile(join(root,'cliproxy','auth','codex-fixture.json'),JSON.stringify({type:'codex',email:'fixture@example.test',access_token:'synthetic-not-a-real-token',id_token:`e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`,expired:'2100-01-01T00:00:00Z'}),{mode:0o600});
 await manager.start();
 const end=Date.now()+15000;
 while(Date.now()<end&&!manager.snapshot().accounts.some(a=>a.models?.length))await new Promise(r=>setTimeout(r,200));
 const snapshot=manager.snapshot();
 assert.ok(snapshot.models.some(m=>m.id.startsWith('codex/')),JSON.stringify({state:snapshot.state,accounts:snapshot.accounts.map(a=>({provider:a.provider,status:a.status,models:a.models?.length})),error:snapshot.accountError}));
 const source=snapshot.accounts.find(a=>a.provider==='codex')!;
 assert.ok(manager.sourceAuth(source.id,source.models![0]));
 console.log(JSON.stringify({binary:'real sidecar',credentials:'synthetic',models:snapshot.models.length,sourceModels:source.models?.length,namespaceRegistered:true,inference:false}));
}finally{await manager.shutdown();await rm(root,{recursive:true,force:true});}
