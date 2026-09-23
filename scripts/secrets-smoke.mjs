import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
const root=await mkdtemp(join(tmpdir(),'token-flow-decrypt-'));
let app;
try {
 await mkdir(join(root,'secrets'));
 await writeFile(join(root,'secrets','cliproxy.bin'),'invalid-ciphertext');
 await writeFile(join(root,'secrets','custom.bin'),'invalid-ciphertext');
 const allocator=createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const port=allocator.address().port;await new Promise(r=>allocator.close(r));
 const bootstrap=join(root,'bootstrap.cjs');
 await writeFile(bootstrap,`const {safeStorage,dialog}=require('electron');const original=safeStorage.decryptString.bind(safeStorage);safeStorage.decryptString=data=>{if(data.toString()==='invalid-ciphertext')throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');return original(data);};dialog.showErrorBox=(title,message)=>console.error(title,message);import(${JSON.stringify(new URL('../dist/main.js',import.meta.url).href)});`);
 const packaged=process.argv.includes('--packaged');
 app=await electron.launch({args:packaged?[]:[bootstrap],...(packaged?{executablePath:resolve('release/mac-arm64/token-flow.app/Contents/MacOS/token-flow')}:{}),env:{...process.env,AGENT_DATA_ROOT:root,CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),WORKBUDDY_CONFIG_DIR:join(root,'workbuddy'),AGENT_PORT:'0',AGENT_PROXY_PORT:String(port),CLIPROXY_BINARY:resolve('tests/fixtures/fake-cliproxy.mjs')}});
 const page=await app.firstWindow();await page.locator('.a2aPage').waitFor();await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'API 总览',exact:true}).click();await page.locator('.gatewayHome').waitFor();
 const settings=await page.evaluate(()=>fetch('/api/settings').then(r=>r.json()));
 assert.ok(settings.credentialWarnings.some(w=>w.includes('密钥')));
 assert.equal(await readFile(join(root,'secrets','custom.bin'),'utf8'),'invalid-ciphertext');
 assert.ok((await readdir(join(root,'secrets'))).some(name=>name.startsWith('cliproxy.bin.unreadable-')));
 await page.locator('.credentialWarning').waitFor();
 console.log('Ciphertext failure: app opens, warning visible, original ciphertext preserved.');
} finally {await app?.close();await rm(root,{recursive:true,force:true});}
